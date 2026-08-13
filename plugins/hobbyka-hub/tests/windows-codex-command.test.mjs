import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../bin/hobbyka-hub.mjs", import.meta.url), "utf8");

test("Windows Codex cmd shim uses cmd.exe without unsafe shell arguments", () => {
  const definition = source.match(/function windowsCommand\(executable, args\) \{[^\n]+\}/)?.[0];
  assert.ok(definition);
  const windowsCommand = Function("fail", `${definition}; return windowsCommand;`)((message) => { throw new Error(message); });
  assert.equal(
    windowsCommand("C:\\Program Files\\Codex\\codex.cmd", ["plugin", "add", "hobbyka-agent-chat@hobbyka-hub"]),
    '"C:\\Program Files\\Codex\\codex.cmd" "plugin" "add" "hobbyka-agent-chat@hobbyka-hub"',
  );
  assert.throws(() => windowsCommand("codex.cmd", ["plugin", "add", "bad&plugin"]), /небезопасный/);
  assert.match(source, /spawnSync\(process\.env\.ComSpec \?\? "cmd\.exe", \["\/d", "\/s", "\/c", command\]/);
  assert.match(source, /run\(codexCommand\(\), \["plugin", "marketplace", "add", "\."\], codexRoot\)/);
  assert.doesNotMatch(source, /spawnSync\(executable, args, \{[^\n]+shell:\s*true/);
});
