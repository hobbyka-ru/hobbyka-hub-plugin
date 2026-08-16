import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("reads Cyrillic report text from a UTF-8 body file", () => {
  const temp = mkdtempSync(join(tmpdir(), "hobbyka-report-"));
  try {
    const bodyFile = join(temp, "report.md");
    const body = "## Что произошло\n\nКириллица не должна превращаться в вопросы.";
    writeFileSync(bodyFile, body, "utf8");
    const output = execFileSync(process.execPath, [join(root, "bin", "hobbyka-hub.mjs"), "report-bug", "--body-file", bodyFile], {
      encoding: "utf8",
      env: { ...process.env, HOBBYKA_HUB_CA_READY: "1" },
    });
    const preview = JSON.parse(output);
    assert.equal(preview.effects.body_bytes, Buffer.byteLength(body));
    assert.equal(preview.effects.body_sha256, "40aa0c39ccc1b8e28bec3efc6146fe104da6b8b03b6fccb0ee0c54df8a6a2491");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("rejects stdin larger than 32 KB instead of silently truncating it", () => {
  const oversized = "A".repeat(32768) + " ";
  assert.throws(
    () => execFileSync(process.execPath, [join(root, "bin", "hobbyka-hub.mjs"), "report-bug", "--stdin"], {
      encoding: "utf8",
      input: oversized,
      env: { ...process.env, HOBBYKA_HUB_CA_READY: "1" },
    }),
    (error) => {
      assert.equal(error.status, 2);
      const out = JSON.parse(error.stdout);
      assert.equal(out.status, "failed");
      assert.equal(out.result.code, "invalid_report");
      return true;
    },
  );
});
