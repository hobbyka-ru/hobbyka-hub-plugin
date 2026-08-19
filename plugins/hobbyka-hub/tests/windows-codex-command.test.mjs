import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../bin/hobbyka-hub.mjs", import.meta.url), "utf8");

test("Windows Codex cmd shim uses cmd.exe without unsafe shell arguments", () => {
  const definition = source.match(/function windowsCommand\(executable, args\) \{[^\n]+\}/)?.[0];
  const shellDefinition = source.match(/function windowsShellRequired\(executable, os = platform\(\)\) \{[^\n]+\}/)?.[0];
  const spawnDefinition = source.match(/function spawnProcess\(executable, args, options\) \{[^\n]+\}/)?.[0];
  assert.ok(definition);
  assert.ok(shellDefinition);
  assert.ok(spawnDefinition);
  const windowsCommand = Function("fail", `${definition}; return windowsCommand;`)((message) => { throw new Error(message); });
  assert.equal(
    windowsCommand("C:\\Program Files\\Codex\\codex.cmd", ["plugin", "add", "hobbyka-agent-chat@hobbyka-hub"]),
    '"C:\\Program Files\\Codex\\codex.cmd" "plugin" "add" "hobbyka-agent-chat@hobbyka-hub"',
  );
  assert.throws(() => windowsCommand("codex.cmd", ["plugin", "add", "bad&plugin"]), /небезопасный/);
  const calls = [];
  const spawnProcess = Function("spawnSync", "platform", "basename", "fail", "process", `${definition}\n${shellDefinition}\n${spawnDefinition}\nreturn spawnProcess;`)(
    (...args) => { calls.push(args); return { status: 0 }; },
    () => "win32",
    (path) => path.split(/[\\/]/).at(-1),
    (message) => { throw new Error(message); },
    { env: { ComSpec: "cmd.exe" } },
  );
  spawnProcess("codex.cmd", ["plugin", "list", "--json"], { encoding: "utf8" });
  assert.deepEqual(calls[0].slice(0, 2), [
    "cmd.exe",
    ["/d", "/s", "/c", '"codex.cmd" "plugin" "list" "--json"'],
  ]);
  assert.match(source, /run\(codexCommand\(\), \["plugin", "marketplace", "add", "\."\], codexRoot\)/);
  assert.doesNotMatch(source, /spawnSync\(executable, args, \{[^\n]+shell:\s*true/);
});

test("Windows Task Scheduler runs directly without cmd.exe quoting", () => {
  const definition = source.match(/function windowsShellRequired\(executable, os = platform\(\)\) \{[^\n]+\}/)?.[0];
  assert.ok(definition);
  const windowsShellRequired = Function("platform", "basename", `${definition}; return windowsShellRequired;`)(
    () => "darwin",
    (path) => path.split(/[\\/]/).at(-1),
  );
  assert.equal(windowsShellRequired("schtasks.exe", "win32"), false);
  assert.equal(windowsShellRequired("C:\\Windows\\System32\\schtasks.exe", "win32"), false);
  assert.equal(windowsShellRequired("tar.exe", "win32"), false);
  assert.equal(windowsShellRequired("schtasks.exe", "darwin"), false);
});

test("Windows auto-update task safely carries a quoted launcher path", () => {
  const definition = source.match(/function windowsTaskAction\(launcher\) \{[^\n]+\}/)?.[0];
  assert.ok(definition);
  const windowsTaskAction = Function("Buffer", `${definition}; return windowsTaskAction;`)(Buffer);
  const action = windowsTaskAction("C:\\Users\\O'Brien Name\\.codex\\hobbyka-hub-updater\\update-hidden.vbs");
  assert.equal(
    action,
    'wscript.exe "C:\\Users\\O\'Brien Name\\.codex\\hobbyka-hub-updater\\update-hidden.vbs"',
  );
  assert.ok(action.length <= 261);
});
