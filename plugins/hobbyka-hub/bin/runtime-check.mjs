import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { arch, homedir, platform, release } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const OFFICIAL_PLUGINS = Object.freeze([
  "hobbyka-hub",
  "hobbyka-agent-chat",
  "onec-direct-cli",
  "amo-direct-cli",
  "hobbyka-commercial-offers",
  "work-memory",
]);
export const RUNTIME_TASK_NAME = "Hobbyka Plugin Runtime Check";
const MODES = new Set(["full", "daily", "post-update"]);
const PREFIX = "[AUTO-CODEX-WIN]";
const script = fileURLToPath(import.meta.url);

const SCENARIOS = Object.freeze([
  scenario("environment.runtime.inventory", "environment", ["full", "daily", "post-update"], "Версии Windows, Node.js и Codex."),
  scenario("environment.codex.official-plugins", "environment", ["full", "daily", "post-update"], "Шесть официальных плагинов установлены из marketplace hobbyka-hub."),
  scenario("environment.network.hub", "environment", ["full", "daily", "post-update"], "Hub доступен через подтверждённый VPN-профиль."),
  scenario("environment.windows.updater-task", "environment", ["full", "daily", "post-update"], "Задача автообновления Hub зарегистрирована."),
  scenario("environment.windows.runtime-task", "environment", ["full", "daily", "post-update"], "Ежедневная runtime-проверка зарегистрирована на 06:00 МСК."),
  scenario("environment.codex.discovery", "environment", ["full", "daily", "post-update"], "Свежая read-only сессия Codex видит плагины, навыки и хуки."),

  scenario("hobbyka-hub.manifest.owned-links", "hobbyka-hub", ["full", "daily", "post-update"], "Сайт и политики Hub не ведут на другой плагин."),
  scenario("hobbyka-hub.cli.self-test", "hobbyka-hub", ["full", "daily", "post-update"], "Встроенные проверки архивов, обновления, публикации и отчётов.", ["checksum", "unsafe archive", "post-update", "preview/confirm", "publish/propose gates"]),
  scenario("hobbyka-hub.update.reconcile", "hobbyka-hub", ["full"], "Реальная проверка обновлений и reconciliation без публикации."),
  scenario("hobbyka-hub.repair.roundtrip", "hobbyka-hub", ["full"], "Repair сохраняет данные и восстанавливает managed marketplace."),

  scenario("hobbyka-agent-chat.manifest.hooks", "hobbyka-agent-chat", ["full", "daily", "post-update"], "SessionStart и PostToolUse зарегистрированы в manifest."),
  scenario("hobbyka-agent-chat.cli.version", "hobbyka-agent-chat", ["full", "daily", "post-update"], "Windows-бинарник Agent Chat запускается."),
  scenario("hobbyka-agent-chat.service.status", "hobbyka-agent-chat", ["full", "daily", "post-update"], "Identity, Inbox, router и updater доступны."),
  scenario("hobbyka-agent-chat.identity.whoami", "hobbyka-agent-chat", ["full", "post-update"], "Профиль Даниила определяется без раскрытия данных."),
  scenario("hobbyka-agent-chat.directory.test-target", "hobbyka-agent-chat", ["full", "post-update"], "Выделенная тестовая учётная запись находится однозначно."),
  scenario("hobbyka-agent-chat.lifecycle.request", "hobbyka-agent-chat", ["full", "post-update"], "Preview и confirm тестового request с последующим cancel.", ["ask", "reply", "hold", "use", "close", "cancel", "read", "search", "send", "mark-read", "upload", "download", "group", "receive", "complete", "release"]),

  scenario("onec-direct-cli.cli.self-test", "onec-direct-cli", ["full", "daily", "post-update"], "Read-only границы и парсеры 1С."),
  scenario("onec-direct-cli.config.check", "onec-direct-cli", ["full", "daily", "post-update"], "Защищённая конфигурация 1С найдена."),
  scenario("onec-direct-cli.service.health", "onec-direct-cli", ["full", "daily", "post-update"], "Живой read-only HTTP-сервис 1С отвечает."),
  scenario("onec-direct-cli.tools.list", "onec-direct-cli", ["full", "daily", "post-update"], "Разрешённый набор инструментов 1С не расширился."),
  scenario("onec-direct-cli.metadata.read", "onec-direct-cli", ["full", "post-update"], "Ограниченное чтение метаданных."),
  scenario("onec-direct-cli.query.transports", "onec-direct-cli", ["full", "post-update"], "Один запрос проходит через аргумент, файл, stdin и dry-run.", ["text", "file", "stdin", "dry-run", "write rejection"]),
  scenario("onec-direct-cli.reports.read", "onec-direct-cli", ["full", "post-update"], "Список, вариант и настройки выбранного тестового отчёта."),

  scenario("amo-direct-cli.cli.self-test", "amo-direct-cli", ["full", "daily", "post-update"], "Preview, refs, маскирование и outcome_unknown amoCRM."),
  scenario("amo-direct-cli.config.check", "amo-direct-cli", ["full", "daily", "post-update"], "Защищённая конфигурация amoCRM найдена."),
  scenario("amo-direct-cli.auth.check", "amo-direct-cli", ["full", "daily", "post-update"], "Авторизация amoCRM действительна."),
  scenario("amo-direct-cli.catalogs.read", "amo-direct-cli", ["full", "daily", "post-update"], "Поля, воронки и пользователи читаются ограниченно."),
  scenario("amo-direct-cli.fixture.read", "amo-direct-cli", ["full", "daily", "post-update"], "Тестовая сделка и связанные сущности читаются по сохранённым ID."),
  scenario("amo-direct-cli.fixture.write", "amo-direct-cli", ["full", "daily", "post-update"], "Preview и confirm только для тестового комплекта amoCRM.", ["lead update", "tag", "note", "task", "attach", "contact/company", "note/task lifecycle"]),

  scenario("hobbyka-commercial-offers.cli.self-test", "hobbyka-commercial-offers", ["full", "daily", "post-update"], "Парсеры, dry-run и ошибки КП."),
  scenario("hobbyka-commercial-offers.config.check", "hobbyka-commercial-offers", ["full", "daily", "post-update"], "Штатные адреса КП доступны."),
  scenario("hobbyka-commercial-offers.history.list", "hobbyka-commercial-offers", ["full", "daily", "post-update"], "Локальная история читается без реквизитов клиента."),
  scenario("hobbyka-commercial-offers.create.dry-run", "hobbyka-commercial-offers", ["full", "daily", "post-update"], "Тестовое КП проверяется без отправки через item, файл и stdin."),
  scenario("hobbyka-commercial-offers.create.live", "hobbyka-commercial-offers", ["full", "post-update"], "Одно постоянное тестовое КП создаётся на версию."),
  scenario("hobbyka-commercial-offers.view.live", "hobbyka-commercial-offers", ["full", "daily", "post-update"], "Сохранённое тестовое КП доступно по номеру."),

  scenario("work-memory.manifest.post-update", "work-memory", ["full", "daily", "post-update"], "Work Memory содержит setup/check и post-update hook."),
  scenario("work-memory.setup.marker", "work-memory", ["full"], "Безопасный тестовый marker создан и первая синхронизация выполнена."),
  scenario("work-memory.service.check", "work-memory", ["full", "daily", "post-update"], "Настройки, бинарник, задача и свежесть синхронизации зелёные."),
]);

function scenario(id, plugin, modes, description, covers = []) { return Object.freeze({ id, plugin, modes, description, covers }); }

/** Parse the stable public `verify` command contract. */
export function parseVerifyArgs(args) {
  const parsed = { mode: "", plugin: "", list: false, json: false };
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--list") parsed.list = true;
    else if (value === "--json") parsed.json = true;
    else if (value === "--mode" && args[index + 1]) parsed.mode = args[++index];
    else if (value.startsWith("--mode=")) parsed.mode = value.slice(7);
    else if (value === "--plugin" && args[index + 1]) parsed.plugin = args[++index];
    else if (value.startsWith("--plugin=")) parsed.plugin = value.slice(9);
    else throw new Error(`Неизвестный аргумент verify: ${value}`);
  }
  if (parsed.list) return parsed;
  if (!MODES.has(parsed.mode)) throw new Error("verify требует --mode full|daily|post-update.");
  if (parsed.plugin && !OFFICIAL_PLUGINS.includes(parsed.plugin)) throw new Error("--plugin должен быть одним из шести официальных плагинов.");
  if (parsed.mode === "post-update" && !parsed.plugin) throw new Error("post-update требует --plugin SLUG.");
  return parsed;
}

/** Return the single source-of-truth runtime scenario catalog. */
export function runtimeScenarioCatalog() { return SCENARIOS.map(({ id, plugin, modes, description, covers }) => ({ id, plugin, modes, description, covers })); }

/** Run selected runtime scenarios, persist a sanitized report, and deduplicate bug submissions. */
export async function runRuntimeVerification(args, overrides = {}) {
  const parsed = parseVerifyArgs(args);
  if (parsed.list) {
    const value = { schemaVersion: 1, plugins: OFFICIAL_PLUGINS, scenarios: runtimeScenarioCatalog() };
    console.log(parsed.json ? JSON.stringify(value) : formatCatalog(value));
    return { exitCode: 0, report: value };
  }
  const ctx = await createContext(parsed, overrides);
  const lock = await acquireRunLock(ctx.stateRoot);
  if (!lock.ok) {
    const report = await finishReport(ctx, [result("environment.runtime.single-instance", "environment", "blocked", "Другая runtime-проверка ещё выполняется.", false)]);
    printReport(report, parsed.json);
    return { exitCode: 1, report };
  }
  try {
    const outcomes = [];
    const selected = SCENARIOS.filter((item) => item.modes.includes(parsed.mode) && (!parsed.plugin || item.plugin === "environment" || item.plugin === parsed.plugin));
    for (const item of selected) outcomes.push(await executeScenario(item, ctx, outcomes));
    let report = await finishReport(ctx, outcomes);
    report = await submitNewFailures(ctx, report);
    await persistReport(ctx, report);
    printReport(report, parsed.json);
    return { exitCode: outcomes.some((item) => item.status !== "pass") ? 1 : 0, report };
  } finally { await lock.release(); }
}

async function createContext(parsed, overrides) {
  const home = overrides.home ?? homedir();
  const stateRoot = overrides.stateRoot ?? process.env.HOBBYKA_PLUGIN_CHECKS_ROOT ?? (platform() === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Hobbyka", "PluginChecks") : join(home, ".local", "state", "Hobbyka", "PluginChecks"));
  await mkdir(join(stateRoot, "runs"), { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700).catch(() => {});
  const configPath = join(stateRoot, "config.json");
  let config;
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    config = defaultConfig();
    await atomicJSON(configPath, config, 0o600);
  }
  let state;
  try { state = JSON.parse(await readFile(join(stateRoot, "state.json"), "utf8")); }
  catch { state = { schemaVersion: 1, activeFailures: {}, appliedVersions: {}, testRefs: {} }; }
  state.activeFailures ??= {};
  state.appliedVersions ??= {};
  state.testRefs ??= {};
  state.uncertainWrites ??= {};
  return {
    parsed, home, stateRoot, config, state,
    marketplaceRoot: join(home, ".codex", "hobbyka-hub-marketplace"),
    codex: process.env.HOBBYKA_CODEX_COMMAND || (platform() === "win32" ? "codex.cmd" : "codex"),
    hubURL: (process.env.HOBBYKA_HUB_URL ?? "https://10.8.1.0:8443").replace(/\/$/, ""),
    startedAt: new Date(), runId: `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`,
    spawn: overrides.spawn ?? spawnProcess,
    fetch: overrides.fetch ?? fetch,
    reportBug: overrides.reportBug,
    platform: overrides.platform ?? platform(),
    arch: overrides.arch ?? arch(),
    pluginRoots: new Map(),
  };
}

function defaultConfig() {
  return {
    schemaVersion: 1,
    liveWrites: false,
    codexDiscovery: true,
    agentChat: { testTargetQuery: "codex-vps-test", threadId: "" },
    onec: { metadataType: "Documents", metadataMask: "Заказ", reportName: "", variantKey: "", variantSource: "standard" },
    amo: { leadId: "", leadName: `${PREFIX} Runtime`, contactId: "", companyId: "", noteId: "", taskId: "" },
    commercialOffers: { itemId: "7112", quantity: 1, offerNumber: "", allowCreate: false },
    workMemory: { allowSetup: true },
  };
}

async function executeScenario(item, ctx, previous) {
  const started = Date.now();
  try {
    let outcome;
    switch (item.id) {
      case "environment.runtime.inventory": outcome = await runtimeInventory(ctx); break;
      case "environment.codex.official-plugins": outcome = await officialPlugins(ctx); break;
      case "environment.network.hub": outcome = await hubNetwork(ctx); break;
      case "environment.windows.updater-task": outcome = windowsTask(ctx, "Hobbyka Hub Auto Update"); break;
      case "environment.windows.runtime-task": outcome = windowsTask(ctx, RUNTIME_TASK_NAME); break;
      case "environment.codex.discovery": outcome = await codexDiscovery(ctx, previous); break;
      default: outcome = await pluginScenario(item, ctx, previous);
    }
    return { ...outcome, id: item.id, plugin: item.plugin, durationMs: Date.now() - started };
  } catch (error) {
    return result(item.id, item.plugin, "fail", sanitize(error.message, ctx), item.plugin !== "environment", Date.now() - started);
  }
}

async function runtimeInventory(ctx) {
  const codex = ctx.spawn(ctx.codex, ["--version"], { timeout: 20_000 });
  if (!commandSucceeded(codex)) return result("", "", "blocked", "Codex CLI не запускается.", false);
  return result("", "", "pass", "Среда определена.", false, 0, { os: `${ctx.platform} ${release()}`, arch: ctx.arch, node: process.version, codex: firstLine(codex.stdout) });
}

async function officialPlugins(ctx) {
  const listed = ctx.spawn(ctx.codex, ["plugin", "list", "--json"], { timeout: 30_000 });
  if (!commandSucceeded(listed)) return result("", "", "blocked", "Codex не вернул список плагинов.", false);
  let installed;
  try { installed = JSON.parse(listed.stdout).installed ?? []; } catch { return result("", "", "fail", "Codex вернул некорректный JSON списка плагинов.", true); }
  const versions = {};
  const missing = [];
  for (const slug of OFFICIAL_PLUGINS) {
    const found = installed.find((plugin) => plugin.installed && plugin.name === slug && plugin.marketplaceName === "hobbyka-hub");
    if (!found) missing.push(slug); else versions[slug] = found.version;
  }
  ctx.installedVersions = versions;
  return missing.length ? result("", "", "fail", `Не установлены из hobbyka-hub: ${missing.join(", ")}.`, true) : result("", "", "pass", "Все официальные плагины установлены.", false, 0, { versions });
}

async function hubNetwork(ctx) {
  try {
    const response = await ctx.fetch(`${ctx.hubURL}/api/health`, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 403) return result("", "", "blocked", "Hub не подтвердил VPN-профиль сотрудника.", false);
    if (!response.ok) return result("", "", "fail", `Hub health вернул HTTP ${response.status}.`, false);
    return result("", "", "pass", "Hub доступен через VPN.", false);
  } catch { return result("", "", "blocked", "Hub недоступен; сетевые проверки не считаются багами плагинов.", false); }
}

function windowsTask(ctx, name) {
  if (ctx.platform !== "win32") return result("", "", "blocked", "Сценарий требует Windows.", false);
  const query = ctx.spawn("schtasks.exe", ["/Query", "/TN", name, "/FO", "LIST", "/V"], { timeout: 20_000 });
  return commandSucceeded(query) ? result("", "", "pass", `Задача ${name} зарегистрирована.`, false) : result("", "", "blocked", `Задача ${name} не зарегистрирована.`, false);
}

async function codexDiscovery(ctx, previous) {
  if (!ctx.config.codexDiscovery) return result("", "", "blocked", "Codex discovery отключён в локальной конфигурации.", false);
  if (!passed(previous, "environment.codex.official-plugins")) return result("", "", "blocked", "Сначала нужен корректный список установленных плагинов.", false);
  const prompt = `Read-only discovery check. Output one compact JSON object. List the exact visible plugin slugs from ${OFFICIAL_PLUGINS.join(", ")}; list their visible skills; state whether hobbyka-agent-chat SessionStart and PostToolUse hooks are registered. Do not call any write-capable tool.`;
  const args = ["exec", "--ephemeral", "--json", "--sandbox", "read-only", "--skip-git-repo-check", prompt];
  let probe = ctx.spawn(ctx.codex, args, { timeout: 180_000 });
  if (commandSucceeded(probe) && OFFICIAL_PLUGINS.every((slug) => probe.stdout.includes(slug)) && probe.stdout.includes("SessionStart") && probe.stdout.includes("PostToolUse")) return result("", "", "pass", "Свежая сессия Codex видит плагины, навыки и хуки.", false);
  if (!commandSucceeded(probe) && isInfrastructure(probe)) return result("", "", "blocked", "Codex discovery не выполнился из-за авторизации или сети.", false);
  return result("", "", "fail", "Свежая сессия Codex не подтвердила полный набор плагинов и хуков.", true);
}

async function pluginScenario(item, ctx, previous) {
  if (!passed(previous, "environment.codex.official-plugins")) return result("", "", "blocked", "Официальный набор плагинов ещё не подтверждён.", false);
  const root = await pluginRoot(ctx, item.plugin);
  if (!root) return result("", "", "fail", `Не найден активный root ${item.plugin}.`, true);
  if (item.id === "hobbyka-hub.manifest.owned-links") return ownedHubLinks(root);
  if (item.id === "hobbyka-agent-chat.manifest.hooks") return agentChatHooks(root);
  if (item.id === "work-memory.manifest.post-update") return workMemoryManifest(root);
  if (item.id.endsWith(".cli.self-test")) return pluginSelfTest(item.plugin, root, ctx);
  if (item.id === "hobbyka-hub.update.reconcile") return hubMaintenanceOutcome(ctx, hubCommand(root, ["update", "--quiet"]), "Hub update");
  if (item.id === "hobbyka-hub.repair.roundtrip") return hubMaintenanceOutcome(ctx, hubCommand(root, ["repair"]), "Hub repair");
  if (item.id === "hobbyka-agent-chat.cli.version") return commandOutcome(ctx, pluginCommand(item.plugin, root, ["version"], ctx), { logical: "Agent Chat version" });
  if (item.id === "hobbyka-agent-chat.service.status") return remoteCommand(ctx, pluginCommand(item.plugin, root, ["status"], ctx), "Agent Chat status", previous);
  if (item.id === "hobbyka-agent-chat.identity.whoami") return remoteCommand(ctx, pluginCommand(item.plugin, root, ["whoami"], ctx), "Agent Chat whoami", previous);
  if (item.id === "hobbyka-agent-chat.directory.test-target") return agentChatTarget(ctx, root, previous);
  if (item.id === "hobbyka-agent-chat.lifecycle.request") return agentChatLifecycle(ctx, root, previous);
  if (item.id === "onec-direct-cli.config.check") return configurationCommand(ctx, pluginCommand(item.plugin, root, ["config-check"], ctx), "1C config");
  if (item.id === "onec-direct-cli.service.health") return remoteCommand(ctx, pluginCommand(item.plugin, root, ["health"], ctx), "1C health", previous, "onec-direct-cli.config.check");
  if (item.id === "onec-direct-cli.tools.list") return remoteCommand(ctx, pluginCommand(item.plugin, root, ["tools"], ctx), "1C tools", previous, "onec-direct-cli.config.check");
  if (item.id === "onec-direct-cli.metadata.read") return remoteCommand(ctx, pluginCommand(item.plugin, root, ["metadata-list", "--type", ctx.config.onec?.metadataType || "Documents", "--name-mask", ctx.config.onec?.metadataMask || "Заказ", "--max-items", "5"], ctx), "1C metadata", previous, "onec-direct-cli.config.check");
  if (item.id === "onec-direct-cli.query.transports") return onecQueryTransports(ctx, root, previous);
  if (item.id === "onec-direct-cli.reports.read") return onecReports(ctx, root, previous);
  if (item.id === "amo-direct-cli.config.check") return configurationCommand(ctx, pluginCommand(item.plugin, root, ["config-check"], ctx), "amoCRM config");
  if (item.id === "amo-direct-cli.auth.check") return remoteCommand(ctx, pluginCommand(item.plugin, root, ["auth-check"], ctx), "amoCRM auth", previous, "amo-direct-cli.config.check");
  if (item.id === "amo-direct-cli.catalogs.read") return amoCatalogs(ctx, root, previous);
  if (item.id === "amo-direct-cli.fixture.read") return amoFixtureRead(ctx, root, previous);
  if (item.id === "amo-direct-cli.fixture.write") return amoFixtureWrite(ctx, root, previous);
  if (item.id === "hobbyka-commercial-offers.config.check") return configurationCommand(ctx, pluginCommand(item.plugin, root, ["config-check", "--json"], ctx), "Offers config");
  if (item.id === "hobbyka-commercial-offers.history.list") return commandOutcome(ctx, pluginCommand(item.plugin, root, ["list", "--limit", "3", "--json"], ctx), { logical: "Offers list" });
  if (item.id === "hobbyka-commercial-offers.create.dry-run") return offersDryRun(ctx, root);
  if (item.id === "hobbyka-commercial-offers.create.live") return offersCreate(ctx, root);
  if (item.id === "hobbyka-commercial-offers.view.live") return offersView(ctx, root);
  if (item.id === "work-memory.setup.marker") return workMemorySetup(ctx, root);
  if (item.id === "work-memory.service.check") return configurationCommand(ctx, pluginCommand(item.plugin, root, ["check"], ctx), "Work Memory check");
  return result("", "", "blocked", "Для сценария нет runtime-исполнителя.", false);
}

async function pluginRoot(ctx, slug) {
  if (ctx.pluginRoots.has(slug)) return ctx.pluginRoots.get(slug);
  try {
    const marketplace = JSON.parse(await readFile(join(ctx.marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
    const source = marketplace.plugins?.find((plugin) => plugin.name === slug)?.source?.path;
    const base = resolve(ctx.marketplaceRoot);
    const root = typeof source === "string" ? resolve(base, source) : "";
    if (!pathIsInside(base, root)) return "";
    await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8");
    ctx.pluginRoots.set(slug, root);
    return root;
  } catch { return ""; }
}

export function pathIsInside(base, candidate, separator = sep) {
  return candidate === base || candidate.startsWith(`${base}${separator}`);
}

async function ownedHubLinks(root) {
  const manifest = JSON.parse(await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"));
  const expected = ["/plugins/hobbyka-hub", "/hobbyka-hub/PRIVACY.md", "/hobbyka-hub/TERMS.md"];
  const actual = [manifest.interface?.websiteURL, manifest.interface?.privacyPolicyURL, manifest.interface?.termsOfServiceURL];
  return expected.every((suffix, index) => actual[index]?.includes(suffix)) && actual.every((url) => !url.includes("hobbyka-agent-chat")) ? result("", "", "pass", "Manifest Hub ссылается на собственные страницы.", false) : result("", "", "fail", "Manifest Hub содержит ссылки другого плагина.", true);
}

async function agentChatHooks(root) {
  try {
    const hooks = JSON.parse(await readFile(join(root, "hooks", "hooks.json"), "utf8"));
    const text = JSON.stringify(hooks);
    return text.includes("SessionStart") && text.includes("PostToolUse") ? result("", "", "pass", "Оба hook зарегистрированы.", false) : result("", "", "fail", "Не зарегистрированы SessionStart и PostToolUse.", true);
  } catch { return result("", "", "fail", "Не удалось прочитать hooks.json Agent Chat.", true); }
}

async function workMemoryManifest(root) {
  const required = [join(root, ".codex-plugin", "post-update.mjs"), join(root, "scripts", "work-memory.ps1")];
  try { for (const path of required) await stat(path); return result("", "", "pass", "Work Memory содержит post-update и Windows launcher.", false); }
  catch { return result("", "", "fail", "Work Memory не содержит post-update или Windows launcher.", true); }
}

function pluginSelfTest(slug, root, ctx) {
  const args = slug === "hobbyka-hub" ? hubCommand(root, ["self-test"]) : pluginCommand(slug, root, ["self-test", ...(slug === "hobbyka-commercial-offers" ? ["--json"] : [])], ctx);
  return commandOutcome(ctx, args, { logical: `${slug} self-test` });
}

function configurationCommand(ctx, command, logical) { return commandOutcome(ctx, command, { logical, blockedOnFailure: true }); }

function remoteCommand(ctx, command, logical, previous, dependency = "environment.network.hub") {
  if (dependency && !passed(previous, dependency)) return result("", "", "blocked", `${logical}: не выполнена зависимость ${dependency}.`, false);
  return commandOutcome(ctx, command, { logical, blockedWhenInfrastructure: true });
}

function agentChatTarget(ctx, root, previous) {
  if (!passed(previous, "environment.network.hub")) return result("", "", "blocked", "Agent Chat target не проверяется без Hub/VPN.", false);
  const query = ctx.config.agentChat?.testTargetQuery;
  if (!query) return result("", "", "blocked", "В config.json не указан agentChat.testTargetQuery.", false);
  const command = pluginCommand("hobbyka-agent-chat", root, ["find", "colleague", query], ctx);
  const executed = runCommand(ctx, command, { timeout: 60_000 });
  const parsed = parseJSONOutput(executed.stdout);
  const refs = parsed?.refs?.filter((ref) => ref.type === "user" || String(ref.ref ?? "").startsWith("user:")) ?? [];
  if (!commandSucceeded(executed) || refs.length !== 1) return result("", "", isInfrastructure(executed) ? "blocked" : "fail", "Тестовый адресат Agent Chat не найден однозначно.", !isInfrastructure(executed));
  ctx.testTargetRef = refs[0].ref ?? `user:${refs[0].id}`;
  return result("", "", "pass", "Выделенный тестовый адресат найден.", false);
}

async function agentChatLifecycle(ctx, root, previous) {
  if (!ctx.config.liveWrites) return result("", "", "blocked", "Живые тестовые записи отключены в config.json.", false);
  if (!passed(previous, "hobbyka-agent-chat.directory.test-target")) return result("", "", "blocked", "Нет однозначного тестового адресата.", false);
  const threadId = ctx.config.agentChat?.threadId;
  if (!/^[0-9a-f-]{36}$/i.test(threadId ?? "")) return result("", "", "blocked", "Нужен agentChat.threadId тестовой Codex-задачи.", false);
  const version = ctx.installedVersions?.["hobbyka-agent-chat"] ?? "unknown";
  if (ctx.state.appliedVersions["hobbyka-agent-chat"] === version) return result("", "", "pass", `Живой request уже проверен для версии ${version}.`, false);
  const env = { ...process.env, CODEX_THREAD_ID: threadId };
  const body = `${PREFIX} runtime request for hobbyka-agent-chat ${version}`;
  const asked = confirmedWrite(ctx,
    pluginCommand("hobbyka-agent-chat", root, ["ask", ctx.testTargetRef, "--stdin"], ctx),
    pluginCommand("hobbyka-agent-chat", root, ["ask", ctx.testTargetRef, "--stdin", "--confirm"], ctx),
    { logical: "Agent Chat ask", key: `agent-chat:ask:${version}`, input: body, env, timeout: 60_000 });
  if (!asked.ok) return asked.outcome;
  const requestRef = asked.json?.refs?.find((ref) => ref.type === "request" || String(ref.ref ?? "").startsWith("request:"))?.ref;
  if (!requestRef) return result("", "", "fail", "Agent Chat не вернул request ref.", true);
  const cancelled = confirmedWrite(ctx,
    pluginCommand("hobbyka-agent-chat", root, ["cancel", requestRef], ctx),
    pluginCommand("hobbyka-agent-chat", root, ["cancel", requestRef, "--confirm"], ctx),
    { logical: "Agent Chat cancel", key: `agent-chat:cancel:${requestRef}`, env, timeout: 60_000 });
  if (!cancelled.ok) return cancelled.outcome;
  ctx.state.appliedVersions["hobbyka-agent-chat"] = version;
  return result("", "", "pass", `Тестовый request создан и отменён для версии ${version}.`, false);
}

async function onecQueryTransports(ctx, root, previous) {
  if (!passed(previous, "onec-direct-cli.config.check")) return result("", "", "blocked", "Нет конфигурации 1С.", false);
  const query = "ВЫБРАТЬ 1 КАК Проверка";
  const fixture = join(ctx.stateRoot, "onec-runtime.q1c");
  await writeFile(fixture, query, { mode: 0o600 });
  const commands = [
    pluginCommand("onec-direct-cli", root, ["query", "--text", query, "--max-rows", "1"], ctx),
    pluginCommand("onec-direct-cli", root, ["query", "--file", fixture, "--max-rows", "1"], ctx),
    pluginCommand("onec-direct-cli", root, ["query", "--stdin", "--max-rows", "1"], ctx),
    pluginCommand("onec-direct-cli", root, ["query", "--file", fixture, "--max-rows", "1", "--dry-run"], ctx),
  ];
  for (let index = 0; index < commands.length; index++) {
    const executed = runCommand(ctx, commands[index], { input: index === 2 ? query : undefined, timeout: 90_000 });
    if (!commandSucceeded(executed)) return commandResult(executed, "1C query transport", true);
  }
  const rejected = runCommand(ctx, pluginCommand("onec-direct-cli", root, ["query", "--text", "УДАЛИТЬ ИЗ Справочник.Номенклатура", "--dry-run"], ctx), { timeout: 30_000 });
  if (commandSucceeded(rejected)) return result("", "", "fail", "1C CLI принял команду записи.", true);
  return result("", "", "pass", "Все transport-варианты чтения работают, запись отклонена.", false);
}

function onecReports(ctx, root, previous) {
  if (!passed(previous, "onec-direct-cli.config.check")) return result("", "", "blocked", "Нет конфигурации 1С.", false);
  const reportName = ctx.config.onec?.reportName;
  const variantKey = ctx.config.onec?.variantKey;
  if (!reportName || !variantKey) return result("", "", "blocked", "Для живого варианта нужны onec.reportName и onec.variantKey.", false);
  const source = ctx.config.onec?.variantSource || "standard";
  const commands = [
    pluginCommand("onec-direct-cli", root, ["reports-list", "--name-mask", reportName, "--max-reports", "5"], ctx),
    pluginCommand("onec-direct-cli", root, ["report-variant", "--report-name", reportName, "--variant-key", variantKey, "--variant-source", source], ctx),
    pluginCommand("onec-direct-cli", root, ["report-settings-list", "--report-name", reportName, "--variant-key", variantKey], ctx),
  ];
  for (const command of commands) { const executed = runCommand(ctx, command, { timeout: 90_000 }); if (!commandSucceeded(executed)) return commandResult(executed, "1C report", true); }
  return result("", "", "pass", "Тестовый отчёт, вариант и настройки прочитаны.", false);
}

function amoCatalogs(ctx, root, previous) {
  if (!passed(previous, "amo-direct-cli.auth.check")) return result("", "", "blocked", "amoCRM не авторизована.", false);
  const commands = [
    pluginCommand("amo-direct-cli", root, ["fields", "--entity", "leads", "--limit", "5"], ctx),
    pluginCommand("amo-direct-cli", root, ["pipelines"], ctx),
    pluginCommand("amo-direct-cli", root, ["users", "--limit", "5"], ctx),
  ];
  for (const command of commands) { const executed = runCommand(ctx, command, { timeout: 90_000 }); if (!commandSucceeded(executed)) return commandResult(executed, "amoCRM catalog", true); }
  return result("", "", "pass", "Каталоги amoCRM доступны.", false);
}

function amoFixtureRead(ctx, root, previous) {
  if (!passed(previous, "amo-direct-cli.auth.check")) return result("", "", "blocked", "amoCRM не авторизована.", false);
  const leadId = String(ctx.config.amo?.leadId ?? "");
  if (!/^\d+$/.test(leadId)) return result("", "", "blocked", "В config.json нет amo.leadId тестовой сделки.", false);
  return commandOutcome(ctx, pluginCommand("amo-direct-cli", root, ["lead", "get", "--id", leadId], ctx), { logical: "amoCRM test lead", blockedWhenInfrastructure: true });
}

function amoFixtureWrite(ctx, root, previous) {
  if (!ctx.config.liveWrites) return result("", "", "blocked", "Живые тестовые записи отключены в config.json.", false);
  if (!passed(previous, "amo-direct-cli.fixture.read")) return result("", "", "blocked", "Тестовая сделка amoCRM не подтверждена.", false);
  const leadId = String(ctx.config.amo.leadId);
  const leadName = String(ctx.config.amo.leadName ?? "");
  if (!leadName.startsWith(PREFIX)) return result("", "", "blocked", `amo.leadName должен начинаться с ${PREFIX}.`, false);
  const version = ctx.installedVersions?.["amo-direct-cli"] ?? "unknown";
  const lead = amoWrite(ctx, root, ["lead", "update", "--id", leadId, "--data-json", JSON.stringify({ name: leadName })], `amo:lead:${leadId}:${ctx.parsed.mode === "daily" ? "daily" : version}`, "amoCRM lead update");
  if (!lead.ok) return lead.outcome;
  if (ctx.parsed.mode === "daily") return result("", "", "pass", "Ежедневная идемпотентная запись прежнего имени сделки подтверждена.", false);
  if (ctx.state.appliedVersions["amo-direct-cli"] === version) return result("", "", "pass", `Полный тестовый цикл amoCRM уже выполнен для версии ${version}.`, false);

  const refs = ctx.state.testRefs.amo ??= {};
  const contact = amoCreateParty(ctx, root, "contact", `${PREFIX} Contact ${version}`, version);
  if (!contact.ok) return contact.outcome;
  refs.contactId = contact.id;
  const company = amoCreateParty(ctx, root, "company", `${PREFIX} Company ${version}`, version);
  if (!company.ok) return company.outcome;
  refs.companyId = company.id;

  const operations = [
    ["lead tag", ["lead", "tag", "--id", leadId, "--name", PREFIX]],
    ["attach contact", ["lead", "attach", "--id", leadId, "--contact-id", String(refs.contactId), "--main-contact"]],
    ["attach company", ["lead", "attach", "--id", leadId, "--company-id", String(refs.companyId)]],
    ["contact update", ["contact", "update", "--id", String(refs.contactId), "--data-json", JSON.stringify({ name: `${PREFIX} Contact ${version}` })]],
    ["company update", ["company", "update", "--id", String(refs.companyId), "--data-json", JSON.stringify({ name: `${PREFIX} Company ${version}` })]],
  ];
  for (const [logical, args] of operations) {
    const written = amoWrite(ctx, root, args, `amo:${logical}:${version}`, `amoCRM ${logical}`);
    if (!written.ok) return written.outcome;
  }

  const note = amoWrite(ctx, root, ["lead", "note", "--id", leadId, "--text", `${PREFIX} Note ${version}`], `amo:note:${version}`, "amoCRM note create");
  if (!note.ok) return note.outcome;
  refs.noteId = amoRef(note.json, "note");
  if (!refs.noteId) return result("", "", "fail", "amoCRM не вернула ID тестового примечания.", true);
  const noteUpdate = amoWrite(ctx, root, ["note", "update", "--lead-id", leadId, "--id", String(refs.noteId), "--text", `${PREFIX} Note ${version}`], `amo:note-update:${version}`, "amoCRM note update");
  if (!noteUpdate.ok) return noteUpdate.outcome;

  const completeTill = String(Math.floor(Date.now() / 1000) + 86_400);
  const task = amoWrite(ctx, root, ["lead", "task", "--id", leadId, "--text", `${PREFIX} Task ${version}`, "--complete-till", completeTill], `amo:task:${version}`, "amoCRM task create");
  if (!task.ok) return task.outcome;
  refs.taskId = amoRef(task.json, "task");
  if (!refs.taskId) return result("", "", "fail", "amoCRM не вернула ID тестовой задачи.", true);
  const taskUpdate = amoWrite(ctx, root, ["task", "update", "--id", String(refs.taskId), "--data-json", JSON.stringify({ text: `${PREFIX} Task ${version}`, complete_till: Number(completeTill) })], `amo:task-update:${version}`, "amoCRM task update");
  if (!taskUpdate.ok) return taskUpdate.outcome;
  const taskComplete = amoWrite(ctx, root, ["task", "complete", "--id", String(refs.taskId), "--result-text", `${PREFIX} Done ${version}`], `amo:task-complete:${version}`, "amoCRM task complete");
  if (!taskComplete.ok) return taskComplete.outcome;

  const reads = [
    pluginCommand("amo-direct-cli", root, ["contact", "get", "--id", String(refs.contactId)], ctx),
    pluginCommand("amo-direct-cli", root, ["company", "get", "--id", String(refs.companyId)], ctx),
    pluginCommand("amo-direct-cli", root, ["note", "get", "--lead-id", leadId, "--id", String(refs.noteId)], ctx),
    pluginCommand("amo-direct-cli", root, ["task", "get", "--id", String(refs.taskId)], ctx),
  ];
  for (const command of reads) { const read = runCommand(ctx, command, { timeout: 90_000 }); if (!commandSucceeded(read)) return commandResult(read, "amoCRM fixture readback", true); }
  ctx.state.appliedVersions["amo-direct-cli"] = version;
  return result("", "", "pass", `Полный тестовый цикл amoCRM подтверждён для версии ${version}.`, false);
}

function amoCreateParty(ctx, root, kind, name, version) {
  const written = amoWrite(ctx, root, [kind, "create", "--data-json", JSON.stringify({ name })], `amo:${kind}:${version}`, `amoCRM ${kind} create`);
  if (!written.ok) return written;
  const id = amoRef(written.json, kind);
  return id ? { ...written, id } : { ok: false, outcome: result("", "", "fail", `amoCRM не вернула ID ${kind}.`, true) };
}

function amoWrite(ctx, root, args, key, logical) {
  return confirmedWrite(ctx,
    pluginCommand("amo-direct-cli", root, args, ctx),
    pluginCommand("amo-direct-cli", root, [...args, "--yes"], ctx),
    { logical, key, timeout: 90_000 });
}

function amoRef(json, kind) { return json?.refs?.find((ref) => ref.kind === kind)?.id ?? null; }

function offersPayload(ctx) {
  return {
    basket_items: [{ ID: String(ctx.config.commercialOffers?.itemId ?? ""), QUANTITY: Number(ctx.config.commercialOffers?.quantity ?? 1) }],
    props: { COMPANY: `${PREFIX} Test`, PERSON: "Runtime Check", PHONE: "+7 000 000-00-00", EMAIL: "runtime-check@example.invalid", OBJECT: `${PREFIX} Plugin runtime` },
    copy_number: null,
  };
}

async function offersDryRun(ctx, root) {
  const payload = offersPayload(ctx);
  if (!/^\d+$/.test(payload.basket_items[0].ID) || payload.basket_items[0].QUANTITY < 1) return result("", "", "blocked", "Нужны commercialOffers.itemId и положительное quantity.", false);
  const file = join(ctx.stateRoot, "offer-runtime.json");
  await atomicJSON(file, payload, 0o600);
  const commands = [
    { command: pluginCommand("hobbyka-commercial-offers", root, ["create", "--item", `${payload.basket_items[0].ID}:${payload.basket_items[0].QUANTITY}`, "--company", payload.props.COMPANY, "--person", payload.props.PERSON, "--phone", payload.props.PHONE, "--email", payload.props.EMAIL, "--object", payload.props.OBJECT, "--dry-run", "--json"], ctx) },
    { command: pluginCommand("hobbyka-commercial-offers", root, ["create", "--input", file, "--dry-run", "--json"], ctx) },
    { command: pluginCommand("hobbyka-commercial-offers", root, ["create", "--stdin", "--dry-run", "--json"], ctx), input: JSON.stringify(payload) },
  ];
  for (const item of commands) { const executed = runCommand(ctx, item.command, { input: item.input, timeout: 90_000 }); if (!commandSucceeded(executed)) return commandResult(executed, "Offers dry-run", true); }
  return result("", "", "pass", "Все формы ввода КП прошли dry-run.", false);
}

function offersCreate(ctx, root) {
  if (!ctx.config.liveWrites || !ctx.config.commercialOffers?.allowCreate) return result("", "", "blocked", "Создание постоянного тестового КП отключено.", false);
  const version = ctx.installedVersions?.["hobbyka-commercial-offers"] ?? "unknown";
  if (ctx.state.appliedVersions["hobbyka-commercial-offers"] === version && ctx.state.testRefs.offerNumber) return result("", "", "pass", `КП уже создано для версии ${version}.`, false);
  const payload = offersPayload(ctx);
  const created = confirmedWrite(ctx,
    pluginCommand("hobbyka-commercial-offers", root, ["create", "--stdin", "--dry-run", "--json"], ctx),
    pluginCommand("hobbyka-commercial-offers", root, ["create", "--stdin", "--yes", "--json"], ctx),
    { logical: "Offers create", key: `offers:create:${version}`, input: JSON.stringify(payload), timeout: 180_000 });
  if (!created.ok) return created.outcome;
  const parsed = created.json;
  const number = parsed?.result?.number ?? parsed?.result?.offer_number;
  if (!number) return result("", "", "fail", "API КП не вернул номер тестового предложения.", true);
  ctx.state.appliedVersions["hobbyka-commercial-offers"] = version;
  ctx.state.testRefs.offerNumber = String(number);
  return result("", "", "pass", `Тестовое КП создано для версии ${version}.`, false);
}

function offersView(ctx, root) {
  const number = ctx.state.testRefs.offerNumber || ctx.config.commercialOffers?.offerNumber;
  if (!number) return result("", "", "blocked", "Нет номера тестового КП.", false);
  return commandOutcome(ctx, pluginCommand("hobbyka-commercial-offers", root, ["view", String(number), "--check", "--json"], ctx), { logical: "Offers view", blockedWhenInfrastructure: true });
}

async function workMemorySetup(ctx, root) {
  if (!ctx.config.liveWrites || !ctx.config.workMemory?.allowSetup) return result("", "", "blocked", "Work Memory setup отключён в config.json.", false);
  const resources = join(ctx.home, ".codex", "memories", "extensions", "work", "resources");
  await mkdir(resources, { recursive: true, mode: 0o700 });
  await writeFile(join(resources, "auto-codex-win.md"), `# ${PREFIX} Runtime marker\n\nБезопасный маркер проверки Work Memory на Windows.\n`, { mode: 0o600 });
  return commandOutcome(ctx, pluginCommand("work-memory", root, ["setup"], ctx), { logical: "Work Memory setup", blockedWhenInfrastructure: true });
}

function hubCommand(root, args) { return { executable: process.execPath, args: [join(root, "bin", "hobbyka-hub.mjs"), ...args] }; }

function pluginCommand(slug, root, args, ctx) {
  if (slug === "hobbyka-agent-chat") return ctx.platform === "win32" ? { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "hchat.ps1"), ...args] } : { executable: "sh", args: [join(root, "scripts", "hchat"), ...args] };
  if (slug === "onec-direct-cli") return { executable: process.execPath, args: [join(root, "skills", "onec-cli-agent", "scripts", "onec-cli.mjs"), ...args] };
  if (slug === "amo-direct-cli") return { executable: process.execPath, args: [join(root, "skills", "amocrm-cli-agent", "scripts", "amocrm-cli.mjs"), ...args] };
  if (slug === "hobbyka-commercial-offers") return { executable: process.execPath, args: [join(root, "skills", "manage-commercial-offers", "scripts", "hobbyka-commercial-offers.mjs"), ...args] };
  if (slug === "work-memory") return ctx.platform === "win32" ? { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "work-memory.ps1"), ...args] } : { executable: join(root, "scripts", "work-memory"), args };
  throw new Error(`Нет CLI-контракта для ${slug}.`);
}

/** Execute one preview/confirm pair and permanently stop automatic retries after an uncertain outcome. */
export function confirmedWrite(ctx, previewCommand, confirmCommand, { logical, key, input, env, timeout }) {
  if (ctx.state.uncertainWrites[key]) return { ok: false, outcome: result("", "", "blocked", `${logical}: предыдущий результат outcome_unknown требует ручной проверки.`, false) };
  const options = { input, env, timeout };
  const preview = runCommand(ctx, previewCommand, options);
  if (!commandSucceeded(preview)) return { ok: false, outcome: commandResult(preview, `${logical} preview`, true) };
  const confirmed = runCommand(ctx, confirmCommand, options);
  const json = parseJSONOutput(confirmed.stdout);
  if (json?.status === "outcome_unknown") {
    ctx.state.uncertainWrites[key] = { at: new Date().toISOString(), logical };
    return { ok: false, outcome: result("", "", "blocked", `${logical}: outcome_unknown, автоматический повтор запрещён.`, false) };
  }
  if (!commandSucceeded(confirmed)) return { ok: false, outcome: commandResult(confirmed, `${logical} confirm`, true) };
  return { ok: true, json };
}

function commandOutcome(ctx, command, options) { return commandResult(runCommand(ctx, command, { timeout: options.timeout ?? 120_000 }), options.logical, options.blockedOnFailure || options.blockedWhenInfrastructure); }

function hubMaintenanceOutcome(ctx, command, logical) {
  const executed = runCommand(ctx, command, { timeout: 10 * 60_000, env: { ...process.env, HOBBYKA_VERIFY_ACTIVE: "1" } });
  return commandResult(executed, logical, true);
}

function commandResult(executed, logical, mayBlock = false) {
  if (commandSucceeded(executed)) return result("", "", "pass", `${logical}: ok.`, false, 0, { exitCode: executed.status, durationMs: executed.durationMs });
  const infrastructure = isInfrastructure(executed);
  return result("", "", mayBlock && infrastructure ? "blocked" : mayBlock && /config|auth|credential|настро|авториз/i.test(combinedOutput(executed)) ? "blocked" : "fail", `${logical}: ${failureSummary(executed)}.`, !(mayBlock && (infrastructure || /config|auth|credential|настро|авториз/i.test(combinedOutput(executed)))));
}

function runCommand(ctx, command, options = {}) { return ctx.spawn(command.executable, command.args, options); }

function spawnProcess(executable, args, options = {}) {
  const started = Date.now();
  const base = { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: options.timeout ?? 120_000, input: options.input, env: options.env ?? process.env, windowsHide: true };
  let spawned;
  if (platform() === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    if ([executable, ...args].some((value) => /[\r\n"&|<>^%!]/.test(String(value)))) return { status: null, error: new Error("Небезопасный аргумент Windows."), stdout: "", stderr: "", durationMs: Date.now() - started };
    const command = [executable, ...args].map((value) => `"${value}"`).join(" ");
    spawned = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], { ...base, windowsVerbatimArguments: true });
  } else spawned = spawnSync(executable, args, base);
  return { status: spawned.status, error: spawned.error, stdout: spawned.stdout ?? "", stderr: spawned.stderr ?? "", durationMs: Date.now() - started };
}

function commandSucceeded(executed) {
  if (executed.error || executed.status !== 0) return false;
  const parsed = parseJSONOutput(executed.stdout);
  return parsed?.status !== "failed" && parsed?.status !== "outcome_unknown" && parsed?.ok !== false;
}

function parseJSONOutput(output) {
  const lines = String(output ?? "").trim().split(/\r?\n/).reverse();
  for (const line of lines) { try { return JSON.parse(line); } catch { /* keep looking */ } }
  return null;
}

function isInfrastructure(executed) { return /ECONN|ENET|ETIMEDOUT|timeout|timed out|недоступ|сеть|network|VPN|login required|not logged in/i.test(combinedOutput(executed)) || executed.error?.code === "ETIMEDOUT"; }
function combinedOutput(executed) { return `${executed.error?.message ?? ""}\n${executed.stderr ?? ""}\n${executed.stdout ?? ""}`; }
function failureSummary(executed) { return executed.error?.code === "ETIMEDOUT" ? "тайм-аут" : executed.error ? sanitize(executed.error.message) : `код ${executed.status}`; }
function firstLine(value) { return String(value ?? "").trim().split(/\r?\n/)[0].slice(0, 200); }
function passed(outcomes, id) { return outcomes.find((item) => item.id === id)?.status === "pass"; }

function result(id, plugin, status, summary, reportable = false, durationMs = 0, evidence = {}) { return { id, plugin, status, summary, reportable, durationMs, evidence }; }

async function finishReport(ctx, scenarios) {
  const finishedAt = new Date();
  const report = {
    schemaVersion: 1,
    runId: ctx.runId,
    mode: ctx.parsed.mode,
    plugin: ctx.parsed.plugin || null,
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - ctx.startedAt,
    runner: { commit: process.env.HOBBYKA_VERIFY_COMMIT || "unreleased", source: "bin/runtime-check.mjs" },
    host: { platform: ctx.platform, arch: ctx.arch, release: release(), node: process.version },
    plugins: ctx.installedVersions ?? {},
    scenarios,
    reports: [],
  };
  await persistReport(ctx, report);
  return report;
}

async function persistReport(ctx, report) {
  const path = join(ctx.stateRoot, "runs", `${ctx.runId}.json`);
  await atomicJSON(path, report, 0o600);
  await atomicJSON(join(ctx.stateRoot, "latest.json"), report, 0o600);
  ctx.state.lastRunAt = report.finishedAt;
  await atomicJSON(join(ctx.stateRoot, "state.json"), ctx.state, 0o600);
  ctx.reportPath = path;
}

async function submitNewFailures(ctx, report) {
  for (const outcome of report.scenarios) {
    if (outcome.status === "pass") { delete ctx.state.activeFailures[outcome.id]; continue; }
    if (outcome.status !== "fail" || !outcome.reportable) continue;
    const version = report.plugins[outcome.plugin] ?? "unknown";
    const fingerprint = failureFingerprint(outcome, version);
    const active = ctx.state.activeFailures[outcome.id];
    if (active?.fingerprint === fingerprint && ["ok", "outcome_unknown"].includes(active.reportStatus)) continue;
    const submitted = ctx.reportBug ? await ctx.reportBug({ outcome, report, fingerprint, reportPath: ctx.reportPath }) : await reportBugThroughHub(ctx, outcome, report, fingerprint);
    ctx.state.activeFailures[outcome.id] = { fingerprint, reportStatus: submitted.status, bugId: submitted.bugId ?? null, operationId: submitted.operationId ?? null, updatedAt: new Date().toISOString() };
    report.reports.push({ scenarioId: outcome.id, fingerprint, ...submitted });
  }
  return report;
}

function failureFingerprint(outcome, version) { return createHash("sha256").update(JSON.stringify({ plugin: outcome.plugin, version, scenario: outcome.id, error: normalizeFailure(outcome.summary) })).digest("hex"); }
function normalizeFailure(value) { return String(value).toLowerCase().replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "UUID").replace(/\d{4}-\d{2}-\d{2}t[^\s]+/gi, "TIME").replace(/\s+/g, " ").trim(); }

async function reportBugThroughHub(ctx, outcome, report, fingerprint) {
  const hubRoot = await pluginRoot(ctx, "hobbyka-hub");
  if (!hubRoot) return { status: "failed", message: "Hub CLI missing" };
  const bodyPath = join(ctx.stateRoot, `bug-${fingerprint.slice(0, 12)}.md`);
  const body = `## Где\n${outcome.plugin}, scenario ${outcome.id}\n\n## Что произошло\n${sanitize(outcome.summary, ctx)}\n\n## Что ожидалось\nRuntime-сценарий завершается со статусом pass.\n\n## Как повторить\nЗапустить hobbyka-hub verify --mode ${report.mode}${report.plugin ? ` --plugin ${report.plugin}` : ""}.\n\n## Среда\n${report.host.platform} ${report.host.arch}; plugin ${report.plugins[outcome.plugin] ?? "unknown"}; run ${report.runId}.\n\n## Доказательства\nПриложен очищенный JSON-отчёт; fingerprint ${fingerprint}.\n`;
  await writeFile(bodyPath, body, { mode: 0o600 });
  const baseArgs = [join(hubRoot, "bin", "hobbyka-hub.mjs"), "report-bug", "--body-file", bodyPath, "--file", ctx.reportPath];
  const preview = ctx.spawn(process.execPath, baseArgs, { timeout: 180_000 });
  const previewJSON = parseJSONOutput(preview.stdout);
  const operation = previewJSON?.effects?.operation_id ?? previewJSON?.refs?.find((ref) => ref.type === "operation")?.id;
  if (!commandSucceeded(preview) || !operation) { await rm(bodyPath, { force: true }); return { status: "failed", message: "preview failed" }; }
  const confirmed = ctx.spawn(process.execPath, [...baseArgs, "--operation", operation, "--confirm"], { timeout: 12 * 60_000 });
  await rm(bodyPath, { force: true });
  const confirmedJSON = parseJSONOutput(confirmed.stdout);
  if (confirmedJSON?.status === "outcome_unknown") return { status: "outcome_unknown", operationId: operation };
  const bugId = confirmedJSON?.result?.id;
  return commandSucceeded(confirmed) && bugId ? { status: "ok", bugId, operationId: operation } : { status: "failed", operationId: operation };
}

function sanitize(value, ctx = {}) {
  let text = String(value ?? "");
  if (ctx.home) text = text.replaceAll(ctx.home, "%USERPROFILE%");
  text = text
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[REDACTED_TOKEN]")
    .replace(/(authorization|password|token|secret|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 2000);
}

async function acquireRunLock(root) {
  const path = join(root, "runtime-check.lock");
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.close();
    return { ok: true, release: () => rm(path, { force: true }) };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try { const metadata = await stat(path); if (Date.now() - metadata.mtimeMs > 35 * 60_000) { await rm(path, { force: true }); return acquireRunLock(root); } } catch { /* next run will retry */ }
    return { ok: false };
  }
}

async function atomicJSON(path, value, mode) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, path);
  await chmod(path, mode).catch(() => {});
}

function printReport(report, json) {
  if (json) console.log(JSON.stringify(report));
  else {
    const counts = Object.fromEntries(["pass", "fail", "blocked"].map((status) => [status, report.scenarios.filter((item) => item.status === status).length]));
    console.log(`Hobbyka runtime check: pass=${counts.pass} fail=${counts.fail} blocked=${counts.blocked}`);
    for (const item of report.scenarios.filter((scenario) => scenario.status !== "pass")) console.log(`${item.status.toUpperCase()} ${item.id}: ${item.summary}`);
  }
}

function formatCatalog(value) { return value.scenarios.map((item) => `${item.id}\t${item.modes.join(",")}\t${item.description}`).join("\n"); }

/** Build the hidden VBS launcher installed beside the stable Hub updater. */
export function windowsVerifyLauncher(node, hubScript, codex) {
  const escape = (value) => String(value).replaceAll('"', '""');
  const command = escape(`"${node}" "${hubScript}" verify --mode daily --json`);
  return `Set shell = CreateObject("Wscript.Shell")\r\nshell.Environment("Process")("HOBBYKA_CODEX_COMMAND") = "${escape(codex)}"\r\nshell.Run "${command}", 0, False\r\n`;
}

/** Build a least-privilege daily Windows task fixed to 06:00 Moscow time. */
export function windowsRuntimeTaskXML(sid, launcher, now = new Date()) {
  const boundary = nextMoscowBoundary(now);
  const escapedLauncher = xml(launcher);
  return `<?xml version="1.0" encoding="UTF-8"?>\r\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Daily runtime check of official Hobbyka Codex plugins.</Description></RegistrationInfo><Triggers><CalendarTrigger><StartBoundary>${boundary}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT30M</ExecutionTimeLimit><Priority>7</Priority></Settings><Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"${escapedLauncher}"</Arguments></Exec></Actions></Task>\r\n`;
}

function nextMoscowBoundary(now) {
  const moscow = new Date(now.getTime() + 3 * 60 * 60_000);
  const date = new Date(Date.UTC(moscow.getUTCFullYear(), moscow.getUTCMonth(), moscow.getUTCDate()));
  if (moscow.getUTCHours() >= 6) date.setUTCDate(date.getUTCDate() + 1);
  return `${date.toISOString().slice(0, 10)}T06:00:00+03:00`;
}

function xml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
