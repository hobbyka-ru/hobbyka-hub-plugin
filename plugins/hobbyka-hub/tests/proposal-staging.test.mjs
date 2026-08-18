import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/hobbyka-hub.mjs", import.meta.url));

test("proposal destination is published atomically and failed staging is retryable (CR-349)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-proposal-staging-"));
  const source = join(fixture, "source");
  const archive = join(fixture, "plugin.zip");
  const preload = join(fixture, "fetch-mock.mjs");
  const unzip = join(fixture, "unzip");
  const realUnzip = spawnSync("which", ["unzip"], { encoding: "utf8" }).stdout.trim();
  try {
    await mkdir(join(source, ".codex-plugin"), { recursive: true });
    await writeFile(join(source, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "atomic-plugin", version: "1.0.0", description: "Atomic proposal" }), "utf8");
    const archiveResult = spawnSync("zip", ["-qr", archive, "."], { cwd: source, encoding: "utf8" });
    assert.equal(archiveResult.status, 0, archiveResult.stderr);
    await writeFile(preload, `
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
globalThis.fetch = async (input) => {
  await appendFile(process.env.CR349_FETCH_TRACE, String(input) + "\\n");
  const bytes = await readFile(process.env.CR349_ARCHIVE);
  return new Response(bytes, { headers: {
    "x-hobbyka-sha256": createHash("sha256").update(bytes).digest("hex"),
    "x-hobbyka-github-commit": "0123456789abcdef0123456789abcdef01234567"
  } });
};
`, "utf8");
    await writeFile(unzip, `#!/bin/sh
if [ "$1" = "-q" ] && [ "$3" = "-d" ]; then
  if [ "$CR349_UNZIP_MODE" = "extract-failure" ]; then exit 7; fi
  "${realUnzip}" "$@"
  status=$?
  if [ $status -ne 0 ]; then exit $status; fi
  printf '%s\\n' "$4" >> "$CR349_EXTRACT_TARGET_TRACE"
  if [ "$CR349_UNZIP_MODE" = "marker-failure" ]; then mkdir "$4/.hobbyka-proposal.json"; fi
  exit 0
fi
exec "${realUnzip}" "$@"
`, { mode: 0o755 });

    const runPropose = (destination, extra = {}) => spawnSync(process.execPath, ["--import", preload, cli, "propose", "atomic-plugin", destination], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...extra,
        CR349_ARCHIVE: archive,
        CR349_EXTRACT_TARGET_TRACE: join(fixture, "extract-targets.trace"),
        CR349_FETCH_TRACE: join(fixture, `fetch-${basename(destination)}.trace`),
        HOBBYKA_HUB_CA_READY: "1",
      },
    });

    const markerFailureTarget = join(fixture, "marker-failure-proposal");
    const markerFailure = runPropose(markerFailureTarget, { PATH: `${fixture}:${process.env.PATH ?? ""}`, CR349_UNZIP_MODE: "marker-failure" });
    assert.notEqual(markerFailure.status, 0, markerFailure.stderr);
    await assert.rejects(() => access(markerFailureTarget), { code: "ENOENT" });

    const extractFailureTarget = join(fixture, "extract-failure-proposal");
    const extractFailure = runPropose(extractFailureTarget, { PATH: `${fixture}:${process.env.PATH ?? ""}`, CR349_UNZIP_MODE: "extract-failure" });
    assert.notEqual(extractFailure.status, 0, extractFailure.stderr);
    await assert.rejects(() => access(extractFailureTarget), { code: "ENOENT" });
    const extractedTargets = (await readFile(join(fixture, "extract-targets.trace"), "utf8")).trim().split(/\\r?\\n/);
    assert.ok(extractedTargets.length >= 1);
    assert.ok(extractedTargets.every((path) => path !== markerFailureTarget && path !== extractFailureTarget));
    assert.ok(extractedTargets.some((path) => path.includes(`.${basename(markerFailureTarget)}.staging-`)));

    const retry = runPropose(markerFailureTarget);
    assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
    assert.equal(JSON.parse(await readFile(join(markerFailureTarget, ".hobbyka-proposal.json"))).baseCommit, "0123456789abcdef0123456789abcdef01234567");
    const siblings = await readdir(fixture);
    assert.equal(siblings.some((name) => name.startsWith(`.${basename(markerFailureTarget)}.staging-`)), false);

    const existingTarget = join(fixture, "existing-proposal");
    await mkdir(existingTarget);
    await writeFile(join(existingTarget, "sentinel.txt"), "preserve me\n", "utf8");
    const existingTrace = join(fixture, "existing-target.trace");
    const existing = spawnSync(process.execPath, ["--import", preload, cli, "propose", "atomic-plugin", existingTarget], {
      encoding: "utf8",
      env: { ...process.env, CR349_ARCHIVE: archive, CR349_FETCH_TRACE: existingTrace, HOBBYKA_HUB_CA_READY: "1" },
    });
    assert.notEqual(existing.status, 0);
    assert.match(`${existing.stdout}\n${existing.stderr}`, /Папка уже существует/);
    assert.equal(await readFile(join(existingTarget, "sentinel.txt"), "utf8"), "preserve me\n");
    await assert.rejects(() => access(existingTrace), { code: "ENOENT" });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
