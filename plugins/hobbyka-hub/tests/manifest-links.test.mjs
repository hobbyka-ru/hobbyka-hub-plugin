import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Hub manifest links point to Hub-owned pages", async () => {
  const manifest = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.interface.websiteURL, "https://10.8.1.0:8443/plugins/hobbyka-hub");
  assert.equal(manifest.interface.privacyPolicyURL, "https://github.com/hobbyka-ru/hobbyka-hub-plugin/blob/main/plugins/hobbyka-hub/PRIVACY.md");
  assert.equal(manifest.interface.termsOfServiceURL, "https://github.com/hobbyka-ru/hobbyka-hub-plugin/blob/main/plugins/hobbyka-hub/TERMS.md");
});
