import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../bin/hobbyka-hub.mjs", import.meta.url), "utf8");

test("Windows archive listing is emitted as UTF-8", () => {
  const definition = source.match(/function isSafeEntry\(entry\) \{[^\n]+\}/)?.[0];
  assert.ok(definition);
  const isSafeEntry = Function(`${definition}; return isSafeEntry;`)();
  const wronglyDecoded = Buffer.from(".codex-plugin/plugin.json\r\n", "utf16le").toString("utf8");
  assert.equal(wronglyDecoded.trim().split(/\r?\n/).some((entry) => !isSafeEntry(entry)), true);
  assert.match(source, /\[Console\]::OutputEncoding = \[Text\.UTF8Encoding\]::new\(\$false\)/);
});
