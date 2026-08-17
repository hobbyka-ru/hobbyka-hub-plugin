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

test("canonicalizes UUID case before attachment and report replay", async () => {
  const temp = mkdtempSync(join(tmpdir(), "hobbyka-uuid-case-"));
  let httpServer;
  try {
    const bodyA = join(temp, "a.md");
    const bodyB = join(temp, "b.md");
    const attachment = join(temp, "attach.bin");
    writeFileSync(bodyA, "Один отчёт", "utf8");
    writeFileSync(bodyB, "Другой отчёт", "utf8");
    writeFileSync(attachment, "binary-content", "utf8");

    const attachmentOperations = [];
    const reportBodies = [];
    const uploadedByOperation = new Set();
    const started = await startServer((req, res, body) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/agent/v1/attachments") {
        const operation = req.headers["x-hobbyka-operation-id"];
        attachmentOperations.push(operation);
        const firstUpload = !uploadedByOperation.has(operation);
        uploadedByOperation.add(operation);
        res.writeHead(200);
        res.end(JSON.stringify({ id: firstUpload ? ATTACHMENT_ID : ATTACHMENT_ID.toUpperCase() }));
        return;
      }
      if (req.url === "/agent/v1/bug-reports") {
        reportBodies.push(JSON.parse(body));
        res.writeHead(200);
        res.end(JSON.stringify({ id: reportBodies.length === 1 ? ATTACHMENT_ID : ATTACHMENT_ID.toUpperCase(), kind: "idea" }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    });
    httpServer = started.server;
    const env = { HOBBYKA_AGENT_CHAT_URL: started.url };

    const preview = JSON.parse((await runCLI(["idea", "--body-file", bodyA, "--file", attachment], { env })).stdout);
    assert.equal(preview.status, "ok");
    const operation = preview.effects.operation_id;
    const upperOperation = operation.toUpperCase();

    const upperPreview = await runCLI(["idea", "--body-file", bodyA, "--file", attachment, "--operation", upperOperation], { env });
    assert.equal(upperPreview.status, 0, "case-only operation changes must remain valid");
    const upperPreviewJSON = JSON.parse(upperPreview.stdout);
    assert.deepEqual(upperPreviewJSON.effects, preview.effects, "same UUID case must keep the report fingerprint and child operation IDs");

    const lowerConfirm = await runCLI(["idea", "--body-file", bodyA, "--file", attachment, "--operation", operation, "--confirm"], { env });
    assert.equal(lowerConfirm.status, 0);
    const upperConfirm = await runCLI(["idea", "--body-file", bodyA, "--file", attachment, "--operation", upperOperation, "--confirm"], { env });
    assert.equal(upperConfirm.status, 0, "uppercase replay must use the same operation");
    assert.equal(attachmentOperations.length, 2, "both confirmations should reach the idempotent upload boundary");
    assert.match(attachmentOperations[0], /^[0-9a-f-]+$/, "upload operation must be canonical lowercase UUID");
    assert.equal(new Set(attachmentOperations).size, 1, "case-only replay must not create a second upload operation");
    assert.equal(uploadedByOperation.size, 1, "case-only replay must be one logical upload");
    assert.equal(reportBodies.length, 2, "both confirmations should reach the report boundary");
    assert.deepEqual(reportBodies[1], reportBodies[0], "case-only replay must keep one report fingerprint");
    assert.equal(JSON.parse(upperConfirm.stdout).result.id, ATTACHMENT_ID, "response UUIDs must be exposed canonically");

    const distinctPreview = JSON.parse((await runCLI(["idea", "--body-file", bodyB, "--file", attachment], { env })).stdout);
    assert.notEqual(distinctPreview.effects.operation_id, operation, "distinct report UUIDs must remain distinct");
    assert.notEqual(distinctPreview.effects.files[0].operation_id, preview.effects.files[0].operation_id, "distinct report UUIDs need distinct child operations");

    const beforeInvalid = started.requests.length;
    const invalid = await runCLI(["idea", "--body-file", bodyA, "--file", attachment, "--operation", "not-a-uuid", "--confirm"], { env });
    assert.equal(invalid.status, 2);
    assert.equal(JSON.parse(invalid.stdout).result.code, "invalid_arguments");
    assert.equal(started.requests.length, beforeInvalid, "invalid UUID must be rejected before HTTP");
  } finally {
    if (httpServer) await closeServer(httpServer);
    rmSync(temp, { recursive: true, force: true });
  }
});
