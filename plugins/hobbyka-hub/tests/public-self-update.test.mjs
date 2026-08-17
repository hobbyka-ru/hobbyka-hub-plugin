import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/hobbyka-hub.mjs", import.meta.url));
const revision = "0123456789abcdef0123456789abcdef01234567";

test("public self-update rejects an archive whose manifest differs from the pinned commit (CR-339)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-public-self-update-"));
  const oldRoot = join(fixture, ".codex", "hobbyka-hub-marketplace", "plugins", "hobbyka-hub");
  const publicRoot = join(fixture, `hobbyka-hub-plugin-${revision}`);
  const archive = join(fixture, "hobbyka-hub-public.zip");
  const preload = join(fixture, "fetch-mock.mjs");
  const codex = join(fixture, "codex");
  const launchctl = join(fixture, "launchctl");
  const trace = join(fixture, "fetch.trace");
  try {
    await mkdir(join(oldRoot, ".codex-plugin"), { recursive: true });
    await writeFile(join(oldRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "hobbyka-hub", version: "1.0.0", description: "old" }), "utf8");
    await mkdir(join(publicRoot, "plugins", "hobbyka-hub", ".codex-plugin"), { recursive: true });
    await mkdir(join(publicRoot, "plugins", "hobbyka-hub", "bin"), { recursive: true });
    await mkdir(join(publicRoot, "plugins", "hobbyka-hub", "assets"), { recursive: true });
    await writeFile(join(publicRoot, "plugins", "hobbyka-hub", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "hobbyka-hub", version: "3.0.0", description: "archive mismatch" }), "utf8");
    await writeFile(join(publicRoot, "plugins", "hobbyka-hub", "bin", "hobbyka-hub.mjs"), "#!/usr/bin/env node\n", { mode: 0o755 });
    await writeFile(join(publicRoot, "plugins", "hobbyka-hub", "assets", "hobbyka-chat-root.crt"), "certificate\n", "utf8");
    const packed = spawnSync("zip", ["-qr", archive, `hobbyka-hub-plugin-${revision}`], { cwd: fixture, encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);

    await writeFile(preload, `
import { appendFile, readFile } from "node:fs/promises";
const archive = ${JSON.stringify(archive)};
const trace = ${JSON.stringify(trace)};
globalThis.fetch = async (input) => {
  const url = String(input);
  await appendFile(trace, url + "\\n");
  if (url.includes("/repos/hobbyka-ru/hobbyka-hub-plugin/commits/main")) return new Response(JSON.stringify({ sha: ${JSON.stringify(revision)} }));
  if (url.includes("raw.githubusercontent.com")) return new Response(JSON.stringify({ version: "2.0.0" }));
  if (url.includes("/archive/${revision}.zip") || url.includes("/archive/refs/heads/main.zip")) return new Response(await readFile(archive));
  if (url.endsWith("/api/plugins")) return new Response(JSON.stringify({ plugins: [] }));
  return new Response("not found", { status: 404 });
};
`, "utf8");
    await writeFile(codex, `#!/bin/sh
case "$*" in
  'plugin list --json') printf '%s\\n' '{"installed":[]}' ;;
  'plugin marketplace list --json') printf '%s\\n' '{"marketplaces":[]}' ;;
  'plugin add'*) exit 0 ;;
esac
`, { mode: 0o755 });
    await writeFile(launchctl, `#!/bin/sh
case "$1" in
  print) exit 1 ;;
  bootstrap) exit 0 ;;
esac
`, { mode: 0o755 });

    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", preload, cli, "update", "--quiet"], {
        env: {
          ...process.env,
          HOME: fixture,
          PATH: `${fixture}:${process.env.PATH ?? ""}`,
          HOBBYKA_CODEX_COMMAND: codex,
          HOBBYKA_HUB_CA_READY: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("close", (status) => resolve({ status, output }));
    });

    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /Архив Hobbyka Hub|manifest|commit/);
    const requests = await readFile(trace, "utf8");
    assert.match(requests, new RegExp(`raw\\.githubusercontent\\.com/hobbyka-ru/hobbyka-hub-plugin/${revision}/`));
    assert.match(requests, new RegExp(`/archive/${revision}\\.zip`));
    assert.doesNotMatch(requests, /archive\/refs\/heads\/main\.zip/);
    assert.doesNotMatch(requests, /plugin add hobbyka-hub@hobbyka-hub/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
