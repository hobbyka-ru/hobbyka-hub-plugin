import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cli = new URL("../bin/hobbyka-hub.mjs", import.meta.url);

test("status uses the shared internal Hub hostname by default", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-hub-vpn-endpoint-"));
  try {
    await writeFile(join(fixture, "fetch-mock.mjs"), `
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url === "https://hub.hobbyka.internal/api/plugins") return new Response(JSON.stringify({ plugins: [{ slug: "sample" }] }));
  if (url === "https://hub.hobbyka.internal/api/profile") return new Response(JSON.stringify({ user: { identityId: "employee" } }));
  throw new Error("unexpected URL: " + url);
};
`);
    const child = spawn(process.execPath, ["--import", join(fixture, "fetch-mock.mjs"), cli.pathname, "status"], {
      env: { ...process.env, HOBBYKA_HUB_CA_READY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    const status = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(status, 0, Buffer.concat(output).toString("utf8"));
    assert.match(Buffer.concat(output).toString("utf8"), /employee.*плагинов: 1/s);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
