# Bug Reproducer

## ✅ FIX_PROVEN — Bug reproduced and fix proven

> The same reproducer changed from failing to passing and broader checks passed.

**Project:** hobbyka-hub-plugin
**Bug:** Windows Hub cannot invoke codex.cmd or register auto-update
**Environment:** Reported on Windows, Node.js 24.19.0, Codex Desktop 26.814.5517.0, codex-cli 0.148.0-alpha.15, Hobbyka Hub 0.4.36; regression executed with Node.js test runner on macOS.
**Generated:** 2026-08-19

## Original report

Hobbyka Hub 0.4.36 fails to install a plugin through codex.cmd, then exceeds the 261-character schtasks /TR limit while enabling auto-update.

| Contract | Expected | Actual |
|---|---|---|
| Observed behavior | Windows invokes the Codex cmd shim, registers the plugin, creates the 15-minute auto-update task and exits successfully. | cmd.exe preserved an extra outer quote pair around codex.cmd, and the PowerShell EncodedCommand used for /TR exceeded 261 characters. |

## Minimal reproduction

The focused test evaluates the real command builders and captures the exact cmd.exe argv, schtasks dispatch decision and /TR action.

**Confirming signal:** Before the fix, cmd.exe received double outer quotes, schtasks was routed through cmd.exe and the generated EncodedCommand was longer than the supported task action.

### Reproduction files

- [windows-codex-command.test.mjs](/Users/ardanila/code/hobbyka-ru/_worktrees/hub-windows-runtime-20260819/plugins/hobbyka-hub/tests/windows-codex-command.test.mjs:7) — Focused Windows command and scheduler regression.

## Red to green evidence

| Evidence | Before fix | After fix |
|---|---:|---:|
| Exit code | 1 | 0 |
| Timed out | False | False |
| Duration | 79.683 ms | 68.17 ms |
| Same command | — | True |
| Broader suite | — | passed |

### Before — failing evidence

```text
✖ Windows Codex cmd shim uses cmd.exe without unsafe shell arguments (1.728292ms)
✖ Windows Task Scheduler uses the guarded command shell path (0.194292ms)
✖ Windows auto-update task safely carries a quoted launcher path (0.210458ms)
ℹ tests 3
ℹ suites 0
ℹ pass 0
ℹ fail 3
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 44.616875

✖ failing tests:

test at plugins/hobbyka-hub/tests/windows-codex-command.test.mjs:7:1
✖ Windows Codex cmd shim uses cmd.exe without unsafe shell arguments (1.728292ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

    [
      'cmd.exe',
      [
        '/d',
        '/s',
        '/c',
  +     '""codex.cmd" "plugin" "list" "--json""'
  -     '"codex.cmd" "plugin" "list" "--json"'
      ]
    ]

      at TestContext.<anonymous> (file:///Users/ardanila/code/hobbyka-ru/_worktrees/hub-windows-runtime-20260819/plugins/hobbyka-hub/tests/windows-codex-command.test.mjs:29:10)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1106:25)
      at Test.start (node:internal/test_runner/test:1003:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:358:17) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'cmd.exe', [ '/d', '/s', '/c', '""codex.cmd" "plugin" "list" "--json""' ] ],
    expected: [ 'cmd.exe', [ '/d', '/s', '/c', '"codex.cmd" "plugin" "list" "--json"' ] ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at plugins/hobbyka-hub/tests/windows-codex-command.test.mjs:37:1
✖ Windows Task Scheduler uses the guarded command shell path (0.194292ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  true !== false

      at TestContext.<anonymous> (file:///Users/ardanila/code/hobbyka-ru/_worktrees/hub-windows-runtime-20260819/plugins/hobbyka-hub/tests/windows-codex-command.test.mjs:44:10)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1106:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:788:18)
      at Test.postRun (node:internal/test_runner/test:1235:19)
      at Test.run (node:internal/test_runner/test:1163:12)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:358:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: true,
    expected: false,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at plugins/hobbyka-hub/tests/windows-codex-command.test.mjs:50:1
✖ Windows auto-update task safely carries a quoted launcher path (0.210458ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand JgAgACcAdwBzAGMAcgBpAHAAdAAuAGUAeABlACcAIAAnAEMAOgBcAFUAcwBlAHIAcwBcAE8AJwAnAEIAcgBpAGUAbgAgAE4AYQBtAGUAXAAuAGMAbwBkAGUAeABcAGgAbwBiAGIAeQBrAGEALQBoAHUAYgAtAHUAcABkAGEAdABlAHIAXAB1AHAAZABhAHQAZQAtAGgAaQBkAGQAZQBuAC4AdgBiAHMAJwA='
  - ˋwscript.exe "C:\\Users\\O'Brien Name\\.codex\\hobbyka-hub-updater\\update-hidden.vbs"ˋ

      at TestContext.<anonymous> (file:///Users/ardanila/code/hobbyka-ru/_worktrees/hub-windows-runtime-20260819/plugins/hobbyka-hub/tests/windows-codex-command.test.mjs:55:10)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1106:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:788:18)
      at Test.postRun (node:internal/test_runner/test:1235:19)
      at Test.run (node:internal/test_runner/test:1163:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:788:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand JgAgACcAdwBzAGMAcgBpAHAAdAAuAGUAeABlACcAIAAnAEMAOgBcAFUAcwBlAHIAcwBcAE8AJwAnAEIAcgBpAGUAbgAgAE4AYQBtAGUAXAAuAGMAbwBkAGUAeABcAGgAbwBiAGIAeQBrAGEALQBoAHUAYgAtAHUAcABkAGEAdABlAHIAXAB1AHAAZABhAHQAZQAtAGgAaQBkAGQAZQBuAC4AdgBiAHMAJwA=',
    expected: ˋwscript.exe "C:\\Users\\O'Brien Name\\.codex\\hobbyka-hub-updater\\update-hidden.vbs"ˋ,
    operator: 'strictEqual',
    diff: 'simple'
  }
```

### After — fixed evidence

```text
✔ Windows Codex cmd shim uses cmd.exe without unsafe shell arguments (1.200375ms)
✔ Windows Task Scheduler runs directly without cmd.exe quoting (0.250959ms)
✔ Windows auto-update task safely carries a quoted launcher path (0.237917ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 39.473208
```

## Root cause

The shared Windows process wrapper added an outer quote pair after already quoting every cmd argument. It also treated schtasks.exe as a shell script, which forced its internally quoted /TR action through the restrictive command builder; the previous workaround expanded that action into a long UTF-16 Base64 PowerShell command.

## Applied fix

Keep cmd.exe only for .cmd/.bat shims without the redundant outer pair; run schtasks.exe directly; use the existing hidden VBS launcher as the short task action.

**Why this is causal:** The same three assertions now observe the argv and /TR forms required by the failing Windows tools, while unsafe cmd metacharacters remain rejected.

### Production fix files

- [hobbyka-hub.mjs](/Users/ardanila/code/hobbyka-ru/_worktrees/hub-windows-runtime-20260819/plugins/hobbyka-hub/bin/hobbyka-hub.mjs:684) — Minimal Windows process and task action correction.

## Verification

| Check | Status | Evidence |
|---|---|---|
| Focused regression | ✅ passed | The same test changed from 3 failures to 3 passes. |
| Hub test suite | ✅ passed | 43 tests passed. |
| Hub self-test | ✅ passed | hobbyka-hub self-test: ok. |

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

## Limitations

- Real Windows acceptance is required after publishing 0.4.37.

## Residual risks

- No residual risks supplied.

## Notes

- No dependency or public command syntax changed.

---

Generated by `$bug-reproducer`. A fix is proven only by the same red-to-green reproducer plus relevant broader checks.
