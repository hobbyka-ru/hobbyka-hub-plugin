#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
if (!process.env.NODE_EXTRA_CA_CERTS && !process.env.HOBBYKA_HUB_CA_READY) {
  const result = spawnSync(process.execPath, [...process.execArgv, script, ...process.argv.slice(2)], { env: { ...process.env, NODE_EXTRA_CA_CERTS: join(dirname(script), "..", "assets", "hobbyka-chat-root.crt"), HOBBYKA_HUB_CA_READY: "1" }, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const [command, ...args] = process.argv.slice(2);
const base = (process.env.HOBBYKA_HUB_URL ?? "https://10.8.1.0:8443").replace(/\/$/, "");
const publicHub = "https://github.com/hobbyka-ru/hobbyka-hub-plugin";
if (command === "install") await install(args[0]);
else if (command === "publish") await publish(args[0]);
else if (command === "propose") await propose(args[0], args.includes("--submit"), args.find((arg, index) => index > 0 && !arg.startsWith("--")));
else if (command === "update") await update(args.includes("--quiet"));
else if (command === "autoupdate" && args[0] === "enable") await enableAutoupdate();
else if (command === "autoupdate" && args[0] === "disable") await disableAutoupdate();
else if (command === "self-test") await selfTest();
else fail("Использование:\n  hobbyka-hub install <slug>\n  hobbyka-hub publish <папка-плагина>\n  hobbyka-hub propose <slug> [папка]\n  hobbyka-hub propose <папка> --submit\n  hobbyka-hub update\n  hobbyka-hub autoupdate enable|disable");

async function install(slug, { update = false, quiet = false } = {}) {
  if (!/^[a-z0-9-]+$/.test(slug ?? "")) fail("Некорректный slug плагина.");
  const response = await hubFetch(`${base}/api/plugins/${slug}/download?source=${update ? "update" : "agent"}&target=${platformTarget()}`, undefined, quiet);
  if (!response) return;
  if (!response.ok) fail(await response.text());

  const codexRoot = join(homedir(), ".codex", "hobbyka-hub-marketplace");
  const pluginRoot = join(codexRoot, "plugins", slug);
  const temp = await mkdtemp(join(tmpdir(), "hobbyka-hub-"));
  try {
    const archive = join(temp, `${slug}.zip`);
    await saveVerified(response, archive);
    const entries = listArchive(archive).trim().split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some((entry) => !isSafeEntry(entry))) fail("В архиве найден небезопасный путь.");
    await rm(pluginRoot, { recursive: true, force: true });
    await mkdir(pluginRoot, { recursive: true });
    extractArchive(archive, pluginRoot);
    await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8");
    await writeMarketplace(codexRoot);
    const configured = JSON.parse(capture(codexCommand(), ["plugin", "marketplace", "list", "--json"]));
    if (!configured.marketplaces?.some((marketplace) => marketplace.name === "hobbyka-hub")) run(codexCommand(), ["plugin", "marketplace", "add", codexRoot]);
    run(codexCommand(), ["plugin", "add", `${slug}@hobbyka-hub`]);
    if (slug === "hobbyka-hub") await copyUpdater(pluginRoot);
    await runPostUpdateHook(pluginRoot);
    const downloadId = response.headers.get("x-hobbyka-download-id");
    if (!downloadId) fail("Hub не вернул идентификатор загрузки.");
    const confirmation = await hubFetch(`${base}/api/downloads/${downloadId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ installed: true }) }, quiet);
    if (!confirmation) return;
    if (!confirmation.ok) fail(`Плагин установлен, но Hub не подтвердил регистрацию: ${await confirmation.text()}`);
    if (!update) await enableAutoupdate(true);
    if (!quiet) console.log(`Плагин ${slug} ${update ? "обновлён" : "установлен"} и подтверждён в Hub.`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function update(quiet = false) {
  await updatePublicHub(quiet);
  let response;
  response = await hubFetch(`${base}/api/plugins`, undefined, quiet);
  if (!response) return;
  if (!response.ok) { if (quiet) return; fail(await response.text()); }
  const remote = (await response.json()).plugins;
  let allInstalled = JSON.parse(capture(codexCommand(), ["plugin", "list", "--json"])).installed;
  for (const slug of legacySlugs(allInstalled, remote)) {
    await install(slug, { update: true, quiet });
    run(codexCommand(), ["plugin", "remove", `${slug}@hobbyka`]);
  }
  allInstalled = JSON.parse(capture(codexCommand(), ["plugin", "list", "--json"])).installed;
  if (!allInstalled.some((plugin) => plugin.installed && plugin.marketplaceName === "hobbyka")) {
    const marketplaces = JSON.parse(capture(codexCommand(), ["plugin", "marketplace", "list", "--json"])).marketplaces;
    if (marketplaces.some((marketplace) => marketplace.name === "hobbyka")) run(codexCommand(), ["plugin", "marketplace", "remove", "hobbyka"]);
  }
  const installed = allInstalled
    .filter((plugin) => plugin.installed && plugin.marketplaceName === "hobbyka-hub")
    .map((plugin) => ({ slug: plugin.name, version: plugin.version }));
  const pending = installed.filter((local) => remote.some((plugin) => plugin.slug === local.slug && plugin.version !== local.version)).sort((left, right) => left.slug === "hobbyka-hub" ? 1 : right.slug === "hobbyka-hub" ? -1 : left.slug.localeCompare(right.slug));
  for (const plugin of pending) await install(plugin.slug, { update: true, quiet });
  for (const plugin of installed.filter((local) => !pending.some((plugin) => plugin.slug === local.slug))) await runPostUpdateHook(join(homedir(), ".codex", "hobbyka-hub-marketplace", "plugins", plugin.slug));
  if (!quiet) console.log(pending.length ? `Обновлено плагинов: ${pending.length}.` : "Установленные плагины из ХАБа уже актуальны.");
}

async function updatePublicHub(quiet) {
  const pluginRoot = join(homedir(), ".codex", "hobbyka-hub-marketplace", "plugins", "hobbyka-hub");
  const cacheBuster = Date.now();
  let latest;
  try { latest = await (await fetch(`${publicHub.replace("github.com", "raw.githubusercontent.com")}/main/plugins/hobbyka-hub/.codex-plugin/plugin.json?t=${cacheBuster}`, { cache: "no-store" })).json(); } catch { return false; }
  const current = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  if (latest.version === current.version) return false;
  const response = await fetch(`${publicHub}/archive/refs/heads/main.zip?t=${cacheBuster}`, { cache: "no-store" });
  if (!response.ok) { if (!quiet) fail("Не удалось скачать обновление Hobbyka Hub."); return false; }
  const temp = await mkdtemp(join(tmpdir(), "hobbyka-hub-self-update-"));
  try {
    const archive = join(temp, "hobbyka-hub.zip");
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const entries = listArchive(archive).trim().split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some((entry) => !isSafeEntry(entry))) fail("В обновлении Hobbyka Hub найден небезопасный путь.");
    extractArchive(archive, temp);
    const source = join(temp, entries[0].split(/[\\/]/)[0], "plugins", "hobbyka-hub");
    await readFile(join(source, ".codex-plugin", "plugin.json"), "utf8");
    await rm(pluginRoot, { recursive: true, force: true });
    await cp(source, pluginRoot, { recursive: true });
    await writeMarketplace(dirname(dirname(pluginRoot)));
    run(codexCommand(), ["plugin", "add", "hobbyka-hub@hobbyka-hub"]);
    await enableAutoupdate(true, pluginRoot);
    if (!quiet) console.log(`Hobbyka Hub обновлён до ${latest.version}.`);
    return true;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function propose(value, submit, destination) {
  if (submit) return submitProposal(resolve(value ?? ""));
  const slug = value;
  if (!/^[a-z0-9-]+$/.test(slug ?? "")) fail("Некорректный slug плагина.");
  const target = resolve(destination ?? `${slug}-proposal`);
  try { await access(target); fail(`Папка уже существует: ${target}`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const response = await hubFetch(`${base}/api/plugins/${slug}/download?source=propose`);
  if (!response.ok) fail(await response.text());
  const baseCommit = response.headers.get("x-hobbyka-github-commit");
  if (!baseCommit) fail("Hub не вернул версию исходников.");
  const temp = await mkdtemp(join(tmpdir(), "hobbyka-hub-propose-"));
  try {
    const archive = join(temp, `${slug}.zip`);
    await saveVerified(response, archive);
    const entries = listArchive(archive).trim().split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some((entry) => !isSafeEntry(entry))) fail("В архиве найден небезопасный путь.");
    await mkdir(target, { recursive: false });
    extractArchive(archive, target);
    await writeFile(join(target, ".hobbyka-proposal.json"), JSON.stringify({ slug, baseCommit }, null, 2));
    console.log(`Исходники ${slug} подготовлены: ${target}\nПосле изменений: hobbyka-hub propose "${target}" --submit`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function submitProposal(root) {
  const marker = JSON.parse(await readFile(join(root, ".hobbyka-proposal.json"), "utf8"));
  if (!/^[a-z0-9-]+$/.test(marker.slug ?? "") || !/^[0-9a-f]{40}$/.test(marker.baseCommit ?? "")) fail("В папке нет корректного предложения ХАБа.");
  const temp = await mkdtemp(join(tmpdir(), "hobbyka-hub-proposal-"));
  try {
    const archive = join(temp, `${marker.slug}.zip`);
    createArchive(root, archive);
    const form = new FormData();
    form.set("baseCommit", marker.baseCommit);
    form.set("archive", new File([await readFile(archive)], basename(archive), { type: "application/zip" }));
    const response = await hubFetch(`${base}/api/plugins/${marker.slug}/proposals`, { method: "POST", body: form });
    if (!response.ok) fail(await response.text());
    const result = await response.json();
    if (result.sync === "conflict") console.log(`PR создан: ${result.url}\nСвежий релиз изменил те же места. GitHub сохранил предложение и отметил конфликт для разбора агентом.`);
    else if (result.sync === "pending") console.log(`PR создан: ${result.url}\nХАБ не подтвердил подтягивание свежего релиза. Не отправляйте предложение повторно — проверьте этот PR.`);
    else console.log(`PR создан: ${result.url}${result.sync === "updating" ? "\nGitHub переносит изменения на свежий релиз." : ""}`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function publish(directory) {
  const root = resolve(directory ?? "");
  const manifest = JSON.parse(await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"));
  if (!manifest.name || !manifest.version || !manifest.description) fail("В plugin.json нужны name, version и description.");
  const temp = await mkdtemp(join(tmpdir(), "hobbyka-hub-publish-"));
  try {
    const archive = join(temp, `${manifest.name}.zip`);
    createArchive(root, archive);
    const form = new FormData();
    form.set("name", manifest.interface?.displayName ?? manifest.name);
    form.set("slug", manifest.name);
    form.set("version", manifest.version);
    form.set("summary", manifest.interface?.shortDescription ?? manifest.description);
    form.set("description", manifest.interface?.longDescription ?? manifest.description);
    form.set("tags", manifest.interface?.category ?? "Productivity");
    form.set("archive", new File([await readFile(archive)], basename(archive), { type: "application/zip" }));
    const response = await hubFetch(`${base}/api/plugins`, { method: "POST", body: form });
    if (!response.ok) fail(await response.text());
    console.log(`Плагин ${manifest.name} v${manifest.version} опубликован в Hub.`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function enableAutoupdate(quiet = false, sourceRoot = dirname(dirname(script))) {
  const stableScript = await copyUpdater(sourceRoot);
  const codex = resolveCodexCommand();
  if (platform() === "darwin") {
    const plist = join(homedir(), "Library", "LaunchAgents", "ru.hobbyka.hub-updater.plist");
    await mkdir(dirname(plist), { recursive: true });
    await writeFile(plist, macPlist(process.execPath, stableScript, codex));
    const domain = `gui/${process.getuid()}`;
    run("launchctl", ["bootout", domain, plist], undefined, true);
    run("launchctl", ["bootstrap", domain, plist]);
  } else if (platform() === "win32") {
    const launcher = join(dirname(stableScript), "update-hidden.vbs");
    await writeFile(launcher, windowsLauncher(process.execPath, stableScript, codex));
    run("schtasks.exe", ["/Create", "/F", "/TN", "Hobbyka Hub Auto Update", "/SC", "MINUTE", "/MO", "15", "/TR", `wscript.exe "${launcher}"`]);
  } else fail("Автообновление поддерживается на macOS и Windows.");
  if (!quiet) console.log("Автообновление фирменных плагинов включено.");
}

async function disableAutoupdate() {
  if (platform() === "darwin") {
    const plist = join(homedir(), "Library", "LaunchAgents", "ru.hobbyka.hub-updater.plist");
    run("launchctl", ["bootout", `gui/${process.getuid()}`, plist], undefined, true);
    await rm(plist, { force: true });
  } else if (platform() === "win32") run("schtasks.exe", ["/Delete", "/F", "/TN", "Hobbyka Hub Auto Update"], undefined, true);
  else fail("Автообновление поддерживается на macOS и Windows.");
  console.log("Автообновление выключено.");
}

async function copyUpdater(pluginRoot) {
  const root = join(homedir(), ".codex", "hobbyka-hub-updater");
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "assets"), { recursive: true });
  await copyFile(join(pluginRoot, "bin", "hobbyka-hub.mjs"), join(root, "bin", "hobbyka-hub.mjs"));
  await copyFile(join(pluginRoot, "assets", "hobbyka-chat-root.crt"), join(root, "assets", "hobbyka-chat-root.crt"));
  await chmod(join(root, "bin", "hobbyka-hub.mjs"), 0o755);
  return join(root, "bin", "hobbyka-hub.mjs");
}

async function writeMarketplace(codexRoot) {
  const names = [];
  for (const name of await directories(join(codexRoot, "plugins"))) {
    try { await access(join(codexRoot, "plugins", name, ".codex-plugin", "plugin.json")); names.push(name); } catch { /* skip */ }
  }
  await mkdir(join(codexRoot, ".agents", "plugins"), { recursive: true });
  await writeFile(join(codexRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "hobbyka-hub", plugins: names.sort().map((name) => ({ name, source: { source: "local", path: `./plugins/${name}` }, policy: { installation: "AVAILABLE" } })) }, null, 2));
}

async function directories(root) { try { return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; } }
async function saveVerified(response, destination) {
  const expected = response.headers.get("x-hobbyka-sha256");
  if (!expected || !response.body) fail("Hub не вернул контрольную сумму архива.");
  const hash = createHash("sha256");
  const verify = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(destination));
  if (hash.digest("hex") !== expected) fail("Контрольная сумма архива не совпала.");
}
async function runPostUpdateHook(pluginRoot, ...args) {
  const hook = join(pluginRoot, ".codex-plugin", "post-update.mjs");
  try { await access(hook); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  run(process.execPath, [hook, ...args], pluginRoot);
  return true;
}
function legacySlugs(installed, remote) { const available = new Set(remote.map((plugin) => plugin.slug)); return installed.filter((plugin) => plugin.installed && plugin.marketplaceName === "hobbyka" && available.has(plugin.name)).map((plugin) => plugin.name).sort(); }
function listArchive(archive) { return platform() !== "win32" ? capture("unzip", ["-Z1", archive]) : capture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($args[0]); try {$z.Entries | ForEach-Object {$_.FullName}} finally {$z.Dispose()}", archive]); }
function extractArchive(archive, target) { if (platform() !== "win32") return run("unzip", ["-q", archive, "-d", target]); run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force", archive, target]); }
function createArchive(root, archive) { if (platform() !== "win32") return run("zip", ["-qr", archive, ".", "-x", "*.DS_Store", ".git/*", "node_modules/*", ".hobbyka-proposal.json"], root); run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$items=Get-ChildItem -LiteralPath $args[0] -Force | Where-Object {$_.Name -notin @('.git','node_modules','.DS_Store','.hobbyka-proposal.json')}; Compress-Archive -Path $items.FullName -DestinationPath $args[1] -Force", root, archive]); }
function isSafeEntry(entry) { const path = entry.replaceAll("\\", "/"); return !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !path.includes("\0") && !path.split("/").includes(".."); }
function codexCommand() { return process.env.HOBBYKA_CODEX_COMMAND || (platform() === "win32" ? "codex.cmd" : "codex"); }
function platformTarget(os = platform(), cpu = arch()) { return `${os === "win32" ? "windows" : os}-${cpu === "x64" ? "amd64" : cpu}`; }
function resolveCodexCommand() { const command = codexCommand(); if (command.includes("/") || command.includes("\\")) return command; const result = spawnSync(platform() === "win32" ? "where.exe" : "which", [command], { encoding: "utf8" }); if (result.status !== 0) fail("Не найден исполняемый файл Codex."); return result.stdout.trim().split(/\r?\n/)[0]; }
function xml(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function macPlist(node, updater, codex) { return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>ru.hobbyka.hub-updater</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(updater)}</string><string>update</string><string>--quiet</string></array><key>EnvironmentVariables</key><dict><key>HOBBYKA_CODEX_COMMAND</key><string>${xml(codex)}</string></dict><key>StartInterval</key><integer>900</integer><key>RunAtLoad</key><true/></dict></plist>\n`; }
function windowsLauncher(node, updater, codex) { const escape = (value) => value.replaceAll('"', '""'); const command = escape(`"${node}" "${updater}" update --quiet`); return `Set shell = CreateObject("Wscript.Shell")\r\nshell.Environment("Process")("HOBBYKA_CODEX_COMMAND") = "${escape(codex)}"\r\nshell.Run "${command}", 0, False\r\n`; }
function run(executable, args, cwd, allowFailure = false) { const result = spawnSync(executable, args, { cwd, stdio: allowFailure ? "ignore" : "inherit" }); if (!allowFailure && result.error) fail(result.error.message); if (!allowFailure && result.status !== 0) fail(`${executable} завершился с кодом ${result.status}.`); }
function capture(executable, args) { const result = spawnSync(executable, args, { encoding: "utf8" }); if (result.error) fail(result.error.message); if (result.status !== 0) fail(result.stderr || `${executable} завершился с кодом ${result.status}.`); return result.stdout; }
async function hubFetch(url, options, quiet = false) { let response; try { response = await fetch(url, options); } catch { if (quiet) return null; fail("ХАБ недоступен. Подключите VPN-профиль Хоббики и повторите."); } const error = identityError(response.status, response.ok ? "" : await response.clone().text()); if (error) { if (quiet) return null; fail(error); } return response; }
function identityError(status, body) { if (status === 403) return "ХАБ не определил сотрудника. Подключите VPN-профиль Хоббики и повторите."; if (status === 502 && body.includes("Agent Chat не подтвердил профиль сотрудника")) return "VPN подключён, но Agent Chat не подтвердил профиль сотрудника."; return ""; }
async function selfTest() {
  if (!install.toString().includes("platformTarget()") || !install.toString().includes("&target=")) throw new Error("platform-targeted install failed");
  if (!macPlist("/path/node", "/path/updater", "/path/codex").includes("<integer>900</integer>") || !macPlist("/path/node", "/path/updater", "/path/codex").includes("HOBBYKA_CODEX_COMMAND</key><string>/path/codex")) throw new Error("macOS schedule failed");
  if (!windowsLauncher("C:\\Node\\node.exe", "C:\\Hub\\update.mjs", "C:\\Codex\\codex.exe").includes("HOBBYKA_CODEX_COMMAND") || !windowsLauncher("C:\\Node\\node.exe", "C:\\Hub\\update.mjs", "C:\\Codex\\codex.exe").includes("update --quiet")) throw new Error("Windows schedule failed");
  if (!isSafeEntry("skills/example/SKILL.md") || !isSafeEntry("skills\\example\\SKILL.md") || isSafeEntry("../secret") || isSafeEntry("..\\secret") || isSafeEntry("/secret") || isSafeEntry("\\secret") || isSafeEntry("C:/secret") || isSafeEntry("C:\\secret")) throw new Error("archive path check failed");
  if (!createArchive.toString().includes(".hobbyka-proposal.json")) throw new Error("proposal marker exclusion failed");
  if (legacySlugs([{ name: "known", installed: true, marketplaceName: "hobbyka" }, { name: "missing", installed: true, marketplaceName: "hobbyka" }], [{ slug: "known" }]).join() !== "known") throw new Error("legacy migration selection failed");
  if (!identityError(403, "").includes("VPN-профиль Хоббики") || !identityError(502, "Agent Chat не подтвердил профиль сотрудника").includes("Agent Chat")) throw new Error("VPN identity errors failed");
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-hook-test-"));
  try {
    const payload = Buffer.from("streamed archive");
    const archive = join(fixture, "archive.zip");
    await saveVerified(new Response(payload, { headers: { "x-hobbyka-sha256": createHash("sha256").update(payload).digest("hex") } }), archive);
    if (await readFile(archive, "utf8") !== payload.toString()) throw new Error("streamed download failed");
    await mkdir(join(fixture, ".codex-plugin"));
    await writeFile(join(fixture, ".codex-plugin", "post-update.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'ok');\n");
    const marker = join(fixture, "ran");
    await runPostUpdateHook(fixture, marker);
    if (await readFile(marker, "utf8") !== "ok") throw new Error("post-update hook failed");
  } finally { await rm(fixture, { recursive: true, force: true }); }
  console.log("hobbyka-hub self-test: ok");
}
function fail(message) { console.error(message); process.exit(1); }
