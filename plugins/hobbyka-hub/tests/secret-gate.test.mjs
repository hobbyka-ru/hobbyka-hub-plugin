import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/hobbyka-hub.mjs", import.meta.url));

test("publish and proposal submission gate local secret names before upload (CR-341)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-secret-gate-"));
  const preload = join(fixture, "fetch-mock.mjs");
  const cases = [
    { name: ".env", content: "TOKEN=must-not-upload\n", rejected: true },
    { name: ".env.local", content: "TOKEN=must-not-upload\n", rejected: true },
    { name: "keys/private.key", content: "private-key-must-not-upload\n", rejected: true },
    { name: "keys/server.key", content: "private-key-must-not-upload\n", rejected: true },
    { name: "keys/client.p12", content: "private-certificate-must-not-upload\n", rejected: true },
    { name: "keys/id_ed25519", content: "private-key-must-not-upload\n", rejected: true },
    { name: ".env.example", content: "TOKEN=replace-me\n", rejected: false },
    { name: "public.pem", content: "public certificate\n", rejected: false },
  ];
  try {
    await writeFile(preload, `
import { appendFile } from "node:fs/promises";
globalThis.fetch = async () => {
  await appendFile(process.env.CR341_TRACE, "unexpected upload\\n");
  return new Response("unexpected upload", { status: 500 });
};
`, "utf8");
    for (const [index, secret] of cases.entries()) {
      const root = join(fixture, `plugin-${index}`);
      await mkdir(join(root, ".codex-plugin"), { recursive: true });
      if (secret.name.includes("/")) await mkdir(join(root, secret.name.slice(0, secret.name.lastIndexOf("/"))), { recursive: true });
      await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "secret-plugin", version: "1.0.0", description: "Secret gate regression" }), "utf8");
      await writeFile(join(root, secret.name), secret.content, "utf8");
      await writeFile(join(root, "README.md"), "safe\n", "utf8");
      await writeFile(join(root, ".hobbyka-proposal.json"), JSON.stringify({ slug: "secret-plugin", baseCommit: "0123456789abcdef0123456789abcdef01234567" }), "utf8");
      for (const args of [["publish", root], ["propose", root, "--submit"]]) {
        const trace = join(fixture, `fetch-${index}-${args[0]}.trace`);
        const result = spawnSync(process.execPath, ["--import", preload, cli, ...args], {
          encoding: "utf8",
          env: { ...process.env, CR341_TRACE: trace, HOBBYKA_HUB_CA_READY: "1" },
        });
        assert.notEqual(result.status, 0, `${args[0]} unexpectedly succeeded for ${secret.name}`);
        if (secret.rejected) {
          assert.match(`${result.stdout}\n${result.stderr}`, /запрещённ|секрет/i);
          await assert.rejects(() => readFile(trace, "utf8"), { code: "ENOENT" });
        } else {
          assert.match(`${result.stdout}\n${result.stderr}`, /unexpected upload/);
          assert.match(await readFile(trace, "utf8"), /unexpected upload/);
        }
      }
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
