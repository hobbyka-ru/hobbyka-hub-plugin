# Bug Reproducer

## ✅ FIX_PROVEN — Bug reproduced and fix proven

> The same reproducer changed from failing to passing and broader checks passed.

**Project:** Hobbyka Hub  
**Bug:** Windows PowerShell output makes safe plugin paths look unsafe  
**Environment:** macOS arm64 reproducer simulating Windows PowerShell 5.1 UTF-16LE output; live windows-amd64 archive inspected  
**Generated:** 2026-08-13

## Original report

On Windows, Hobbyka Hub 0.4.22 fails to install onec-direct-cli with: В архиве найден небезопасный путь.

| Contract | Expected | Actual |
|---|---|---|
| Observed behavior | The safe onec-direct-cli archive installs on Windows. | Windows PowerShell output decoded as UTF-8 contains NUL bytes and is rejected by the archive path guard. |

## Minimal reproduction

The focused test passes a safe ZIP entry through the same UTF-16LE-to-UTF-8 mismatch and verifies that the production guard rejects it.

**Confirming signal:** The regression test exits 1 because the Windows PowerShell command does not explicitly emit UTF-8.

### Reproduction files

- [windows-archive-output.test.mjs](/Users/ardanila/code/hobbyka-ru/_worktrees/fix-windows-archive-encoding-20260813/plugins/hobbyka-hub/tests/windows-archive-output.test.mjs:1) — Focused Windows encoding regression test.

## Red to green evidence

| Evidence | Before fix | After fix |
|---|---:|---:|
| Exit code | 1 | 0 |
| Timed out | False | False |
| Duration | 85.652 ms | 76.618 ms |
| Same command | — | True |
| Broader suite | — | passed |

### Before — failing evidence

```text
✖ Windows archive listing is emitted as UTF-8 (2.0285ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 42.165208

✖ failing tests:

test at plugins/hobbyka-hub/tests/windows-archive-output.test.mjs:7:1
✖ Windows archive listing is emitted as UTF-8 (2.0285ms)
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /\[Console\]::OutputEncoding = \[Text\.UTF8Encoding\]::new\(\$false\)/. Input:
  
  '#!/usr/bin/env node\n' +
    'import { createHash, randomUUID } from "node:crypto";\n' +
    'import { createWriteStream } from "node:fs";\n' +
    'import { access, chmod, copyFile, cp, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";\n' +
    'import { arch, homedir, platform, tmpdir } from "node:os";\n' +
    'import { basename, dirname, join, resolve } from "node:path";\n' +
    'import { spawnSync } from "node:child_process";\n' +
    'import { Readable, Transform } from "node:stream";\n' +
    'import { pipeline } from "node:stream/promises";\n' +
    'import { fileURLToPath } from "node:url";\n' +
    '\n' +
    'const script = fileURLToPath(import.meta.url);\n' +
    'if (!process.env.NODE_EXTRA_CA_CERTS && !process.env.HOBBYKA_HUB_CA_READY) {\n' +
    '  const result = spawnSync(process.execPath, [...process.execArgv, script, ...process.argv.slice(2)], { env: { ...process.env, NODE_EXTRA_CA_CERTS: join(dirname(script), "..", "assets", "hobbyka-chat-root.crt"), HOBBYKA_HUB_CA_READY: "1" }, stdio: "inherit" });\n' +
    '  process.exit(result.status ?? 1);\n' +
    '}\n' +
    '\n' +
    'const [command, ...args] = process.argv.slice(2);\n' +
    'const base = (process.env.HOBBYKA_HUB_URL ?? "https://10.8.1.0:8443").replace(/\\/$/, "");\n' +
    'const agentChat = (process.env.HOBBYKA_AGENT_CHAT_URL ?? "https://172.29.172.1").replace(/\\/$/, "");\n' +
    'const publicHub = "https://github.com/hobbyka-ru/hobbyka-hub-plugin";\n' +
    'if (command === "report-bug") await submitReport(args, "bug");\n' +
    'else if (command === "idea") await submitReport(args, "idea");\n' +
    'else if (command === "install") await install(args[0]);\n' +
    'else if (command === "publish") await publish(args[0]);\n' +
    'else if (command === "propose") await propose(args[0], args.includes("--submit"), args.find((arg, index) => index > 0 && !arg.startsWith("--")));\n' +
    'else if (command === "update") await update(args.includes("--quiet"));\n' +
    'else if (command === "autoupdate" && args[0] === "enable") await enableAutoupdate();\n' +
    'else if (command === "autoupdate" && args[0] === "disable") await disableAutoupdate();\n' +
    'else if (command === "self-test") await selfTest();\n' +
    'else fail("Использование:\\n  hobbyka-hub report-bug (--stdin | --body-file PATH) [--file PATH] [--operation UUID] [--confirm]\\n  hobbyka-hub idea (--stdin | --body-file PATH) [--file PATH] [--operation UUID] [--confirm]\\n  hobbyka-hub install <slug>\\n  ho
... [output truncated] ...
.bodyFile = value.slice(12);\n    else if (value === "--confirm") result.confirm = true;\n    else if (value === "--file" && args[index + 1]) result.files.push(args[++index]);\n    else if (value.startsWith("--file=")) result.files.push(value.slice(7));\n    else if (value === "--operation" && args[index + 1]) result.operation = args[++index];\n    else if (value.startsWith("--operation=")) result.operation = value.slice(12);\n    else return { ok: false, error: ˋНеизвестный аргумент: ${value}ˋ };\n  }\n  if (result.stdin === Boolean(result.bodyFile)) return { ok: false, error: "Нужен ровно один источник текста: --stdin или --body-file PATH." };\n  if (result.files.length > 5) return { ok: false, error: "Можно приложить не больше 5 файлов." };\n  if (result.operation && !validUUID(result.operation)) return { ok: false, error: "--operation должен быть UUID." };\n  return result;\n}\n\nfunction derivedOperationID(operation, index) {\n  const value = createHash("sha256").update(ˋ${operation}:attachment:${index}ˋ).digest().subarray(0, 16);\n  value[6] = (value[6] & 0x0f) | 0x50;\n  value[8] = (value[8] & 0x3f) | 0x80;\n  const hex = value.toString("hex");\n  return ˋ${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}ˋ;\n}\n\nfunction validUUID(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? ""); }\nfunction reportAction(kind) { return kind === "idea" ? "submit Hobbyka idea" : "report Hobbyka bug"; }\nfunction reportRef(kind, id) { return { type: kind, id, ref: ˋ${kind}:${id}ˋ }; }\nfunction validReport(report, kind) { return report !== null && typeof report === "object" && validUUID(report.id) && report.kind === kind; }\nfunction localProvenance() { return { source: "local", freshness: new Date().toISOString() }; }\nfunction jsonFailure(status, code, message, exitCode, refs = []) { return printJSON({ status, result: { code, message: String(message).trim() }, refs }, exitCode); }\nfunction printJSON(value, exitCode) { console.log(JSON.stringify(value)); process.exitCode = exitCode; return value; }\n\nasync function install(slug, { update = false, quiet = false } = {}) {\n  if (!/^[a-z0-9-]+$/.test(slug ?? "")) fail("Некорректный slug плагина.");\n  const response = await hubFetch(ˋ${base}/api/plugins/${slug}/download?source=${update ? "update" : "agent"}&target=${platformTarget()}ˋ, undefined, quiet);\n  if (!response) return;\n  if (!response.ok) fail(await response.text());\n\n  const codexRoot = join(homedir(), ".codex", "hobbyka-hub-marketplace");\n  const pluginRoot = join(codexRoot, "plugins", slug);\n  const temp = await mkdtemp(join(tmpdir(), "hobbyka-hub-"));\n  try {\n    const archive = join(temp, ˋ${slug}.zipˋ);\n    await saveVerified(response, archive);\n    const entries = lis'... 27252 more characters,
    expected: /\[Console\]::OutputEncoding = \[Text\.UTF8Encoding\]::new\(\$false\)/,
    operator: 'mat
```

### After — fixed evidence

```text
✔ Windows archive listing is emitted as UTF-8 (0.822834ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 47.885875
```

## Root cause

listArchive asks powershell.exe for entry names while Node capture always decodes stdout as UTF-8; Windows PowerShell 5.1 can emit UTF-16LE.

## Applied fix

Set Console.OutputEncoding to UTF-8 before PowerShell writes archive entry names and bump Hobbyka Hub to 0.4.23.

**Why this is causal:** It makes the producer encoding match the existing Node decoder before path validation.

### Production fix files

- [hobbyka-hub.mjs](/Users/ardanila/code/hobbyka-ru/_worktrees/fix-windows-archive-encoding-20260813/plugins/hobbyka-hub/bin/hobbyka-hub.mjs:407) — PowerShell archive listing now emits UTF-8.
- [plugin.json](/Users/ardanila/code/hobbyka-ru/_worktrees/fix-windows-archive-encoding-20260813/plugins/hobbyka-hub/.codex-plugin/plugin.json:3) — Version 0.4.23.

## Verification

| Check | Status | Evidence |
|---|---|---|
| Focused regression | ✅ passed | Exit 1 before the fix, exit 0 after it. |
| Hub self-test and full plugin tests | ✅ passed | Self-test and both Node tests pass. |
| Live Windows archive integrity | ✅ passed | onec-direct-cli windows-amd64 ZIP has safe paths and unzip reports no errors. |

## Reproduce

```bash
node --test plugins/hobbyka-hub/tests/windows-archive-output.test.mjs
```
```bash
node plugins/hobbyka-hub/bin/hobbyka-hub.mjs self-test
```
```bash
node --test plugins/hobbyka-hub/tests/*.test.mjs
```

## Limitations

- The focused test simulates Windows PowerShell 5.1 output because no Windows host is attached to this workspace.

## Residual risks

- A final install on Valera's Windows machine is still the strongest end-to-end confirmation.

## Notes

- The onec-direct-cli package itself was not changed.

---

Generated by `$bug-reproducer`. A fix is proven only by the same red-to-green reproducer plus relevant broader checks.
