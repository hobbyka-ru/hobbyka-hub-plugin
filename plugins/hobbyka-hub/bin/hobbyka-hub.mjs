#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, cp, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { arch, homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { atomicCopyFile, atomicWriteFile, withMarketplaceLock } from "./marketplace-state.mjs";

const SECRET_FILE_EXTENSIONS = /\.(?:key|p12|pfx)$/i;
function isSecretFileName(name) {
  const lower = name.toLowerCase();
  if (lower === ".env") return true;
  if (lower.startsWith(".env.")) return ![".env.example", ".env.sample", ".env.template"].includes(lower);
  return lower.startsWith("id_") || SECRET_FILE_EXTENSIONS.test(lower);
}
function isPluginSlug(value) { return /^[a-z0-9-]+$/.test(value ?? ""); }
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
async function readArchiveForUpload(archive) {
  const metadata = await stat(archive);
  if (metadata.size > MAX_ARCHIVE_BYTES) throw new Error("Размер архива плагина не должен превышать 256 МБ.");
  return readFile(archive);
}
function parsePublishArgs(args) {
  if (args.length !== 1 || !args[0] || args[0].startsWith("-")) fail("publish принимает ровно один путь к папке плагина.");
  return args[0];
}

const script = fileURLToPath(import.meta.url);
if (!process.env.NODE_EXTRA_CA_CERTS && !process.env.HOBBYKA_HUB_CA_READY) {
  const result = spawnSync(process.execPath, [...process.execArgv, script, ...process.argv.slice(2)], { env: { ...process.env, NODE_EXTRA_CA_CERTS: join(dirname(script), "..", "assets", "hobbyka-chat-root.crt"), HOBBYKA_HUB_CA_READY: "1" }, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const [command, ...args] = process.argv.slice(2);
const base = (process.env.HOBBYKA_HUB_URL ?? "https://10.8.1.0:8443").replace(/\/$/, "");
const agentChat = (process.env.HOBBYKA_AGENT_CHAT_URL ?? "https://172.29.172.1").replace(/\/$/, "");
const publicHub = "https://github.com/hobbyka-ru/hobbyka-hub-plugin";
const publicHubAPI = "https://api.github.com/repos/hobbyka-ru/hobbyka-hub-plugin";
const marketplaceRoot = join(homedir(), ".codex", "hobbyka-hub-marketplace");
const legacyRemovalPrefix = ".hobbyka-hub-legacy-removal-";
const reportPreviewRoot = join(tmpdir(), "hobbyka-hub-report-previews");
const reportPreviewMaxAgeMs = 24 * 60 * 60 * 1000;
if (command === "report-bug") await submitReport(args, "bug");
else if (command === "idea") await submitReport(args, "idea");
else if (command === "install") await withMarketplaceLock(marketplaceRoot, () => installAndReconcile(args[0]));
else if (command === "publish") await publish(parsePublishArgs(args));
else if (command === "propose") await propose(args[0], args.includes("--submit"), args.find((arg, index) => index > 0 && !arg.startsWith("--")));
else if (command === "update") await withMarketplaceLock(marketplaceRoot, () => update(args.includes("--quiet")));
else if (command === "repair") await withMarketplaceLock(marketplaceRoot, () => repair());
else if (command === "autoupdate" && args[0] === "enable") await withMarketplaceLock(marketplaceRoot, () => enableAutoupdate());
else if (command === "autoupdate" && args[0] === "disable") await withMarketplaceLock(marketplaceRoot, () => disableAutoupdate());
else if (command === "self-test") await selfTest();
else fail("Использование:\n  hobbyka-hub report-bug (--stdin | --body-file PATH) [--file PATH] [--operation UUID] [--confirm]\n  hobbyka-hub idea (--stdin | --body-file PATH) [--file PATH] [--operation UUID] [--confirm]\n  hobbyka-hub install <slug>\n  hobbyka-hub publish <папка-плагина>\n  hobbyka-hub propose <slug> [папка]\n  hobbyka-hub propose <папка> --submit\n  hobbyka-hub update\n  hobbyka-hub repair\n  hobbyka-hub autoupdate enable|disable");

async function submitReport(args, kind) {
  const parsed = parseReportArgs(args);
  if (!parsed.ok) return jsonFailure("failed", "invalid_arguments", parsed.error, 2);
  let body = "";
  try {
    if (parsed.bodyFile) {
      const metadata = await stat(parsed.bodyFile);
      if (!metadata.isFile() || metadata.size > 32768) return jsonFailure("failed", "invalid_report", "Нужен UTF-8-файл до 32 КБ.", 2);
      body = await readFile(parsed.bodyFile, "utf8");
    } else {
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) {
        body += chunk;
        if (Buffer.byteLength(body) > 32768) return jsonFailure("failed", "invalid_report", "Нужен текст до 32 КБ.", 2);
      }
    }
    body = body.trim();
  } catch (error) { return jsonFailure("failed", "invalid_body", error.message, 2); }
  if (!body || Buffer.byteLength(body) > 32768) return jsonFailure("failed", "invalid_report", "Нужен текст до 32 КБ.", 2);
  const files = [];
  for (const path of parsed.files) {
    let metadata;
    try { metadata = await stat(path); } catch (error) { return jsonFailure("failed", "invalid_file", `${path}: ${error.message}`, 2); }
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 100 * 1024 * 1024) return jsonFailure("failed", "invalid_file", `${path}: нужен файл до 100 МБ.`, 2);
    files.push({ path: resolve(path), name: basename(path), size_bytes: metadata.size });
  }
  const body_sha256 = createHash("sha256").update(body).digest("hex");
  const generatedOperation = reportOperationID(kind, body_sha256, files);
  const previewDetails = reportPreviewDetails(kind, body_sha256, files);
  let operation = generatedOperation;
  let storedPreview = false;
  if (parsed.operation && parsed.operation !== generatedOperation) {
    operation = parsed.operation;
    if (parsed.confirm) {
      const savedPreview = await readReportPreview(operation);
      if (!sameReportPreview(savedPreview, previewDetails)) return jsonFailure("failed", "invalid_operation", "Показанный --operation не соответствует содержимому отчёта. Повторите preview и подтвердите тот же текст и файлы.", 2);
      storedPreview = true;
    }
  }
  const uploadOperations = files.map((_, index) => derivedOperationID(operation, index));
  const refs = [{ type: "operation", id: operation, ref: `operation:${operation}` }, ...uploadOperations.map((id) => ({ type: "operation", id, ref: `operation:${id}` }))];
  const details = { body_sha256, body_bytes: Buffer.byteLength(body), files: files.map((file, index) => ({ name: file.name, size_bytes: file.size_bytes, operation_id: uploadOperations[index] })), operation_id: operation };
  const action = reportAction(kind);
  if (!parsed.confirm) {
    if (parsed.operation && parsed.operation !== generatedOperation) {
      try { await saveReportPreview(operation, previewDetails); }
      catch (error) { return jsonFailure("failed", "preview_state", error.message, 2); }
    }
    return printJSON({ status: "ok", refs, provenance: localProvenance(), effects: { state: "planned", action, server: agentChat, required_flags: ["--confirm", `--operation ${operation}`], ...details } }, 0);
  }
  if (!parsed.operation) return jsonFailure("failed", "operation_required", "После preview повторите команду с показанным --operation UUID и --confirm.", 2, refs);

  const signal = AbortSignal.timeout(10 * 60_000);
  const attachmentIDs = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const form = new FormData();
    form.set("file", new File([await readFile(file.path)], file.name));
    let response;
    try { response = await fetch(`${agentChat}/agent/v1/attachments`, { method: "POST", headers: { "X-Hobbyka-Operation-ID": uploadOperations[index] }, body: form, signal }); }
    catch (error) { return jsonFailure("outcome_unknown", "outcome_unknown", error.message, 5, refs); }
    if (!response.ok) return jsonFailure("failed", "rejected", await response.text(), 4, refs);
    let attachment;
    try { attachment = await response.json(); }
    catch (error) { return jsonFailure("outcome_unknown", "outcome_unknown", error.message, 5, refs); }
    const attachmentID = normalizeUUID(attachment?.id);
    if (!attachmentID) return jsonFailure("failed", "invalid_response", "Agent Chat не вернул UUID вложения.", 6, refs);
    attachmentIDs.push(attachmentID);
  }
  let response;
  const targetThreadID = validUUID(process.env.CODEX_THREAD_ID) ? process.env.CODEX_THREAD_ID : undefined;
  try { response = await fetch(`${agentChat}/agent/v1/bug-reports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, body, attachment_ids: attachmentIDs, target_thread_id: targetThreadID, operation_id: operation }), signal }); }
  catch (error) { return jsonFailure("outcome_unknown", "outcome_unknown", error.message, 5, refs); }
  if (!response.ok) return jsonFailure("failed", "rejected", await response.text(), 4, refs);
  let report;
  try { report = await response.json(); }
  catch (error) { return jsonFailure("outcome_unknown", "outcome_unknown", error.message, 5, refs); }
  if (!validReport(report, kind)) return jsonFailure("failed", "invalid_response", "Agent Chat не вернул запись ожидаемого типа.", 6, refs);
  const reportID = normalizeUUID(report.id);
  report = { ...report, id: reportID };
  if (storedPreview) await rm(reportPreviewPath(operation), { force: true }).catch(() => {});
  return printJSON({ status: "ok", result: report, refs: [reportRef(kind, report.id), ...refs], provenance: { source: "remote", freshness: new Date().toISOString() }, effects: { state: "applied", action, ...details } }, 0);
}

function parseReportArgs(args) {
  const result = { ok: true, files: [], operation: "", confirm: false, stdin: false, bodyFile: "" };
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--stdin") result.stdin = true;
    else if (value === "--body-file" && args[index + 1]) result.bodyFile = args[++index];
    else if (value.startsWith("--body-file=")) result.bodyFile = value.slice(12);
    else if (value === "--confirm") result.confirm = true;
    else if (value === "--file" && args[index + 1]) result.files.push(args[++index]);
    else if (value.startsWith("--file=")) result.files.push(value.slice(7));
    else if (value === "--operation" && args[index + 1]) result.operation = args[++index];
    else if (value.startsWith("--operation=")) result.operation = value.slice(12);
    else return { ok: false, error: `Неизвестный аргумент: ${value}` };
  }
  if (result.stdin === Boolean(result.bodyFile)) return { ok: false, error: "Нужен ровно один источник текста: --stdin или --body-file PATH." };
  if (result.files.length > 5) return { ok: false, error: "Можно приложить не больше 5 файлов." };
  if (result.operation) {
    const operation = normalizeUUID(result.operation);
    if (!operation) return { ok: false, error: "--operation должен быть UUID." };
    result.operation = operation;
  }
  return result;
}

function hashUUID(input) {
  const value = createHash("sha256").update(input).digest().subarray(0, 16);
  value[6] = (value[6] & 0x0f) | 0x50;
  value[8] = (value[8] & 0x3f) | 0x80;
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function derivedOperationID(operation, index) {
  const canonicalOperation = normalizeUUID(operation);
  if (!canonicalOperation) throw new Error("operation must be a UUID");
  return hashUUID(`${canonicalOperation}:attachment:${index}`);
}
function reportOperationID(kind, body_sha256, files) { return hashUUID(JSON.stringify({ kind, body_sha256, files: files.map(({ name, size_bytes }) => ({ name, size_bytes })) })); }

function normalizeUUID(value) {
  // google/uuid.Parse accepts every canonical 36-character hex UUID, including v7/v8, nil, and any variant.
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return "";
  return value.toLowerCase();
}
function validUUID(value) { return Boolean(normalizeUUID(value)); }
function reportPreviewPath(operation) {
  const canonicalOperation = normalizeUUID(operation);
  if (!canonicalOperation) throw new Error("operation must be a canonical UUID");
  const path = join(reportPreviewRoot, `${canonicalOperation}.json`);
  if (dirname(path) !== reportPreviewRoot) throw new Error("invalid report preview path");
  return path;
}
function reportPreviewDetails(kind, body_sha256, files) { return { kind, body_sha256, files: files.map(({ name, size_bytes }) => ({ name, size_bytes })) }; }
function validReportPreview(value) {
  return value !== null && typeof value === "object" && (value.kind === "bug" || value.kind === "idea") && /^[0-9a-f]{64}$/.test(value.body_sha256 ?? "") && Number.isSafeInteger(value.created_at) && Array.isArray(value.files) && value.files.length <= 5 && value.files.every((file) => file !== null && typeof file === "object" && typeof file.name === "string" && file.name === basename(file.name) && file.name.length > 0 && file.name.length <= 255 && Number.isSafeInteger(file.size_bytes) && file.size_bytes >= 1 && file.size_bytes <= 100 * 1024 * 1024);
}
function sameReportPreview(saved, expected) { return validReportPreview(saved) && saved.kind === expected.kind && saved.body_sha256 === expected.body_sha256 && JSON.stringify(saved.files) === JSON.stringify(expected.files); }
async function saveReportPreview(operation, details) {
  const path = reportPreviewPath(operation);
  await mkdir(reportPreviewRoot, { recursive: true, mode: 0o700 });
  await chmod(reportPreviewRoot, 0o700);
  await atomicPrivateWriteFile(path, JSON.stringify({ ...details, created_at: Date.now() }));
}
async function atomicPrivateWriteFile(path, data) {
  const directory = dirname(path);
  const temporaryDirectory = await mkdtemp(join(directory, `.${basename(path)}-`));
  const temporaryPath = join(temporaryDirectory, basename(path));
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
async function readReportPreview(operation) {
  const path = reportPreviewPath(operation);
  let metadata;
  try { metadata = await stat(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  const now = Date.now();
  if (now - metadata.mtimeMs > reportPreviewMaxAgeMs) { await rm(path, { force: true }).catch(() => {}); return null; }
  let saved;
  try { saved = JSON.parse(await readFile(path, "utf8")); } catch { await rm(path, { force: true }).catch(() => {}); return null; }
  if (!validReportPreview(saved) || now - saved.created_at > reportPreviewMaxAgeMs || saved.created_at > now + 60_000) { await rm(path, { force: true }).catch(() => {}); return null; }
  return saved;
}
function reportAction(kind) { return kind === "idea" ? "submit Hobbyka idea" : "report Hobbyka bug"; }
function reportRef(kind, id) { return { type: kind, id, ref: `${kind}:${id}` }; }
function validReport(report, kind) { return report !== null && typeof report === "object" && validUUID(report.id) && report.kind === kind; }
function localProvenance() { return { source: "local", freshness: new Date().toISOString() }; }
function jsonFailure(status, code, message, exitCode, refs = []) { return printJSON({ status, result: { code, message: String(message).trim() }, refs }, exitCode); }
function printJSON(value, exitCode) { console.log(JSON.stringify(value)); process.exitCode = exitCode; return value; }

async function install(slug, { update = false, quiet = false } = {}) {
  if (!isPluginSlug(slug)) fail("Некорректный slug плагина.");
  const response = await hubFetch(`${base}/api/plugins/${slug}/download?source=${update ? "update" : "agent"}&target=${platformTarget()}`, undefined, quiet);
  if (!response) return false;
  if (!response.ok) fail(await response.text());

  const codexRoot = join(homedir(), ".codex", "hobbyka-hub-marketplace");
  const previousRoot = await activePluginPath(codexRoot, slug);
  const temp = await mkdtemp(join(tmpdir(), "hobbyka-hub-"));
  try {
    const archive = join(temp, `${slug}.zip`);
    await saveVerified(response, archive);
    const entries = listArchive(archive).trim().split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some((entry) => !isSafeEntry(entry))) fail("В архиве найден небезопасный путь.");
    const pluginRoot = await stagePlugin(codexRoot, slug, async (staging) => {
      extractArchive(archive, staging);
      await readFile(join(staging, ".codex-plugin", "plugin.json"), "utf8");
      await restoreExecutableScripts(staging);
    });
    if (slug === "hobbyka-hub") await copyUpdater(pluginRoot);
    await runPostUpdateHook(pluginRoot);
    await configureMarketplace(codexRoot, { [slug]: pluginRef(pluginRoot) });
    run(codexCommand(), ["plugin", "add", `${slug}@hobbyka-hub`]);
    const downloadId = response.headers.get("x-hobbyka-download-id");
    if (!downloadId) fail("Hub не вернул идентификатор загрузки.");
    const confirmation = await hubFetch(`${base}/api/downloads/${downloadId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ installed: true }) });
    if (!confirmation.ok) fail(`Плагин установлен, но Hub не подтвердил регистрацию: ${await confirmation.text()}`);
    if (!update) await enableAutoupdate(true, slug === "hobbyka-hub" ? pluginRoot : undefined);
    await cleanupPluginRoots(codexRoot, slug, pluginRoot, previousRoot);
    if (!quiet) console.log(`Плагин ${slug} ${update ? "обновлён" : "установлен"} и подтверждён в Hub.`);
    return true;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function installAndReconcile(slug) {
  await install(slug);
  await update(true);
}

async function repair() {
  const codexRoot = join(homedir(), ".codex", "hobbyka-hub-marketplace");
  await updatePublicHub(false);
  await configureMarketplace(codexRoot);
  await enableAutoupdate(true, await activePluginPath(codexRoot, "hobbyka-hub"));
  await update(false);
  console.log("Hobbyka Hub восстановлен, старые установки согласованы, автообновление включено.");
}

async function update(quiet = false) {
  const codexRoot = marketplaceRoot;
  await updatePublicHub(quiet);
  const response = await hubFetch(`${base}/api/plugins`);
  if (!response.ok) fail(await response.text());
  const remote = (await response.json()).plugins;
  let allInstalled = JSON.parse(capture(codexCommand(), ["plugin", "list", "--json"])).installed;
  await reconcileLegacyRemovals(codexRoot, allInstalled);
  allInstalled = JSON.parse(capture(codexCommand(), ["plugin", "list", "--json"])).installed;
  for (const slug of legacySlugs(allInstalled, remote)) {
    await markLegacyRemoval(codexRoot, slug);
    const installed = await install(slug, { update: true, quiet });
    if (!installed) fail(`Не удалось обновить плагин ${slug}.`);
    allInstalled = JSON.parse(capture(codexCommand(), ["plugin", "list", "--json"])).installed;
    await reconcileLegacyRemovals(codexRoot, allInstalled);
  }
  allInstalled = JSON.parse(capture(codexCommand(), ["plugin", "list", "--json"])).installed;
  if (!allInstalled.some((plugin) => plugin.installed && plugin.marketplaceName === "hobbyka")) {
    const marketplaces = JSON.parse(capture(codexCommand(), ["plugin", "marketplace", "list", "--json"])).marketplaces;
    if (marketplaces.some((marketplace) => marketplace.name === "hobbyka")) run(codexCommand(), ["plugin", "marketplace", "remove", "hobbyka"]);
  }
  const installed = allInstalled
    .filter((plugin) => plugin.installed && plugin.marketplaceName === "hobbyka-hub" && plugin.name !== "hobbyka-hub")
    .map((plugin) => ({ slug: plugin.name, version: plugin.version }));
  const pending = installed.filter((local) => remote.some((plugin) => plugin.slug === local.slug && plugin.version !== local.version)).sort((left, right) => left.slug === "hobbyka-hub" ? 1 : right.slug === "hobbyka-hub" ? -1 : left.slug.localeCompare(right.slug));
  for (const plugin of pending) {
    if (!await install(plugin.slug, { update: true, quiet })) fail(`Не удалось обновить плагин ${plugin.slug}.`);
  }
  for (const plugin of installed.filter((local) => !pending.some((pendingPlugin) => pendingPlugin.slug === local.slug))) await runPostUpdateHook(await activePluginPath(codexRoot, plugin.slug));
  if (!quiet) console.log(pending.length ? `Обновлено плагинов: ${pending.length}.` : "Установленные плагины из ХАБа уже актуальны.");
}

async function updatePublicHub(quiet) {
  const codexRoot = join(homedir(), ".codex", "hobbyka-hub-marketplace");
  let currentRoot = await activePluginPath(codexRoot, "hobbyka-hub");
  try { await access(join(currentRoot, ".codex-plugin", "plugin.json")); } catch (error) { if (error?.code === "ENOENT") currentRoot = dirname(dirname(script)); else throw error; }
  const cacheBuster = Date.now();
  let revision;
  let latest;
  try {
    const commitResponse = await fetch(`${publicHubAPI}/commits/main`, { headers: { accept: "application/vnd.github+json" }, cache: "no-store" });
    if (!commitResponse.ok) throw new Error(`HTTP ${commitResponse.status}`);
    revision = (await commitResponse.json()).sha;
    if (!/^[0-9a-f]{40}$/i.test(revision ?? "")) throw new Error("GitHub не вернул immutable commit SHA");
    const response = await fetch(`${publicHub.replace("github.com", "raw.githubusercontent.com")}/${revision}/plugins/hobbyka-hub/.codex-plugin/plugin.json?t=${cacheBuster}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    latest = await response.json();
  } catch (error) { fail(`Не удалось проверить обновление Hobbyka Hub: ${error.message}`); }
  const current = JSON.parse(await readFile(join(currentRoot, ".codex-plugin", "plugin.json"), "utf8"));
  if (latest.version === current.version) return false;
  let response;
  try { response = await fetch(`${publicHub}/archive/${revision}.zip?t=${cacheBuster}`, { cache: "no-store" }); }
  catch (error) { fail(`Не удалось скачать обновление Hobbyka Hub: ${error.message}`); }
  if (!response.ok) fail("Не удалось скачать обновление Hobbyka Hub.");
  const temp = await mkdtemp(join(tmpdir(), "hobbyka-hub-self-update-"));
  try {
    const archive = join(temp, "hobbyka-hub.zip");
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const entries = listArchive(archive).trim().split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some((entry) => !isSafeEntry(entry))) fail("В обновлении Hobbyka Hub найден небезопасный путь.");
    extractArchive(archive, temp);
    const source = join(temp, entries[0].split(/[\\/]/)[0], "plugins", "hobbyka-hub");
    let archiveManifest;
    try { archiveManifest = JSON.parse(await readFile(join(source, ".codex-plugin", "plugin.json"), "utf8")); }
    catch (error) { fail(`Архив Hobbyka Hub не содержит корректный manifest: ${error.message}`); }
    if (archiveManifest?.name !== "hobbyka-hub" || archiveManifest.version !== latest.version) fail("Архив Hobbyka Hub не совпадает с manifest pinned commit.");
    const pluginRoot = await stagePlugin(codexRoot, "hobbyka-hub", (staging) => cp(source, staging, { recursive: true }));
    await writeMarketplace(codexRoot, { "hobbyka-hub": pluginRef(pluginRoot) });
    run(codexCommand(), ["plugin", "add", "hobbyka-hub@hobbyka-hub"]);
    await enableAutoupdate(true, pluginRoot);
    await cleanupPluginRoots(codexRoot, "hobbyka-hub", pluginRoot, currentRoot);
    if (!quiet) console.log(`Hobbyka Hub обновлён до ${latest.version}.`);
    return true;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function propose(value, submit, destination) {
  if (submit) return submitProposal(resolve(value ?? ""));
  const slug = value;
  if (!isPluginSlug(slug)) fail("Некорректный slug плагина.");
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
    await stageDirectory(target, async (staging) => {
      extractArchive(archive, staging);
      await writeFile(join(staging, ".hobbyka-proposal.json"), JSON.stringify({ slug, baseCommit }, null, 2));
    });
    console.log(`Исходники ${slug} подготовлены: ${target}\nПосле изменений: hobbyka-hub propose "${target}" --submit`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function submitProposal(root) {
  const marker = JSON.parse(await readFile(join(root, ".hobbyka-proposal.json"), "utf8"));
  if (!isPluginSlug(marker.slug) || !/^[0-9a-f]{40}$/.test(marker.baseCommit ?? "")) fail("В папке нет корректного предложения ХАБа.");
  const temp = await mkdtemp(join(tmpdir(), "hobbyka-hub-proposal-"));
  try {
    const archive = join(temp, "plugin.zip");
    await createArchive(root, archive);
    const form = new FormData();
    form.set("baseCommit", marker.baseCommit);
    form.set("archive", new File([await readArchiveForUpload(archive)], basename(archive), { type: "application/zip" }));
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
  if (!isPluginSlug(manifest.name)) fail("Некорректный slug плагина.");
  if (!manifest.name || !manifest.version || !manifest.description) fail("В plugin.json нужны name, version и description.");
  const temp = await mkdtemp(join(tmpdir(), "hobbyka-hub-publish-"));
  try {
    const archive = join(temp, "plugin.zip");
    await createArchive(root, archive);
    const form = new FormData();
    form.set("name", manifest.interface?.displayName ?? manifest.name);
    form.set("slug", manifest.name);
    form.set("version", manifest.version);
    form.set("summary", manifest.interface?.shortDescription ?? manifest.description);
    form.set("description", manifest.interface?.longDescription ?? manifest.description);
    form.set("tags", manifest.interface?.category ?? "Productivity");
    form.set("archive", new File([await readArchiveForUpload(archive)], basename(archive), { type: "application/zip" }));
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
    await atomicWriteFile(plist, macPlist(process.execPath, stableScript, codex));
    const domain = `gui/${process.getuid()}`;
    const target = `${domain}/ru.hobbyka.hub-updater`;
    // A loaded job already points at the stable path; booting it out here would terminate this updater before reload.
    if (!launchAgentLoaded(target)) run("launchctl", ["bootstrap", domain, plist]);
  } else if (platform() === "win32") {
    const launcher = join(dirname(stableScript), "update-hidden.vbs");
    await atomicWriteFile(launcher, windowsLauncher(process.execPath, stableScript, codex));
    run("schtasks.exe", ["/Create", "/F", "/TN", "Hobbyka Hub Auto Update", "/SC", "MINUTE", "/MO", "15", "/TR", windowsTaskAction(launcher)]);
  } else if (platform() === "linux") {
    const systemd = linuxSystemd();
    const units = linuxUnits(process.execPath, stableScript, codex);
    await atomicWriteFile(join(systemd.directory, "hobbyka-hub-updater.service"), units.service);
    await atomicWriteFile(join(systemd.directory, "hobbyka-hub-updater.timer"), units.timer);
    run("systemctl", [...systemd.args, "daemon-reload"]);
    run("systemctl", [...systemd.args, "enable", "--now", "hobbyka-hub-updater.timer"]);
  } else fail("Автообновление поддерживается на macOS, Windows и Linux.");
  if (!quiet) console.log("Автообновление фирменных плагинов включено.");
}

async function disableAutoupdate() {
  if (platform() === "darwin") {
    const plist = join(homedir(), "Library", "LaunchAgents", "ru.hobbyka.hub-updater.plist");
    const result = run("launchctl", ["bootout", `gui/${process.getuid()}`, plist], undefined, true);
    if (result.error) fail(result.error.message);
    if (launchAgentLoaded(`gui/${process.getuid()}/ru.hobbyka.hub-updater`)) fail("Не удалось выгрузить автообновление: scheduler оставил job загруженным.");
    await rm(plist, { force: true });
  } else if (platform() === "win32") {
    const result = run("schtasks.exe", ["/Delete", "/F", "/TN", "Hobbyka Hub Auto Update"], undefined, true);
    if (result.error) fail(result.error.message);
    if (windowsTaskPresent()) fail("Не удалось выгрузить автообновление: scheduler оставил задачу загруженной.");
  }
  else if (platform() === "linux") {
    const systemd = linuxSystemd();
    const result = run("systemctl", [...systemd.args, "disable", "--now", "hobbyka-hub-updater.timer"], undefined, true);
    if (result.error) fail(result.error.message);
    if (systemdTimerPresent(systemd)) fail("Не удалось выгрузить автообновление: systemd оставил timer активным.");
    await rm(join(systemd.directory, "hobbyka-hub-updater.service"), { force: true });
    await rm(join(systemd.directory, "hobbyka-hub-updater.timer"), { force: true });
    run("systemctl", [...systemd.args, "daemon-reload"]);
  } else fail("Автообновление поддерживается на macOS, Windows и Linux.");
  console.log("Автообновление выключено.");
}

async function copyUpdater(pluginRoot) {
  const root = join(homedir(), ".codex", "hobbyka-hub-updater");
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await atomicCopyFile(join(pluginRoot, "bin", "hobbyka-hub.mjs"), join(root, "bin", "hobbyka-hub.mjs"));
  await atomicCopyFile(join(pluginRoot, "assets", "hobbyka-chat-root.crt"), join(root, "assets", "hobbyka-chat-root.crt"));
  await atomicCopyFile(join(pluginRoot, ".codex-plugin", "plugin.json"), join(root, ".codex-plugin", "plugin.json"));
  await chmod(join(root, "bin", "hobbyka-hub.mjs"), 0o755);
  return join(root, "bin", "hobbyka-hub.mjs");
}

async function writeMarketplace(codexRoot, activeRoots = {}) {
  const entries = new Map();
  let previous = [];
  try { previous = JSON.parse(await readFile(join(codexRoot, ".agents", "plugins", "marketplace.json"), "utf8")).plugins ?? []; } catch { /* recover from a missing or interrupted legacy file */ }
  for (const entry of previous) {
    const name = entry?.name;
    const sourcePath = entry?.source?.path;
    if (typeof name !== "string" || typeof sourcePath !== "string") continue;
    if (await hasPluginManifest(resolve(codexRoot, sourcePath))) entries.set(name, sourcePath);
  }
  for (const name of await directories(join(codexRoot, "plugins"))) {
    if (name.startsWith(".")) continue;
    const sourcePath = `./plugins/${name}`;
    if (await hasPluginManifest(join(codexRoot, "plugins", name)) && !entries.has(name)) entries.set(name, sourcePath);
  }
  for (const [name, sourcePath] of Object.entries(activeRoots)) entries.set(name, sourcePath);
  await mkdir(join(codexRoot, ".agents", "plugins"), { recursive: true });
  await atomicWriteFile(join(codexRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "hobbyka-hub", plugins: [...entries.keys()].sort().map((name) => ({ name, source: { source: "local", path: entries.get(name) }, policy: { installation: "AVAILABLE" } })) }, null, 2));
}

async function configureMarketplace(codexRoot, activeRoots = {}) {
  const roots = { ...activeRoots };
  const currentHubRoot = roots["hobbyka-hub"] ? resolve(codexRoot, roots["hobbyka-hub"]) : await activePluginPath(codexRoot, "hobbyka-hub");
  if (await hasPluginManifest(currentHubRoot)) {
    if (!roots["hobbyka-hub"]) roots["hobbyka-hub"] = pluginRef(currentHubRoot);
  } else {
    const hubRoot = await stagePlugin(codexRoot, "hobbyka-hub", (staging) => cp(dirname(dirname(script)), staging, { recursive: true }));
    roots["hobbyka-hub"] = pluginRef(hubRoot);
  }
  await writeMarketplace(codexRoot, roots);
  const marketplaces = JSON.parse(capture(codexCommand(), ["plugin", "marketplace", "list", "--json"])).marketplaces ?? [];
  const existing = marketplaces.find((marketplace) => marketplace.name === "hobbyka-hub");
  if (managedMarketplace(existing, codexRoot)) return;
  if (existing) run(codexCommand(), ["plugin", "marketplace", "remove", "hobbyka-hub"]);
  run(codexCommand(), ["plugin", "marketplace", "add", "."], codexRoot);
  run(codexCommand(), ["plugin", "add", "hobbyka-hub@hobbyka-hub"]);
}

async function stagePlugin(codexRoot, slug, populate) {
  const versionsRoot = join(codexRoot, "plugins", ".hobbyka-versions");
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const published = join(versionsRoot, `${slug}-${suffix}`);
  await mkdir(versionsRoot, { recursive: true });
  return stageDirectory(published, populate);
}

async function stageDirectory(target, populate) {
  const published = target;
  const staging = await mkdtemp(join(dirname(published), `.${basename(published)}.staging-`));
  try {
    await populate(staging);
    await rename(staging, published);
    return published;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function pluginRef(pluginRoot) { return `./plugins/.hobbyka-versions/${basename(pluginRoot)}`; }

async function activePluginPath(codexRoot, slug) {
  try {
    const marketplace = JSON.parse(await readFile(join(codexRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
    const sourcePath = marketplace.plugins?.find((plugin) => plugin.name === slug)?.source?.path;
    if (typeof sourcePath === "string") return resolve(codexRoot, sourcePath);
  } catch { /* use the legacy direct root when no catalogue exists */ }
  return join(codexRoot, "plugins", slug);
}

async function hasPluginManifest(pluginRoot) {
  try { await access(join(pluginRoot, ".codex-plugin", "plugin.json")); return true; } catch { return false; }
}

async function cleanupPluginRoots(codexRoot, slug, activeRoot, previousRoot) {
  const versionsRoot = join(codexRoot, "plugins", ".hobbyka-versions");
  for (const name of await directories(versionsRoot)) {
    const path = join(versionsRoot, name);
    if (name.startsWith(`${slug}-`) && path !== activeRoot && path !== previousRoot) await rm(path, { recursive: true, force: true });
  }
  const legacyRoot = join(codexRoot, "plugins", slug);
  if (legacyRoot !== activeRoot && legacyRoot !== previousRoot) await rm(legacyRoot, { recursive: true, force: true });
}

function managedMarketplace(marketplace, codexRoot) {
  const root = marketplace?.root ?? marketplace?.marketplaceSource?.source;
  return marketplace?.name === "hobbyka-hub" && typeof root === "string" && resolve(root) === resolve(codexRoot);
}

async function directories(root) { try { return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; } }
async function restoreExecutableScripts(pluginRoot) {
  if (platform() === "win32") return;
  for (const directory of ["scripts", "bin"]) await restoreShebangFiles(join(pluginRoot, directory));
}
async function restoreShebangFiles(root) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await restoreShebangFiles(path);
    else if (entry.isFile() && await hasShebang(path)) await chmod(path, 0o755);
  }
}
async function hasShebang(path) {
  const handle = await open(path, "r");
  try {
    const marker = Buffer.alloc(2);
    const { bytesRead } = await handle.read(marker, 0, marker.length, 0);
    return bytesRead === marker.length && marker.equals(Buffer.from("#!"));
  } finally { await handle.close(); }
}
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
function legacyRemovalMarker(codexRoot, slug) { return join(codexRoot, `${legacyRemovalPrefix}${slug}.json`); }
async function markLegacyRemoval(codexRoot, slug) { await atomicWriteFile(legacyRemovalMarker(codexRoot, slug), JSON.stringify({ marketplace: "hobbyka", slug })); }
async function reconcileLegacyRemovals(codexRoot, installed) {
  let entries;
  try { entries = await readdir(codexRoot); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  for (const name of entries.filter((entry) => entry.startsWith(legacyRemovalPrefix) && entry.endsWith(".json"))) {
    const path = join(codexRoot, name);
    let marker;
    try { marker = JSON.parse(await readFile(path, "utf8")); } catch (error) { fail(`Не удалось прочитать marker удаления legacy plugin: ${error.message}`); }
    if (marker?.marketplace !== "hobbyka" || !isPluginSlug(marker.slug) || name !== `${legacyRemovalPrefix}${marker.slug}.json`) fail("Некорректный marker удаления legacy plugin.");
    const replacement = installed.some((plugin) => plugin.installed && plugin.marketplaceName === "hobbyka-hub" && plugin.name === marker.slug);
    if (!replacement) continue;
    const present = installed.some((plugin) => plugin.installed && plugin.marketplaceName === "hobbyka" && plugin.name === marker.slug);
    if (!present) { await rm(path, { force: true }); continue; }
    const result = run(codexCommand(), ["plugin", "remove", `${marker.slug}@hobbyka`], undefined, true);
    if (result.error) fail(result.error.message);
    if (result.status !== 0) fail(`Не удалось удалить legacy plugin ${marker.slug}; повторите update для reconciliation.`);
    await rm(path, { force: true });
  }
}
function legacySlugs(installed, remote) { const available = new Set(remote.map((plugin) => plugin.slug).filter((slug) => slug !== "hobbyka-hub")); return installed.filter((plugin) => plugin.installed && plugin.marketplaceName === "hobbyka" && available.has(plugin.name)).map((plugin) => plugin.name).sort(); }
function listArchive(archive) { return platform() === "win32" ? capture("tar.exe", ["-tf", archive]) : capture("unzip", ["-Z1", archive]); }
function extractArchive(archive, target) { if (platform() !== "win32") return run("unzip", ["-q", archive, "-d", target]); run("tar.exe", ["-xf", archive, "-C", target]); }
async function assertNoSecretFiles(root, relative = "") {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (isSecretFileName(entry.name)) fail(`В плагине найден запрещённый секретный файл: ${path}`);
    if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") await assertNoSecretFiles(join(root, entry.name), path);
  }
}
async function createArchive(root, archive) { await assertNoSecretFiles(root); if (platform() !== "win32") return run("zip", ["-qr", archive, ".", "-x", "*.DS_Store", ".git/*", "node_modules/*", ".hobbyka-proposal.json"], root); run("tar.exe", ["-a", "-cf", archive, "--exclude=.git", "--exclude=node_modules", "--exclude=.DS_Store", "--exclude=.hobbyka-proposal.json", "-C", root, "."]); }
function isSafeEntry(entry) { const path = entry.replaceAll("\\", "/"); return !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !path.includes("\0") && !path.split("/").includes(".."); }
function codexCommand() { return process.env.HOBBYKA_CODEX_COMMAND || (platform() === "win32" ? "codex.cmd" : "codex"); }
function platformTarget(os = platform(), cpu = arch()) { return `${os === "win32" ? "windows" : os}-${cpu === "x64" ? "amd64" : cpu}`; }
function resolveCodexCommand() { const command = codexCommand(); if (command.includes("/") || command.includes("\\")) return command; const result = spawnSync(platform() === "win32" ? "where.exe" : "which", [command], { encoding: "utf8" }); if (result.status !== 0) fail("Не найден исполняемый файл Codex."); return result.stdout.trim().split(/\r?\n/)[0]; }
function launchAgentLoaded(target) {
  const result = spawnSync("launchctl", ["print", target], { stdio: "ignore" });
  if (result.error) fail(result.error.message);
  return result.status === 0;
}
function windowsTaskPresent() {
  const result = spawnSync("schtasks.exe", ["/Query", "/TN", "Hobbyka Hub Auto Update"], { stdio: "ignore" });
  if (result.error) fail(result.error.message);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  fail(`Не удалось определить состояние планировщика Windows: schtasks.exe завершился с кодом ${result.status}.`);
}
function systemdTimerPresent(systemd) {
  const result = spawnSync("systemctl", [...systemd.args, "show", "hobbyka-hub-updater.timer", "--property=LoadState,ActiveState,UnitFileState"], { encoding: "utf8" });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`Не удалось определить состояние systemd timer: systemctl завершился с кодом ${result.status}.`);
  const state = Object.fromEntries((result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : [line, undefined];
  }));
  if (!["LoadState", "ActiveState", "UnitFileState"].every((key) => typeof state[key] === "string")) fail("Не удалось определить состояние systemd timer: systemctl вернул неполный ответ.");
  if (state.LoadState === "not-found") return false;
  if (state.LoadState === "loaded" && state.ActiveState === "inactive" && state.UnitFileState === "disabled") return false;
  return true;
}
function xml(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function macPlist(node, updater, codex) { return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>ru.hobbyka.hub-updater</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(updater)}</string><string>update</string><string>--quiet</string></array><key>EnvironmentVariables</key><dict><key>HOBBYKA_CODEX_COMMAND</key><string>${xml(codex)}</string></dict><key>StartInterval</key><integer>900</integer><key>RunAtLoad</key><true/></dict></plist>\n`; }
function windowsLauncher(node, updater, codex) { const escape = (value) => value.replaceAll('"', '""'); const command = escape(`"${node}" "${updater}" update --quiet`); return `Set shell = CreateObject("Wscript.Shell")\r\nshell.Environment("Process")("HOBBYKA_CODEX_COMMAND") = "${escape(codex)}"\r\nshell.Run "${command}", 0, False\r\n`; }
function linuxSystemd() { const system = process.getuid?.() === 0; return { directory: system ? "/etc/systemd/system" : join(homedir(), ".config", "systemd", "user"), args: system ? [] : ["--user"] }; }
function systemdQuote(value) { return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`; }
function linuxUnits(node, updater, codex, home = homedir()) { return { service: `[Unit]\nDescription=Update Hobbyka Hub plugins\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nEnvironment=${systemdQuote(`HOBBYKA_CODEX_COMMAND=${codex}`)}\nEnvironment=${systemdQuote(`HOME=${home}`)}\nExecStart=${systemdQuote(node)} ${systemdQuote(updater)} update --quiet\n`, timer: `[Unit]\nDescription=Check Hobbyka Hub plugin updates every 15 minutes\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=15min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n` }; }
function windowsTaskAction(launcher) { const script = `& 'wscript.exe' '${String(launcher).replaceAll("'", "''")}'`; return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`; }
function windowsCommand(executable, args) { const values = [executable, ...args].map(String); if (values.some((value) => /[\r\n"&|<>^%!]/.test(value))) fail("Команда Windows содержит небезопасный аргумент."); return values.map((value) => `"${value}"`).join(" "); }
function windowsShellRequired(executable, os = platform()) { return os === "win32" && (/\.(?:cmd|bat)$/i.test(executable) || basename(executable).toLowerCase() === "schtasks.exe"); }
function spawnProcess(executable, args, options) { if (!windowsShellRequired(executable)) return spawnSync(executable, args, options); const command = `"${windowsCommand(executable, args)}"`; return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], { ...options, windowsHide: true, windowsVerbatimArguments: true }); }
function run(executable, args, cwd, allowFailure = false) { const result = spawnProcess(executable, args, { cwd, stdio: allowFailure ? "ignore" : "inherit" }); if (!allowFailure && result.error) fail(result.error.message); if (!allowFailure && result.status !== 0) fail(`${executable} завершился с кодом ${result.status}.`); return result; }
function capture(executable, args) { const result = spawnProcess(executable, args, { encoding: "utf8" }); if (result.error) fail(result.error.message); if (result.status !== 0) fail(result.stderr || `${executable} завершился с кодом ${result.status}.`); return result.stdout; }
async function hubFetch(url, options, quiet = false) { let response; try { response = await fetch(url, options); } catch { if (quiet) return null; fail("ХАБ недоступен. Подключите VPN-профиль Хоббики и повторите."); } const error = identityError(response.status, response.ok ? "" : await response.clone().text()); if (error) { if (quiet) return null; fail(error); } return response; }
function identityError(status, body) { if (status === 403) return "ХАБ не определил сотрудника. Подключите VPN-профиль Хоббики и повторите."; if (status === 502 && body.includes("Agent Chat не подтвердил профиль сотрудника")) return "VPN подключён, но Agent Chat не подтвердил профиль сотрудника."; return ""; }
async function selfTest() {
	const reportOperation = "5d90568b-58d5-481d-8ef1-2d91cd904708";
	const reportV7 = "0190f7e3-5c5a-7abc-8def-0123456789ab";
	const reportV8 = "0190f7e3-5c5a-8abc-8def-0123456789ab";
	const reportOtherVariant = "0190f7e3-5c5a-8abc-0def-0123456789ab";
	const reportNil = "00000000-0000-0000-0000-000000000000";
	const reportArgs = parseReportArgs(["--stdin", "--file", "one.png", "--file=two.log", "--operation", reportOperation, "--confirm"]);
	const upperReportArgs = parseReportArgs(["--stdin", "--file", "one.png", "--file=two.log", "--operation", reportOperation.toUpperCase(), "--confirm"]);
	if (!reportArgs.ok || reportArgs.files.join() !== "one.png,two.log" || reportArgs.operation !== reportOperation || !reportArgs.confirm || !upperReportArgs.ok || upperReportArgs.operation !== reportOperation || derivedOperationID(reportOperation.toUpperCase(), 0) !== derivedOperationID(reportOperation, 0) || !validUUID(derivedOperationID(reportOperation, 0)) || normalizeUUID(reportV7) !== reportV7 || normalizeUUID(reportV8) !== reportV8 || normalizeUUID(reportOtherVariant) !== reportOtherVariant || normalizeUUID(reportNil) !== reportNil || normalizeUUID(reportV7.toUpperCase()) !== reportV7 || normalizeUUID(reportV7.replaceAll("-", "")) !== "" || normalizeUUID(`urn:uuid:${reportV7}`) !== "" || normalizeUUID(`{${reportV7}}`) !== "" || normalizeUUID("not-a-uuid") !== "") throw new Error("bug report UUID normalization failed");
	if (reportAction("bug") !== "report Hobbyka bug" || reportAction("idea") !== "submit Hobbyka idea") throw new Error("typed report preview failed");
	if (reportRef("idea", reportOperation).ref !== `idea:${reportOperation}` || !validReport({ id: reportOperation, kind: "idea" }, "idea") || !validReport({ id: reportOperation, kind: "bug" }, "bug") || validReport({ id: reportOperation, kind: "bug" }, "idea") || validReport(null, "idea")) throw new Error("typed report response failed");
  if (!install.toString().includes("platformTarget()") || !install.toString().includes("&target=")) throw new Error("platform-targeted install failed");
  if (managedMarketplace({ name: "hobbyka-hub", root: "/managed" }, "/managed") !== true || managedMarketplace({ name: "hobbyka-hub", root: "/public" }, "/managed") !== false) throw new Error("marketplace collision check failed");
  if (!copyUpdater.toString().includes('".codex-plugin"') || !updatePublicHub.toString().includes("dirname(dirname(script))")) throw new Error("fresh public bootstrap update failed");
  if (!macPlist("/path/node", "/path/updater", "/path/codex").includes("<integer>900</integer>") || !macPlist("/path/node", "/path/updater", "/path/codex").includes("HOBBYKA_CODEX_COMMAND</key><string>/path/codex")) throw new Error("macOS schedule failed");
  if (!windowsLauncher("C:\\Node\\node.exe", "C:\\Hub\\update.mjs", "C:\\Codex\\codex.exe").includes("HOBBYKA_CODEX_COMMAND") || !windowsLauncher("C:\\Node\\node.exe", "C:\\Hub\\update.mjs", "C:\\Codex\\codex.exe").includes("update --quiet")) throw new Error("Windows schedule failed");
  const units = linuxUnits("/path/node", "/path/updater", "/path/codex", "/home/test");
  if (!units.service.includes('Environment="HOBBYKA_CODEX_COMMAND=/path/codex"') || !units.service.includes('Environment="HOME=/home/test"') || !units.service.includes('ExecStart="/path/node" "/path/updater" update --quiet') || !units.timer.includes("OnUnitActiveSec=15min")) throw new Error("Linux schedule failed");
  if (!isSafeEntry("skills/example/SKILL.md") || !isSafeEntry("skills\\example\\SKILL.md") || isSafeEntry("../secret") || isSafeEntry("..\\secret") || isSafeEntry("/secret") || isSafeEntry("\\secret") || isSafeEntry("C:/secret") || isSafeEntry("C:\\secret")) throw new Error("archive path check failed");
  if (!isSecretFileName(".env") || !isSecretFileName("server.key") || !isSecretFileName("client.p12") || !isSecretFileName("id_ed25519") || isSecretFileName(".env.example") || isSecretFileName("public.pem")) throw new Error("secret file check failed");
  if (!isPluginSlug("safe-plugin") || isPluginSlug("../escape")) throw new Error("plugin slug check failed");
  if (MAX_ARCHIVE_BYTES !== 256 * 1024 * 1024 || !readArchiveForUpload.toString().includes("stat")) throw new Error("archive size guard failed");
  if (!createArchive.toString().includes(".hobbyka-proposal.json")) throw new Error("proposal marker exclusion failed");
  if (legacySlugs([{ name: "known", installed: true, marketplaceName: "hobbyka" }, { name: "missing", installed: true, marketplaceName: "hobbyka" }], [{ slug: "known" }]).join() !== "known") throw new Error("legacy migration selection failed");
  if (legacySlugs([{ name: "hobbyka-hub", installed: true, marketplaceName: "hobbyka" }], [{ slug: "hobbyka-hub" }]).length) throw new Error("public Hub ownership failed");
  if (!update.toString().includes('plugin.name !== "hobbyka-hub"')) throw new Error("public Hub update ownership failed");
  if (!identityError(403, "").includes("VPN-профиль Хоббики") || !identityError(502, "Agent Chat не подтвердил профиль сотрудника").includes("Agent Chat")) throw new Error("VPN identity errors failed");
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-hook-test-"));
  try {
    const payload = Buffer.from("streamed archive");
    const archive = join(fixture, "archive.zip");
    await saveVerified(new Response(payload, { headers: { "x-hobbyka-sha256": createHash("sha256").update(payload).digest("hex") } }), archive);
    if (await readFile(archive, "utf8") !== payload.toString()) throw new Error("streamed download failed");
    await mkdir(join(fixture, ".codex-plugin"));
    await writeFile(join(fixture, ".codex-plugin", "post-update.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'ok');\n");
    await mkdir(join(fixture, "scripts"));
    const launcher = join(fixture, "scripts", "launcher");
    const config = join(fixture, "scripts", "config.json");
    await writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    await writeFile(config, "{}\n", { mode: 0o644 });
    if (platform() !== "win32") {
      await restoreExecutableScripts(fixture);
      if (((await stat(launcher)).mode & 0o111) === 0 || ((await stat(config)).mode & 0o111) !== 0) throw new Error("executable script restoration failed");
    }
    const marker = join(fixture, "ran");
    await runPostUpdateHook(fixture, marker);
    if (await readFile(marker, "utf8") !== "ok") throw new Error("post-update hook failed");
  } finally { await rm(fixture, { recursive: true, force: true }); }
  console.log("hobbyka-hub self-test: ok");
}
function fail(message) { console.error(message); process.exit(1); }
