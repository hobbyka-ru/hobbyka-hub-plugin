import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/hobbyka-hub.mjs", import.meta.url));

test("self-update preserves a loaded macOS LaunchAgent without booting out its own process (CR-335)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-self-update-launchagent-"));
  const publicRoot = join(fixture, "hobbyka-hub-plugin-main");
  const archive = join(fixture, "hobbyka-hub-public.zip");
  const preload = join(fixture, "fetch-mock.mjs");
  const codex = join(fixture, "codex");
  const launchctl = join(fixture, "launchctl");
  const launchctlTrace = join(fixture, "launchctl.trace");
  const marketplaceRoot = join(fixture, ".codex", "hobbyka-hub-marketplace");

  try {
    await mkdir(join(marketplaceRoot, "plugins", "hobbyka-hub", ".codex-plugin"), { recursive: true });
    await writeFile(join(marketplaceRoot, "plugins", "hobbyka-hub", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "hobbyka-hub", version: "1.0.0", description: "old" }), "utf8");
    await mkdir(join(publicRoot, "plugins", "hobbyka-hub", ".codex-plugin"), { recursive: true });
    await mkdir(join(publicRoot, "plugins", "hobbyka-hub", "bin"), { recursive: true });
    await mkdir(join(publicRoot, "plugins", "hobbyka-hub", "assets"), { recursive: true });
    await writeFile(join(publicRoot, "plugins", "hobbyka-hub", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "hobbyka-hub", version: "2.0.0", description: "public update" }), "utf8");
    await writeFile(join(publicRoot, "plugins", "hobbyka-hub", "bin", "hobbyka-hub.mjs"), "#!/usr/bin/env node\n// CR-335-public-update\n", { mode: 0o755 });
    await writeFile(join(publicRoot, "plugins", "hobbyka-hub", "bin", "marketplace-state.mjs"), "// managed updater dependency\n", "utf8");
    await writeFile(join(publicRoot, "plugins", "hobbyka-hub", "assets", "hobbyka-chat-root.crt"), "public certificate\n", "utf8");
    const packed = spawnSync("zip", ["-qr", archive, "hobbyka-hub-plugin-main"], { cwd: fixture, encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);

    await writeFile(preload, `
import { readFile } from "node:fs/promises";
const archive = ${JSON.stringify(archive)};
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("/repos/hobbyka-ru/hobbyka-hub-plugin/commits/main")) return new Response(JSON.stringify({ sha: "0123456789abcdef0123456789abcdef01234567" }));
  if (url.includes("raw.githubusercontent.com")) return new Response(JSON.stringify({ version: "2.0.0" }));
  if (url.includes("/archive/")) return new Response(await readFile(archive));
  if (url.endsWith("/api/plugins")) return new Response(JSON.stringify({ plugins: [] }));
  return new Response("not found", { status: 404 });
};
`, "utf8");
    await writeFile(codex, `#!/bin/sh
case "$*" in
  'plugin list --json') printf '%s\\n' '{"installed":[]}' ;;
  'plugin marketplace list --json') printf '%s\\n' '{"marketplaces":[]}' ;;
esac
`, { mode: 0o755 });
    await writeFile(launchctl, `#!/bin/sh
printf '%s\\n' "$*" >> "$CR335_LAUNCHCTL_TRACE"
case "$1" in
  print) exit 0 ;;
  bootout) kill -TERM "$PPID" ;;
  kickstart|bootstrap) exit 0 ;;
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
          CR335_LAUNCHCTL_TRACE: launchctlTrace,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("close", (status, signal) => resolve({ status, signal, output }));
    });

    assert.equal(result.status, 0, `${result.signal ?? ""}\n${result.output}`);
    const trace = await readFile(launchctlTrace, "utf8");
    assert.match(trace, /print/);
    assert.doesNotMatch(trace, /bootout/);
    assert.doesNotMatch(trace, /kickstart/);
    assert.doesNotMatch(trace, /bootstrap/);
    const marketplace = JSON.parse(await readFile(join(fixture, ".codex", "hobbyka-hub-marketplace", ".agents", "plugins", "marketplace.json"), "utf8"));
    const activePath = resolve(marketplaceRoot, marketplace.plugins.find(({ name }) => name === "hobbyka-hub").source.path);
    assert.match(await readFile(join(activePath, ".codex-plugin", "plugin.json"), "utf8"), /"version":"2\.0\.0"/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
