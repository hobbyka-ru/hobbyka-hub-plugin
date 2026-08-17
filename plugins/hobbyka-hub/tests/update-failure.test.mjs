import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/hobbyka-hub.mjs", import.meta.url));
const currentVersion = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8")).version;

async function runUpdate(fixture, mode, quiet = false) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", join(fixture, "fetch-mock.mjs"), cli, "update", ...(quiet ? ["--quiet"] : [])], {
      env: { ...process.env, HOME: fixture, PATH: `${fixture}:${process.env.PATH ?? ""}`, HOBBYKA_CODEX_COMMAND: join(fixture, "codex"), HOBBYKA_HUB_CA_READY: "1", CR337_MODE: mode },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (status) => resolve({ status, output }));
  });
}

test("update does not report current when the public manifest cannot be checked (CR-337)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-update-failure-public-"));
  try {
    await writeFile(join(fixture, "codex"), `#!/bin/sh
case "$*" in
  'plugin list --json') printf '%s\\n' '{"installed":[]}' ;;
  'plugin marketplace list --json') printf '%s\\n' '{"marketplaces":[]}' ;;
esac
`, { mode: 0o755 });
    await writeFile(join(fixture, "fetch-mock.mjs"), `
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("raw.githubusercontent.com")) throw new Error("public manifest offline");
  if (url.endsWith("/api/plugins")) return new Response(JSON.stringify({ plugins: [] }));
  return new Response("not found", { status: 404 });
};
`, "utf8");
    const result = await runUpdate(fixture, "public-failure");
    assert.notEqual(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /Установленные плагины из ХАБа уже актуальны/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("quiet update returns failure when the private catalog cannot be checked (CR-337)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-update-failure-private-"));
  try {
    await writeFile(join(fixture, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(fixture, "fetch-mock.mjs"), `
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("raw.githubusercontent.com")) return new Response(JSON.stringify({ version: ${JSON.stringify(currentVersion)} }));
  if (url.endsWith("/api/plugins")) throw new Error("private catalog offline");
  return new Response("not found", { status: 404 });
};
`, "utf8");
    const result = await runUpdate(fixture, "private-failure", true);
    assert.notEqual(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /Установленные плагины из ХАБа уже актуальны/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("quiet update returns failure when a pending plugin cannot be downloaded (CR-337)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-update-failure-plugin-"));
  try {
    await writeFile(join(fixture, "codex"), `#!/bin/sh
case "$*" in
  'plugin list --json') printf '%s\\n' '{"installed":[{"name":"sample","installed":true,"marketplaceName":"hobbyka-hub","version":"1.0.0"}]}' ;;
  'plugin marketplace list --json') printf '%s\\n' '{"marketplaces":[]}' ;;
esac
`, { mode: 0o755 });
    await writeFile(join(fixture, "fetch-mock.mjs"), `
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("raw.githubusercontent.com")) return new Response(JSON.stringify({ version: ${JSON.stringify(currentVersion)} }));
  if (url.endsWith("/api/plugins")) return new Response(JSON.stringify({ plugins: [{ slug: "sample", version: "2.0.0" }] }));
  if (url.includes("/api/plugins/sample/download")) throw new Error("plugin download offline");
  return new Response("not found", { status: 404 });
};
`, "utf8");
    const result = await runUpdate(fixture, "plugin-failure", true);
    assert.notEqual(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /Установленные плагины из ХАБа уже актуальны/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("quiet update returns failure when the public archive cannot be downloaded (CR-337)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-update-failure-archive-"));
  try {
    await writeFile(join(fixture, "codex"), "#!/bin/sh\ncase \"$*\" in 'plugin list --json') printf '%s\\n' '{\"installed\":[]}' ;; 'plugin marketplace list --json') printf '%s\\n' '{\"marketplaces\":[]}' ;; esac\n", { mode: 0o755 });
    await writeFile(join(fixture, "fetch-mock.mjs"), `
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("raw.githubusercontent.com")) return new Response(JSON.stringify({ version: "999.0.0" }));
  if (url.includes("/archive/refs/heads/main.zip")) return new Response("upstream unavailable", { status: 503 });
  if (url.endsWith("/api/plugins")) return new Response(JSON.stringify({ plugins: [] }));
  return new Response("not found", { status: 404 });
};
`, "utf8");
    const result = await runUpdate(fixture, "archive-failure", true);
    assert.notEqual(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /Установленные плагины из ХАБа уже актуальны/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("quiet update returns failure when a legacy plugin cannot be downloaded (CR-337)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-update-failure-legacy-"));
  try {
    await writeFile(join(fixture, "codex"), `#!/bin/sh
case "$*" in
  'plugin list --json') printf '%s\\n' '{"installed":[{"name":"legacy","installed":true,"marketplaceName":"hobbyka","version":"1.0.0"}]}' ;;
  'plugin marketplace list --json') printf '%s\\n' '{"marketplaces":[]}' ;;
esac
`, { mode: 0o755 });
    await writeFile(join(fixture, "fetch-mock.mjs"), `
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("raw.githubusercontent.com")) return new Response(JSON.stringify({ version: ${JSON.stringify(currentVersion)} }));
  if (url.endsWith("/api/plugins")) return new Response(JSON.stringify({ plugins: [{ slug: "legacy", version: "1.0.0" }] }));
  if (url.includes("/api/plugins/legacy/download")) throw new Error("legacy download offline");
  return new Response("not found", { status: 404 });
};
`, "utf8");
    const result = await runUpdate(fixture, "legacy-failure", true);
    assert.notEqual(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /Установленные плагины из ХАБа уже актуальны/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("quiet update returns failure when Hub confirmation cannot be completed (CR-337)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-update-failure-confirmation-"));
  const source = join(fixture, "source");
  const archive = join(fixture, "sample.zip");
  try {
    await mkdir(join(source, ".codex-plugin"), { recursive: true });
    await writeFile(join(source, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "sample", version: "2.0.0", description: "sample" }), "utf8");
    const packed = spawnSync("zip", ["-qr", archive, "."], { cwd: source });
    assert.equal(packed.status, 0);
    const archiveBytes = await readFile(archive);
    const archiveHash = createHash("sha256").update(archiveBytes).digest("hex");
    await writeFile(join(fixture, "codex"), `#!/bin/sh
case "$*" in
  'plugin list --json') printf '%s\\n' '{"installed":[{"name":"sample","installed":true,"marketplaceName":"hobbyka-hub","version":"1.0.0"}]}' ;;
  'plugin marketplace list --json') printf '%s\\n' '{"marketplaces":[{"name":"hobbyka-hub"}]}' ;;
esac
`, { mode: 0o755 });
    await writeFile(join(fixture, "fetch-mock.mjs"), `
import { readFile } from "node:fs/promises";
const archive = ${JSON.stringify(archive)};
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("raw.githubusercontent.com")) return new Response(JSON.stringify({ version: ${JSON.stringify(currentVersion)} }));
  if (url.endsWith("/api/plugins")) return new Response(JSON.stringify({ plugins: [{ slug: "sample", version: "2.0.0" }] }));
  if (url.includes("/api/plugins/sample/download")) return new Response(await readFile(archive), { headers: { "x-hobbyka-sha256": ${JSON.stringify(archiveHash)}, "x-hobbyka-download-id": "cr337-confirmation" } });
  if (url.includes("/api/downloads/cr337-confirmation/confirm")) throw new Error("confirmation offline");
  return new Response("not found", { status: 404 });
};
`, "utf8");
    const result = await runUpdate(fixture, "confirmation-failure", true);
    assert.notEqual(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /Установленные плагины из ХАБа уже актуальны/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
