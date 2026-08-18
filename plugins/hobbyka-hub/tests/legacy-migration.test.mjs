import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/hobbyka-hub.mjs", import.meta.url));
const currentVersion = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8")).version;

test("failed legacy migration keeps the working registration (CR-332)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-hub-cr332-"));
  const fetchMock = join(fixture, "fetch-mock.mjs");
  const codex = join(fixture, "codex");
  const trace = join(fixture, "codex.trace");

  await writeFile(fetchMock, `
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("raw.githubusercontent.com")) {
    return new Response(JSON.stringify({ version: ${JSON.stringify(currentVersion)} }), {
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("/archive/refs/heads/main.zip")) {
    return new Response("upstream unavailable", { status: 503 });
  }
  if (url.endsWith("/api/plugins")) {
    return new Response(JSON.stringify({
      plugins: [{ slug: "legacy", version: "1.0.0" }],
    }), { headers: { "content-type": "application/json" } });
  }
  if (url.includes("/api/plugins/legacy/download")) {
    throw new Error("download unavailable");
  }
  return new Response("not found", { status: 404 });
};
`, "utf8");
  await writeFile(codex, `#!/bin/sh
printf '%s\\n' "$*" >> "$HOBBYKA_CR332_TRACE"
case "$*" in
  'plugin list --json')
    printf '%s\\n' '{"installed":[{"name":"legacy","installed":true,"marketplaceName":"hobbyka","version":"1.0.0"}]}'
    ;;
  'plugin marketplace list --json')
    printf '%s\\n' '{"marketplaces":[]}'
    ;;
esac
`, "utf8");
  await chmod(codex, 0o755);

  try {
    const result = spawnSync(process.execPath, [
      "--import", fetchMock, cli, "update", "--quiet",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOBBYKA_CODEX_COMMAND: codex,
        HOBBYKA_CR332_TRACE: trace,
        HOBBYKA_HUB_CA_READY: "1",
      },
    });

    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Установленные плагины из ХАБа уже актуальны/);
    let commands = "";
    try { commands = await readFile(trace, "utf8"); } catch (error) { assert.equal(error.code, "ENOENT"); }
    assert.doesNotMatch(commands, /plugin remove legacy@hobbyka/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
