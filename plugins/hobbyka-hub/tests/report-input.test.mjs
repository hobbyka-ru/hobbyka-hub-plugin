import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "node:http";

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

test("sends the reporting Codex thread so a missing Inbox can be bound", async () => {
  const operation = "550e8400-e29b-41d4-a716-446655440000";
  const thread = "550e8400-e29b-41d4-a716-446655440001";
  let requestBody;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requestBody = JSON.parse(body);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "550e8400-e29b-41d4-a716-446655440002", kind: "bug" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const child = spawn(process.execPath, [join(root, "bin", "hobbyka-hub.mjs"), "report-bug", "--stdin", "--operation", operation, "--confirm"], {
      env: { ...process.env, HOBBYKA_HUB_CA_READY: "1", HOBBYKA_AGENT_CHAT_URL: `http://127.0.0.1:${address.port}`, CODEX_THREAD_ID: thread },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end("Баг");
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, output);
    assert.equal(requestBody.target_thread_id, thread);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
