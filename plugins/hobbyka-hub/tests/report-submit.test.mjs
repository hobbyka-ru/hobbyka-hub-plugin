import http from "node:http";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(root, "bin", "hobbyka-hub.mjs");
const ATTACHMENT_ID = "5d90568b-58d5-481d-8ef1-2d91cd904708";

function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, body });
      handler(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function runCLI(args, { input, env } = {}) {
  return execFileSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, HOBBYKA_HUB_CA_READY: "1", ...env },
  });
}

test("confirm rejects body that differs from the previewed one before any mutation", async () => {
  const temp = mkdtempSync(join(tmpdir(), "hobbyka-confirm-"));
  let httpServer;
  try {
    const bodyA = join(temp, "a.md");
    const bodyB = join(temp, "b.md");
    writeFileSync(bodyA, "Текст A", "utf8");
    writeFileSync(bodyB, "Текст B", "utf8");

    const started = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url.startsWith("/agent/v1/bug-reports") ? { id: ATTACHMENT_ID, kind: "idea" } : { id: ATTACHMENT_ID }));
    });
    httpServer = started.server;
    const env = { HOBBYKA_AGENT_CHAT_URL: started.url };

    const preview = JSON.parse(runCLI(["idea", "--body-file", bodyA], { env }));
    assert.equal(preview.status, "ok");
    assert.equal(preview.effects.state, "planned");
    const operation = preview.effects.operation_id;
    assert.match(operation, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const previewAgain = JSON.parse(runCLI(["idea", "--body-file", bodyA], { env }));
    assert.equal(previewAgain.effects.operation_id, operation, "operation must be bound to the previewed content");

    let rejectError;
    try {
      runCLI(["idea", "--body-file", bodyB, "--operation", operation, "--confirm"], { env });
    } catch (error) {
      rejectError = error;
    }
    assert.ok(rejectError, "confirm with a different body must be rejected");
    assert.equal(rejectError.status, 2);
    const rejected = JSON.parse(rejectError.stdout);
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.result.code, "invalid_operation");
    assert.equal(started.requests.length, 0, "no HTTP mutation must be sent for a mismatched confirm");
  } finally {
    httpServer?.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
