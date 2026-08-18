import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/hobbyka-hub.mjs", import.meta.url));

test("bootstrap schedules the updater from the just-installed Hub plugin (CR-334)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-updater-bootstrap-"));
  const source = join(fixture, "fresh-plugin");
  const archive = join(fixture, "hobbyka-hub.zip");
  const preload = join(fixture, "fetch-mock.mjs");
  const codex = join(fixture, "codex");
  const launchctl = join(fixture, "launchctl");
  const launchctlTrace = join(fixture, "launchctl.trace");

  try {
    await mkdir(join(source, ".codex-plugin"), { recursive: true });
    await mkdir(join(source, "bin"), { recursive: true });
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(source, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "hobbyka-hub", version: "9.9.9", description: "fresh" }), "utf8");
    await writeFile(join(source, "bin", "hobbyka-hub.mjs"), "#!/usr/bin/env node\n// CR-334-fresh-managed-updater\n", { mode: 0o755 });
    await writeFile(join(source, "assets", "hobbyka-chat-root.crt"), "fresh certificate\n", "utf8");
    const packed = await new Promise((resolve) => {
      const child = spawn("zip", ["-qr", archive, "."], { cwd: source, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => resolve({ status, stderr }));
    });
    assert.equal(packed.status, 0, packed.stderr);

    await writeFile(preload, `
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const archive = ${JSON.stringify(archive)};
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("api.github.com/repos/hobbyka-ru/hobbyka-hub-plugin/commits/main")) {
    return Response.json({ sha: "0123456789abcdef0123456789abcdef01234567" });
  }
  if (url.includes("raw.githubusercontent.com") && url.includes("/.codex-plugin/plugin.json")) {
    return Response.json({ name: "hobbyka-hub", version: "9.9.9", description: "fresh" });
  }
  if (url.includes("/api/plugins/hobbyka-hub/download")) {
    const bytes = await readFile(archive);
    return new Response(bytes, { headers: { "x-hobbyka-sha256": createHash("sha256").update(bytes).digest("hex"), "x-hobbyka-download-id": "cr334" } });
  }
  if (url.includes("/api/downloads/cr334/confirm")) return new Response("{}");
  if (url.endsWith("/api/plugins")) return Response.json({ plugins: [] });
  return new Response("not found", { status: 404 });
};
`, "utf8");
    await writeFile(codex, `#!/bin/sh
case "$*" in
  'plugin marketplace list --json') printf '%s\\n' '{"marketplaces":[]}' ;;
  'plugin list --json') printf '%s\\n' '{"installed":[{"name":"hobbyka-hub","installed":true,"marketplaceName":"hobbyka-hub","version":"9.9.9"}]}' ;;
esac
`, { mode: 0o755 });
    await writeFile(launchctl, `#!/bin/sh
printf '%s\\n' "$*" >> "$CR334_LAUNCHCTL_TRACE"
case "$1" in
  print) exit 1 ;;
esac
`, { mode: 0o755 });

    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", preload, cli, "install", "hobbyka-hub"], {
        env: {
          ...process.env,
          HOME: fixture,
          PATH: `${fixture}:${process.env.PATH ?? ""}`,
          HOBBYKA_CODEX_COMMAND: codex,
          HOBBYKA_HUB_CA_READY: "1",
          CR334_LAUNCHCTL_TRACE: launchctlTrace,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("close", (status) => resolve({ status, output }));
    });

    assert.equal(result.status, 0, result.output);
    assert.match(await readFile(join(fixture, ".codex", "hobbyka-hub-updater", "bin", "hobbyka-hub.mjs"), "utf8"), /CR-334-fresh-managed-updater/);
    assert.match(await readFile(launchctlTrace, "utf8"), /bootstrap/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
