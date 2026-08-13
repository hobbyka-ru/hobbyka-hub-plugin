# Bug Reproducer

## ✅ FIX_PROVEN — Bug reproduced and fix proven

> The same reproducer changed from failing to passing and broader checks passed.

**Project:** Hobbyka Hub  
**Bug:** Windows ZIP listing still fails through PowerShell stdout  
**Environment:** Windows report from Hobbyka Hub 0.4.23; local deterministic source-level regression on macOS arm64  
**Generated:** 2026-08-13

## Original report

Valera confirmed that install onec-direct-cli still fails on Windows with an unsafe-path error in Hobbyka Hub 0.4.23.

| Contract | Expected | Actual |
|---|---|---|
| Observed behavior | A valid onec-direct-cli ZIP installs on Windows. | The safe ZIP is rejected while entry names pass through PowerShell stdout. |

## Minimal reproduction

The focused test requires the Windows path to bypass PowerShell stdout and read an explicitly UTF-8 listing file.

**Confirming signal:** The test exits 1 while listArchive still captures PowerShell stdout.

### Reproduction files

- [windows-archive-output.test.mjs](/Users/ardanila/code/hobbyka-ru/_worktrees/fix-windows-archive-file-20260813/plugins/hobbyka-hub/tests/windows-archive-output.test.mjs:1) — Regression test requiring file-based UTF-8 transfer.

## Red to green evidence

| Evidence | Before fix | After fix |
|---|---:|---:|
| Exit code | 1 | 0 |
| Timed out | False | False |
| Duration | 70.958 ms | 63.577 ms |
| Same command | — | True |
| Broader suite | — | passed |

### Before — failing evidence

```text
✖ Windows archive listing bypasses PowerShell stdout encoding (1.352792ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36.869375

✖ failing tests:

test at plugins/hobbyka-hub/tests/windows-archive-output.test.mjs:7:1
✖ Windows archive listing bypasses PowerShell stdout encoding (1.352792ms)
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /WriteAllLines\(\$args\[1\]/. Input:
  
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
    'else fail("Использование:\\n  hobbyka-hub report-bug (--stdin | --body-file PATH) [--file PATH] [--operation UUID] [--confirm]\\n  hobbyka-hub idea (--stdin | --body-file PATH) [--file PATH] [--operation UUID] [--confirm]\\n  hobbyka-hub install <slug>\\n  hobbyka-
... [output truncated] ...
 (value.startsWith("--body-file=")) result.bodyFile = value.slice(12);\n    else if (value === "--confirm") result.confirm = true;\n    else if (value === "--file" && args[index + 1]) result.files.push(args[++index]);\n    else if (value.startsWith("--file=")) result.files.push(value.slice(7));\n    else if (value === "--operation" && args[index + 1]) result.operation = args[++index];\n    else if (value.startsWith("--operation=")) result.operation = value.slice(12);\n    else return { ok: false, error: ˋНеизвестный аргумент: ${value}ˋ };\n  }\n  if (result.stdin === Boolean(result.bodyFile)) return { ok: false, error: "Нужен ровно один источник текста: --stdin или --body-file PATH." };\n  if (result.files.length > 5) return { ok: false, error: "Можно приложить не больше 5 файлов." };\n  if (result.operation && !validUUID(result.operation)) return { ok: false, error: "--operation должен быть UUID." };\n  return result;\n}\n\nfunction derivedOperationID(operation, index) {\n  const value = createHash("sha256").update(ˋ${operation}:attachment:${index}ˋ).digest().subarray(0, 16);\n  value[6] = (value[6] & 0x0f) | 0x50;\n  value[8] = (value[8] & 0x3f) | 0x80;\n  const hex = value.toString("hex");\n  return ˋ${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}ˋ;\n}\n\nfunction validUUID(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? ""); }\nfunction reportAction(kind) { return kind === "idea" ? "submit Hobbyka idea" : "report Hobbyka bug"; }\nfunction reportRef(kind, id) { return { type: kind, id, ref: ˋ${kind}:${id}ˋ }; }\nfunction validReport(report, kind) { return report !== null && typeof report === "object" && validUUID(report.id) && report.kind === kind; }\nfunction localProvenance() { return { source: "local", freshness: new Date().toISOString() }; }\nfunction jsonFailure(status, code, message, exitCode, refs = []) { return printJSON({ status, result: { code, message: String(message).trim() }, refs }, exitCode); }\nfunction printJSON(value, exitCode) { console.log(JSON.stringify(value)); process.exitCode = exitCode; return value; }\n\nasync function install(slug, { update = false, quiet = false } = {}) {\n  if (!/^[a-z0-9-]+$/.test(slug ?? "")) fail("Некорректный slug плагина.");\n  const response = await hubFetch(ˋ${base}/api/plugins/${slug}/download?source=${update ? "update" : "agent"}&target=${platformTarget()}ˋ, undefined, quiet);\n  if (!response) return;\n  if (!response.ok) fail(await response.text());\n\n  const codexRoot = join(homedir(), ".codex", "hobbyka-hub-marketplace");\n  const pluginRoot = join(codexRoot, "plugins", slug);\n  const temp = await mkdtemp(join(tmpdir(), "hobbyka-hub-"));\n  try {\n    const archive = join(temp, ˋ${slug}.zipˋ);\n    await saveVerified(response, archive);\n    const entries = lis'... 27314 more characters,
    expected: /WriteAllLines\(\$args\[1\]/,
    operator: 'mat
```

### After — fixed evidence

```text
✔ Windows archive listing bypasses PowerShell stdout encoding (0.495417ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36.5105
```

## Root cause

Setting Console.OutputEncoding was insufficient in the reporter's Windows PowerShell host; archive entry names still crossed an unreliable text-encoding boundary.

## Applied fix

PowerShell writes archive entry names directly to an explicit UTF-8 file, which Node reads with readFileSync; version bumped to 0.4.25.

**Why this is causal:** The unsafe stdout encoding boundary is no longer used.

### Production fix files

- [hobbyka-hub.mjs](/Users/ardanila/code/hobbyka-ru/_worktrees/fix-windows-archive-file-20260813/plugins/hobbyka-hub/bin/hobbyka-hub.mjs:1) — File-based Windows archive listing.
- [plugin.json](/Users/ardanila/code/hobbyka-ru/_worktrees/fix-windows-archive-file-20260813/plugins/hobbyka-hub/.codex-plugin/plugin.json:3) — Version 0.4.25.

## Verification

| Check | Status | Evidence |
|---|---|---|
| Focused regression | ✅ passed | Exit 1 before, exit 0 after. |
| Hub suite | ✅ passed | Self-test and all Node tests pass. |

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

- Final end-to-end confirmation must be performed on Valera's Windows machine.

## Residual risks

- A different Windows-only extraction failure may surface after path validation succeeds.

## Notes

- The onec-direct-cli package is unchanged and its live ZIP remains valid.

---

Generated by `$bug-reproducer`. A fix is proven only by the same red-to-green reproducer plus relevant broader checks.
