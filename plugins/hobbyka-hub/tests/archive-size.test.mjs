import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/hobbyka-hub.mjs", import.meta.url));
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

test("publish and proposal reject oversized archives before read/upload (CR-344)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-archive-size-"));
  const root = join(fixture, "plugin");
  const fakeZip = join(fixture, "zip");
  const preload = join(fixture, "fetch-mock.mjs");
  const oversizedTrace = join(fixture, "oversized.trace");
  try {
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "size-plugin", version: "1.0.0", description: "Archive size regression" }), "utf8");
    await writeFile(join(root, ".hobbyka-proposal.json"), JSON.stringify({ slug: "size-plugin", baseCommit: "0123456789abcdef0123456789abcdef01234567" }), "utf8");
    await writeFile(fakeZip, `#!/bin/sh
node -e 'require("node:fs").writeFileSync(process.argv[1], ""); require("node:fs").truncateSync(process.argv[1], ${MAX_ARCHIVE_BYTES + 1})' "$2"
`, "utf8");
    await chmod(fakeZip, 0o755);
    await writeFile(preload, `
import { appendFile } from "node:fs/promises";
globalThis.fetch = async () => {
  await appendFile(process.env.CR344_TRACE, "upload reached\\n");
  return new Response("unexpected upload", { status: 500 });
};
`, "utf8");

    for (const args of [["publish", root], ["propose", root, "--submit"]]) {
      const result = spawnSync(process.execPath, ["--import", preload, cli, ...args], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fixture}:${process.env.PATH ?? ""}`, CR344_TRACE: oversizedTrace, HOBBYKA_HUB_CA_READY: "1" },
      });
      assert.notEqual(result.status, 0, `${args[0]} unexpectedly succeeded`);
      assert.match(`${result.stdout}\n${result.stderr}`, /256 МБ|размер/i);
      await assert.rejects(() => access(oversizedTrace), { code: "ENOENT" });
    }

    const validTrace = join(fixture, "valid.trace");
    for (const args of [["publish", root], ["propose", root, "--submit"]]) {
      const result = spawnSync(process.execPath, ["--import", preload, cli, ...args], {
        encoding: "utf8",
        env: { ...process.env, CR344_TRACE: validTrace, HOBBYKA_HUB_CA_READY: "1" },
      });
      assert.notEqual(result.status, 0, `${args[0]} upload double unexpectedly succeeded`);
    }
    assert.match(await readFile(validTrace, "utf8"), /upload reached/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
