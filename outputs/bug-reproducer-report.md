# Bug Reproducer

## ✅ FIX_PROVEN — Bug reproduced and fix proven

> The same reproducer changed from failing to passing and broader checks passed.

**Project:** Hobbyka Hub  
**Bug:** Windows Hub cannot start the Codex cmd shim  
**Environment:** Reported on Windows with Hobbyka Hub 0.4.26 and Node.js 24; focused regression verified on macOS because no reachable Windows runner was available.  
**Generated:** 2026-08-13

## Original report

Hobbyka Hub 0.4.26 downloads hobbyka-agent-chat on Windows but fails before registration with spawnSync codex.cmd EINVAL; selecting a protected executable directly produces EPERM.

| Contract | Expected | Actual |
|---|---|---|
| Observed behavior | Hub invokes the installed Codex CLI, registers hobbyka-agent-chat@hobbyka-hub, and confirms installation. | Node.js 24 rejects direct execution of codex.cmd with EINVAL, so installation exits before registration and confirmation. |

## Minimal reproduction

A focused test requires .cmd shims to be routed through cmd.exe without shell:true, verifies quoting, rejects cmd metacharacters, and keeps marketplace paths out of the command string.

**Confirming signal:** The focused test exits 1 because the shared process helper directly passes codex.cmd to spawnSync and has no safe Windows command path.

### Reproduction files

- [windows-codex-command.test.mjs](/Users/ardanila/code/hobbyka-ru/_worktrees/fix-windows-codex-cmd-20260813/plugins/hobbyka-hub/tests/windows-codex-command.test.mjs:7) — Focused Windows cmd invocation and injection regression test.

## Red to green evidence

| Evidence | Before fix | After fix |
|---|---:|---:|
| Exit code | 1 | 0 |
| Timed out | False | False |
| Duration | 63.711 ms | 62.008 ms |
| Same command | — | True |
| Broader suite | — | passed |

### Before — failing evidence

```text
✖ Windows Codex cmd shim uses cmd.exe without unsafe shell arguments (3.86725ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36.86975

✖ failing tests:

test at plugins/hobbyka-hub/tests/windows-codex-command.test.mjs:7:1
✖ Windows Codex cmd shim uses cmd.exe without unsafe shell arguments (3.86725ms)
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
  
    assert.ok(definition)
  
      at TestContext.<anonymous> (file:///Users/ardanila/code/hobbyka-ru/_worktrees/fix-windows-codex-cmd-20260813/plugins/hobbyka-hub/tests/windows-codex-command.test.mjs:9:10)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1106:25)
      at Test.start (node:internal/test_runner/test:1003:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:358:17) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: undefined,
    expected: true,
    operator: '==',
    diff: 'simple'
  }
```

### After — fixed evidence

```text
✔ Windows Codex cmd shim uses cmd.exe without unsafe shell arguments (0.666375ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35.481833
```

## Root cause

Windows .cmd files are shell scripts rather than directly executable programs. Hub passed codex.cmd to spawnSync without cmd.exe, which Node.js documents as unsupported on Windows.

## Applied fix

Route only Windows .cmd and .bat executables through cmd.exe /d /s /c with explicit quoting, metacharacter rejection, hidden execution, and verbatim arguments; keep all native executables on direct spawnSync.

**Why this is causal:** The corrected shared helper handles every Codex CLI call and removes the direct .cmd execution that produced EINVAL without enabling Node's unsafe shell:true argument concatenation.

### Production fix files

- [hobbyka-hub.mjs](/Users/ardanila/code/hobbyka-ru/_worktrees/fix-windows-codex-cmd-20260813/plugins/hobbyka-hub/bin/hobbyka-hub.mjs:422) — Safe .cmd/.bat execution in the shared process helper.
- [plugin.json](/Users/ardanila/code/hobbyka-ru/_worktrees/fix-windows-codex-cmd-20260813/plugins/hobbyka-hub/.codex-plugin/plugin.json:3) — Release version 0.4.28.

## Verification

| Check | Status | Evidence |
|---|---|---|
| Focused regression | ✅ passed | The same command changed from exit 1 to exit 0. |
| Hub test suite | ✅ passed | All four tests passed. |
| Hub self-test | ✅ passed | hobbyka-hub self-test: ok |
| Syntax check | ✅ passed | node --check completed successfully. |
| Plugin validation | ✅ passed | Codex plugin validation passed. |

## Reproduce

```bash
node --test plugins/hobbyka-hub/tests/windows-codex-command.test.mjs
```
```bash
node --test plugins/hobbyka-hub/tests/*.test.mjs
```
```bash
node plugins/hobbyka-hub/bin/hobbyka-hub.mjs self-test
```
```bash
node --check plugins/hobbyka-hub/bin/hobbyka-hub.mjs
```

## Limitations

- No reachable Windows runner was available; Valera must repeat the original install command with the released Hub version.

## Residual risks

- A custom HOBBYKA_CODEX_COMMAND containing cmd metacharacters is rejected instead of executed.

## Notes

- No dependency was added and shell:true is intentionally not used because Node.js DEP0190 warns that its args array is not escaped.

---

Generated by `$bug-reproducer`. A fix is proven only by the same red-to-green reproducer plus relevant broader checks.
