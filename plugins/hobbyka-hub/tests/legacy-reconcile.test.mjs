import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/hobbyka-hub.mjs", import.meta.url));
const currentVersion = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8")).version;

function runUpdate(fixture, mode, interrupt = false) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", join(fixture, "fetch-mock.mjs"), cli, "update", "--quiet"], {
      env: {
        ...process.env,
        HOME: fixture,
        PATH: `${fixture}:${process.env.PATH ?? ""}`,
        HOBBYKA_CODEX_COMMAND: join(fixture, "codex"),
        HOBBYKA_HUB_CA_READY: "1",
        CR338_MODE: mode,
        CR338_INTERRUPT: interrupt ? "1" : "0",
        CR338_INSTALLED: join(fixture, "installed"),
        CR338_REMOVED: join(fixture, "removed"),
        CR338_TRACE: join(fixture, "codex.trace"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (status, signal) => resolve({ status, signal, output }));
  });
}

test("legacy-removal intent survives an accepted install interruption and retries cleanup (CR-338)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-legacy-reconcile-"));
  const source = join(fixture, "plugin");
  const archive = join(fixture, "legacy.zip");
  const marker = join(fixture, ".codex", "hobbyka-hub-marketplace", ".hobbyka-hub-legacy-removal-legacy.json");
  try {
    await mkdir(join(source, ".codex-plugin"), { recursive: true });
    await writeFile(join(source, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "legacy", version: "2.0.0", description: "CR-338" }), "utf8");
    const packed = await new Promise((resolve) => {
      const child = spawn("zip", ["-qr", archive, "."], { cwd: source, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => resolve({ status, stderr }));
    });
    assert.equal(packed.status, 0, packed.stderr);
    const archiveBytes = await readFile(archive);
    const archiveHash = createHash("sha256").update(archiveBytes).digest("hex");

    await writeFile(join(fixture, "codex"), `#!/bin/sh
printf '%s\\n' "$*" >> "$CR338_TRACE"
case "$*" in
  'plugin list --json')
    if [ -f "$CR338_REMOVED" ]; then
      printf '%s\\n' '{"installed":[{"name":"legacy","installed":true,"marketplaceName":"hobbyka-hub","version":"2.0.0"}]}'
    elif [ -f "$CR338_INSTALLED" ]; then
      printf '%s\\n' '{"installed":[{"name":"legacy","installed":true,"marketplaceName":"hobbyka","version":"1.0.0"},{"name":"legacy","installed":true,"marketplaceName":"hobbyka-hub","version":"2.0.0"}]}'
    else
      printf '%s\\n' '{"installed":[{"name":"legacy","installed":true,"marketplaceName":"hobbyka","version":"1.0.0"}]}'
    fi
    ;;
  'plugin marketplace list --json') printf '%s\\n' '{"marketplaces":[]}' ;;
  'plugin marketplace add'*) exit 0 ;;
  'plugin add hobbyka-hub@hobbyka-hub') exit 0 ;;
  'plugin add legacy@hobbyka-hub') touch "$CR338_INSTALLED"; exit 0 ;;
  'plugin remove legacy@hobbyka')
    if [ "$CR338_MODE" = "fail-remove" ]; then exit 77; fi
    touch "$CR338_REMOVED"
    ;;
esac
`, { mode: 0o755 });
    await writeFile(join(fixture, "fetch-mock.mjs"), `
import { readFile } from "node:fs/promises";
const archive = ${JSON.stringify(archive)};
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("raw.githubusercontent.com")) return new Response(JSON.stringify({ version: ${JSON.stringify(currentVersion)} }));
  if (url.endsWith("/api/plugins")) return new Response(JSON.stringify({ plugins: [{ slug: "legacy", version: "2.0.0" }] }));
  if (url.includes("/api/plugins/legacy/download")) return new Response(await readFile(archive), { headers: { "x-hobbyka-sha256": ${JSON.stringify(archiveHash)}, "x-hobbyka-download-id": "cr338" } });
  if (url.includes("/api/downloads/cr338/confirm")) {
    if (process.env.CR338_INTERRUPT === "1") process.kill(process.pid, "SIGTERM");
    return new Response("{}");
  }
  return new Response("not found", { status: 404 });
};
`, "utf8");

    const interrupted = await runUpdate(fixture, "interrupt", true);
    assert.notEqual(interrupted.status, 0, interrupted.output);
    let markerContent;
    try { markerContent = await readFile(marker, "utf8"); } catch (error) { throw new Error(`${interrupted.output}\n${error.message}`); }
    assert.equal(markerContent, JSON.stringify({ marketplace: "hobbyka", slug: "legacy" }));
    assert.match(await readFile(join(fixture, "codex.trace"), "utf8"), /plugin add legacy@hobbyka-hub/);
    assert.doesNotMatch(await readFile(join(fixture, "codex.trace"), "utf8"), /plugin remove legacy@hobbyka/);

    const failedRemoval = await runUpdate(fixture, "fail-remove");
    assert.notEqual(failedRemoval.status, 0, failedRemoval.output);
    assert.match(failedRemoval.output, /Не удалось удалить legacy plugin legacy/);
    assert.equal(await readFile(marker, "utf8"), JSON.stringify({ marketplace: "hobbyka", slug: "legacy" }));

    const retried = await runUpdate(fixture, "success");
    assert.equal(retried.status, 0, retried.output);
    await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
    const trace = await readFile(join(fixture, "codex.trace"), "utf8");
    assert.equal((trace.match(/plugin add legacy@hobbyka-hub/g) ?? []).length, 1);
    assert.equal((trace.match(/plugin remove legacy@hobbyka/g) ?? []).length, 2);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
