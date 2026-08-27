import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/hobbyka-hub.mjs", import.meta.url));
const currentVersion = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8")).version;
const publicRevision = "0123456789abcdef0123456789abcdef01234567";

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
  if (url.includes("/repos/hobbyka-ru/hobbyka-hub-plugin/commits/main")) throw new Error("public manifest offline");
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
  if (url.includes("/repos/hobbyka-ru/hobbyka-hub-plugin/commits/main")) return new Response(JSON.stringify({ sha: ${JSON.stringify(publicRevision)} }));
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
  if (url.includes("/repos/hobbyka-ru/hobbyka-hub-plugin/commits/main")) return new Response(JSON.stringify({ sha: ${JSON.stringify(publicRevision)} }));
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
  if (url.includes("/repos/hobbyka-ru/hobbyka-hub-plugin/commits/main")) return new Response(JSON.stringify({ sha: ${JSON.stringify(publicRevision)} }));
  if (url.includes("raw.githubusercontent.com")) return new Response(JSON.stringify({ version: "999.0.0" }));
  if (url.includes("/archive/" + ${JSON.stringify(publicRevision)} + ".zip") || url.includes("/archive/refs/heads/main.zip")) return new Response("upstream unavailable", { status: 503 });
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
  if (url.includes("/repos/hobbyka-ru/hobbyka-hub-plugin/commits/main")) return new Response(JSON.stringify({ sha: ${JSON.stringify(publicRevision)} }));
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
  if (url.includes("/repos/hobbyka-ru/hobbyka-hub-plugin/commits/main")) return new Response(JSON.stringify({ sha: ${JSON.stringify(publicRevision)} }));
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

test("Windows keeps the previous plugin active when post-update verification is blocked", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-update-runtime-rollback-"));
  const codexRoot = join(fixture, ".codex", "hobbyka-hub-marketplace");
  const archiveRoot = join(fixture, "candidate");
  const archive = join(fixture, "work-memory.zip");
  const slugs = ["hobbyka-hub", "hobbyka-agent-chat", "onec-direct-cli", "amo-direct-cli", "hobbyka-commercial-offers", "work-memory"];
  try {
    const plugins = [];
    for (const slug of slugs) {
      const root = join(codexRoot, "plugins", ".hobbyka-versions", `${slug}-old`);
      await mkdir(join(root, ".codex-plugin"), { recursive: true });
      await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: slug, version: "1.0.0" }));
      if (slug === "work-memory") {
        await writeFile(join(root, ".codex-plugin", "post-update.mjs"), "");
        await mkdir(join(root, "scripts"), { recursive: true });
        await writeFile(join(root, "scripts", "work-memory.ps1"), "");
      }
      plugins.push({ name: slug, source: { source: "local", path: `./plugins/.hobbyka-versions/${slug}-old` } });
    }
    await mkdir(join(codexRoot, ".agents", "plugins"), { recursive: true });
    await writeFile(join(codexRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "hobbyka-hub", plugins }));

    await mkdir(join(archiveRoot, ".codex-plugin"), { recursive: true });
    await mkdir(join(archiveRoot, "scripts"), { recursive: true });
    await writeFile(join(archiveRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "work-memory", version: "2.0.0" }));
    await writeFile(join(archiveRoot, ".codex-plugin", "post-update.mjs"), "");
    await writeFile(join(archiveRoot, "scripts", "work-memory.ps1"), "");
    const packed = spawnSync("zip", ["-qr", archive, "."], { cwd: archiveRoot });
    assert.equal(packed.status, 0);
    const archiveBytes = await readFile(archive);
    const archiveHash = createHash("sha256").update(archiveBytes).digest("hex");

    await writeFile(join(fixture, "platform-preload.mjs"), `Object.defineProperty(process, "platform", { value: "win32" });\n`);
    await writeFile(join(fixture, "codex"), `#!/bin/sh
case "$*" in
  '--version') printf 'codex 1.2.3\\n' ;;
  'plugin marketplace list --json') printf '%s\\n' '${JSON.stringify({ marketplaces: [{ name: "hobbyka-hub", root: codexRoot }] })}' ;;
  'plugin list --json')
    version=2.0.0
    grep -q 'work-memory-old' '${join(codexRoot, ".agents", "plugins", "marketplace.json")}' && version=1.0.0
    printf '{"installed":['
    separator=
    for slug in ${slugs.join(" ")}; do
      item_version=1.0.0
      [ "$slug" = work-memory ] && item_version=$version
      printf '%s{"name":"%s","version":"%s","installed":true,"marketplaceName":"hobbyka-hub"}' "$separator" "$slug" "$item_version"
      separator=,
    done
    printf ']}\\n'
    ;;
  exec*) printf '%s SessionStart PostToolUse\\n' '${slugs.join(" ")}' ;;
esac
`, { mode: 0o755 });
    await writeFile(join(fixture, "powershell.exe"), "#!/bin/sh\nprintf 'config missing for test\\n' >&2\nexit 1\n", { mode: 0o755 });
    await writeFile(join(fixture, "schtasks.exe"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(fixture, "tar.exe"), "#!/bin/sh\nexec /usr/bin/tar \"$@\"\n", { mode: 0o755 });
    await writeFile(join(fixture, "fetch-mock.mjs"), `
import { readFile } from "node:fs/promises";
const archive = ${JSON.stringify(archive)};
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("/repos/hobbyka-ru/hobbyka-hub-plugin/commits/main")) return new Response(JSON.stringify({ sha: ${JSON.stringify(publicRevision)} }));
  if (url.includes("raw.githubusercontent.com")) return new Response(JSON.stringify({ version: ${JSON.stringify(currentVersion)} }));
  if (url.endsWith("/api/health")) return new Response("ok");
  if (url.endsWith("/api/plugins")) return new Response(JSON.stringify({ plugins: [{ slug: "work-memory", version: "2.0.0" }] }));
  if (url.includes("/api/plugins/work-memory/download")) return new Response(await readFile(archive), { headers: { "x-hobbyka-sha256": ${JSON.stringify(archiveHash)}, "x-hobbyka-download-id": "runtime-rollback" } });
  if (url.includes("/api/downloads/runtime-rollback/confirm")) return new Response("ok");
  return new Response("not found", { status: 404 });
};
`);
    const result = await new Promise((done) => {
      const child = spawn(process.execPath, ["--import", join(fixture, "platform-preload.mjs"), "--import", join(fixture, "fetch-mock.mjs"), cli, "update", "--quiet"], {
        env: { ...process.env, HOME: fixture, LOCALAPPDATA: join(fixture, "Local App Data"), PATH: `${fixture}:${process.env.PATH ?? ""}`, HOBBYKA_CODEX_COMMAND: join(fixture, "codex"), HOBBYKA_HUB_CA_READY: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("close", (status) => done({ status, output }));
    });
    assert.notEqual(result.status, 0, result.output);
    const marketplace = JSON.parse(await readFile(join(codexRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
    const active = resolve(codexRoot, marketplace.plugins.find(({ name }) => name === "work-memory").source.path);
    assert.equal(JSON.parse(await readFile(join(active, ".codex-plugin", "plugin.json"), "utf8")).version, "1.0.0");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
