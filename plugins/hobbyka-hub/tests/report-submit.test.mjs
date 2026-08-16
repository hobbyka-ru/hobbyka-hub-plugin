import http from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

function runCLI(args, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, HOBBYKA_HUB_CA_READY: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
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

    const preview = JSON.parse((await runCLI(["idea", "--body-file", bodyA], { env })).stdout);
    assert.equal(preview.status, "ok");
    assert.equal(preview.effects.state, "planned");
    const operation = preview.effects.operation_id;
    assert.match(operation, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const previewAgain = JSON.parse((await runCLI(["idea", "--body-file", bodyA], { env })).stdout);
    assert.equal(previewAgain.effects.operation_id, operation, "operation must be bound to the previewed content");

    const confirm = await runCLI(["idea", "--body-file", bodyB, "--operation", operation, "--confirm"], { env });
    assert.equal(confirm.status, 2, "confirm with a different body must be rejected");
    const rejected = JSON.parse(confirm.stdout);
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.result.code, "invalid_operation");
    assert.equal(started.requests.length, 0, "no HTTP mutation must be sent for a mismatched confirm");
  } finally {
    if (httpServer) await closeServer(httpServer);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("null attachment response becomes a structured invalid_response with refs", async () => {
  const temp = mkdtempSync(join(tmpdir(), "hobbyka-null-"));
  let httpServer;
  try {
    const bodyFile = join(temp, "body.md");
    const attachFile = join(temp, "attach.bin");
    writeFileSync(bodyFile, "Текст", "utf8");
    writeFileSync(attachFile, "binary-content", "utf8");

    const started = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("null");
    });
    httpServer = started.server;
    const env = { HOBBYKA_AGENT_CHAT_URL: started.url };

    const preview = JSON.parse((await runCLI(["idea", "--body-file", bodyFile, "--file", attachFile], { env })).stdout);
    const operation = preview.effects.operation_id;

    const confirm = await runCLI(["idea", "--body-file", bodyFile, "--file", attachFile, "--operation", operation, "--confirm"], { env });
    assert.equal(confirm.status, 6, "null attachment response must be a structured failure, not an uncaught crash");
    const out = JSON.parse(confirm.stdout);
    assert.equal(out.status, "failed");
    assert.equal(out.result.code, "invalid_response");
    assert.ok(Array.isArray(out.refs) && out.refs.some((ref) => ref.type === "operation"), "operation refs must be preserved");
    assert.equal(started.requests.length, 1, "only the attachment upload was attempted");
    assert.match(started.requests[0].url, /\/agent\/v1\/attachments$/);
  } finally {
    if (httpServer) await closeServer(httpServer);
    rmSync(temp, { recursive: true, force: true });
  }
});
