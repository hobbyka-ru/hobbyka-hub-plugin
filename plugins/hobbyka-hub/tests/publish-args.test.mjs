import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/hobbyka-hub.mjs", import.meta.url));

test("publish dispatch requires exactly one non-flag path before filesystem or network (CR-343)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-publish-args-"));
  const preload = join(fixture, "fetch-mock.mjs");
  try {
    await writeFile(preload, `
import { appendFile } from "node:fs/promises";
globalThis.fetch = async () => {
  await appendFile(process.env.CR343_TRACE, "upload reached\\n");
  return new Response("expected test rejection", { status: 500 });
};
`, "utf8");

    const missingTrace = join(fixture, "missing.trace");
    const missing = spawnSync(process.execPath, ["--import", preload, cli, "publish"], {
      encoding: "utf8",
      env: { ...process.env, CR343_TRACE: missingTrace, HOBBYKA_HUB_CA_READY: "1" },
    });
    assert.notEqual(missing.status, 0);
    assert.match(`${missing.stdout}\n${missing.stderr}`, /ровно один путь/);
    assert.doesNotMatch(`${missing.stdout}\n${missing.stderr}`, /ENOENT/);
    await assert.rejects(() => access(missingTrace), { code: "ENOENT" });

    const extraTrace = join(fixture, "extra.trace");
    const extra = spawnSync(process.execPath, ["--import", preload, cli, "publish", join(fixture, "does-not-exist"), "unexpected"], {
      encoding: "utf8",
      env: { ...process.env, CR343_TRACE: extraTrace, HOBBYKA_HUB_CA_READY: "1" },
    });
    assert.notEqual(extra.status, 0);
    assert.match(`${extra.stdout}\n${extra.stderr}`, /ровно один путь/);
    assert.doesNotMatch(`${extra.stdout}\n${extra.stderr}`, /ENOENT/);
    await assert.rejects(() => access(extraTrace), { code: "ENOENT" });

    const root = join(fixture, "valid-plugin");
    const validTrace = join(fixture, "valid.trace");
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "safe-plugin", version: "1.0.0", description: "Valid publish" }), "utf8");
    const valid = spawnSync(process.execPath, ["--import", preload, cli, "publish", root], {
      encoding: "utf8",
      env: { ...process.env, CR343_TRACE: validTrace, HOBBYKA_HUB_CA_READY: "1" },
    });
    assert.notEqual(valid.status, 0);
    assert.match(await readFile(validTrace, "utf8"), /upload reached/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
