import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "bin", "hobbyka-hub.mjs");

test("publish sends normalized manifest keywords as a JSON tag array", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-hub-tags-"));
  const manifestDirectory = join(fixture, ".codex-plugin");
  await mkdir(manifestDirectory);
  await writeFile(join(manifestDirectory, "plugin.json"), JSON.stringify({
    name: "tag-fixture",
    version: "0.0.1",
    description: "Tag fixture",
    keywords: [" для личных целей ", "покупки", "покупки", "", 42],
    interface: { category: "Shopping" }
  }));

  let submittedTags;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const form = await new Request("http://127.0.0.1/api/plugins", {
      method: request.method,
      headers: request.headers,
      body: Buffer.concat(chunks)
    }).formData();
    submittedTags = JSON.parse(form.get("tags"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    const child = spawn(process.execPath, [cli, "publish", fixture], {
      env: {
        ...process.env,
        HOBBYKA_HUB_CA_READY: "1",
        HOBBYKA_HUB_URL: `http://127.0.0.1:${port}`
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const [exitCode] = await once(child, "close");
    assert.equal(exitCode, 0, Buffer.concat(stderr).toString("utf8"));
    assert.deepEqual(submittedTags, ["для личных целей", "покупки"]);
  } finally {
    server.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
