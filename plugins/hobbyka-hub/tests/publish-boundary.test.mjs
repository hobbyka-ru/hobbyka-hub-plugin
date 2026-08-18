import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/hobbyka-hub.mjs", import.meta.url));

test("publish validates manifest slug before creating an archive path (CR-342)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-publish-boundary-"));
  const root = join(fixture, "plugin");
  const preload = join(fixture, "fetch-mock.mjs");
  const traversalTrace = join(fixture, "traversal-fetch.trace");
  const validTrace = join(fixture, "valid-fetch.trace");
  const escaped = join(tmpdir(), `${basename(fixture)}-escaped.zip`);
  try {
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await writeFile(preload, `
import { appendFile } from "node:fs/promises";
globalThis.fetch = async () => {
  await appendFile(process.env.CR342_TRACE, "unexpected upload\\n");
  return new Response("expected test rejection", { status: 500 });
};
`, "utf8");

    await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: `../${basename(fixture)}-escaped`, version: "1.0.0", description: "Traversal regression" }), "utf8");
    const traversal = spawnSync(process.execPath, ["--import", preload, cli, "publish", root], {
      encoding: "utf8",
      env: { ...process.env, CR342_TRACE: traversalTrace, HOBBYKA_HUB_CA_READY: "1" },
    });
    assert.notEqual(traversal.status, 0, "traversal manifest unexpectedly succeeded");
    assert.match(`${traversal.stdout}\n${traversal.stderr}`, /Некорректный slug/);
    await assert.rejects(() => access(traversalTrace), { code: "ENOENT" });
    await assert.rejects(() => access(escaped), { code: "ENOENT" });

    await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "safe-plugin", version: "1.0.0", description: "Valid publish" }), "utf8");
    const valid = spawnSync(process.execPath, ["--import", preload, cli, "publish", root], {
      encoding: "utf8",
      env: { ...process.env, CR342_TRACE: validTrace, HOBBYKA_HUB_CA_READY: "1" },
    });
    assert.notEqual(valid.status, 0, "test upload rejection unexpectedly succeeded");
    assert.match(await readFile(validTrace, "utf8"), /unexpected upload/);
  } finally {
    await rm(escaped, { force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});
