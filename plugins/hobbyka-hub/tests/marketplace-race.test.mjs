import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = process.env.CR333_CLI ? resolve(process.env.CR333_CLI) : fileURLToPath(new URL("../bin/hobbyka-hub.mjs", import.meta.url));

test("parallel updates keep every installed plugin in marketplace state (CR-333)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-marketplace-race-"));
  const preload = join(fixture, "fetch-mock.mjs");
  const codex = join(fixture, "codex");
  const archives = {};

  try {
    const manifest = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"));
    for (const slug of ["alpha", "beta"]) {
      const source = join(fixture, slug);
      await mkdir(join(source, ".codex-plugin"), { recursive: true });
      await writeFile(join(source, ".codex-plugin", "plugin.json"), JSON.stringify({ name: slug, version: "2.0.0", description: slug }), "utf8");
      const archive = join(fixture, `${slug}.zip`);
      const packed = spawnSync("zip", ["-qr", archive, "."], { cwd: source, encoding: "utf8" });
      assert.equal(packed.status, 0, packed.stderr);
      archives[slug] = archive;
    }
    await writeFile(preload, `
import { readFile } from "node:fs/promises";
const archives = ${JSON.stringify(archives)};
const manifestVersion = ${JSON.stringify(manifest.version)};
globalThis.fetch = async (input) => {
  const url = String(input);
  const slug = process.env.CR333_SLUG;
  if (url.includes("/repos/hobbyka-ru/hobbyka-hub-plugin/commits/main")) return new Response(JSON.stringify({ sha: "0123456789abcdef0123456789abcdef01234567" }));
  if (url.includes("raw.githubusercontent.com")) return new Response(JSON.stringify({ version: manifestVersion }));
  if (url.endsWith("/api/plugins")) return new Response(JSON.stringify({ plugins: [{ slug, version: "2.0.0" }] }));
  if (url.includes("/api/plugins/" + slug + "/download")) {
    const bytes = await readFile(archives[slug]);
    const digest = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    return new Response(bytes, { headers: { "x-hobbyka-sha256": digest, "x-hobbyka-download-id": slug } });
  }
  if (url.includes("/api/downloads/") && url.endsWith("/confirm")) return new Response("{}");
  return new Response("not found", { status: 404 });
};
`, "utf8");
    await writeFile(codex, `#!/bin/sh
case "$*" in
  'plugin list --json') printf '%s\\n' '{"installed":[{"name":"'"$CR333_SLUG"'","installed":true,"marketplaceName":"hobbyka-hub","version":"1.0.0"}]}' ;;
  'plugin marketplace list --json') printf '%s\\n' '{"marketplaces":[]}' ;;
esac
`, "utf8");
    await chmod(codex, 0o755);

    const runUpdate = (slug) => new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", preload, cli, "update", "--quiet"], {
        env: { ...process.env, HOME: fixture, CR333_SLUG: slug, HOBBYKA_CODEX_COMMAND: codex, HOBBYKA_HUB_CA_READY: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("close", (status) => resolve({ slug, status, output }));
    });

    const results = await Promise.all([runUpdate("alpha"), runUpdate("beta")]);
    assert.deepEqual(results.map(({ status }) => status), [0, 0], results.map(({ slug, output }) => `${slug}: ${output}`).join("\n"));
    const marketplaceRoot = join(fixture, ".codex", "hobbyka-hub-marketplace");
    const marketplace = JSON.parse(await readFile(join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
    assert.deepEqual(marketplace.plugins.map(({ name }) => name).sort(), ["alpha", "beta", "hobbyka-hub"]);
    const oldAlphaPath = resolve(marketplaceRoot, marketplace.plugins.find(({ name }) => name === "alpha").source.path);
    const oldAlphaManifest = await readFile(join(oldAlphaPath, ".codex-plugin", "plugin.json"), "utf8");
    const repeat = await runUpdate("alpha");
    assert.equal(repeat.status, 0, repeat.output);
    const switched = JSON.parse(await readFile(join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
    const newAlphaPath = resolve(marketplaceRoot, switched.plugins.find(({ name }) => name === "alpha").source.path);
    assert.notEqual(newAlphaPath, oldAlphaPath);
    assert.equal(await readFile(join(oldAlphaPath, ".codex-plugin", "plugin.json"), "utf8"), oldAlphaManifest);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
