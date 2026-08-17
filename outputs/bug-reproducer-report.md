# Bug Reproducer

## ✅ FIX_PROVEN — Bug reproduced and fix proven

> The same reproducer changed from failing to passing and broader checks passed.

**Project:** Hobbyka Hub
**Bug:** Windows repair cannot create its task and self-test checks Unix mode bits
**Environment:** Reported on Windows 10.0.26200.8973 x64, Node.js 24.19.0, Hobbyka Hub 0.4.29. Deterministic code-path regression and broader suite run on macOS because no reachable Windows runner was available.
**Generated:** 2026-08-14

## Original report

On Windows 10 with Node.js 24.19.0 and Hobbyka Hub 0.4.29, repair fails with spawnSync schtasks.exe EPERM even when elevated, while direct schtasks.exe succeeds. After manually creating the task, self-test fails with executable script restoration failed although Windows intentionally skips chmod restoration.

| Contract | Expected | Actual |
|---|---|---|
| Observed behavior | Windows repair creates Hobbyka Hub Auto Update without a manual workaround, and self-test validates only platform-applicable behavior while still running its post-update hook check. | Node directly spawns schtasks.exe and receives EPERM; self-test then requires Unix executable mode bits even though restoreExecutableScripts is a no-op on Windows. |

## Minimal reproduction

A focused regression requires schtasks.exe, but not unrelated native executables, to use the existing guarded Windows command-shell path and requires only the Unix mode assertion to be skipped on Windows while the post-update hook remains tested.

**Confirming signal:** Both focused assertions fail on 0.4.29: there is no schtasks.exe shell route and the Unix executable-bit assertion is unconditional.

### Reproduction files

- [windows-codex-command.test.mjs](/Users/ardanila/code/hobbyka-ru/_worktrees/hub-windows-repair-selftest-20260814/plugins/hobbyka-hub/tests/windows-codex-command.test.mjs:21) — Exact Windows scheduler shell-routing regression.
- [repair-bootstrap.test.mjs](/Users/ardanila/code/hobbyka-ru/_worktrees/hub-windows-repair-selftest-20260814/plugins/hobbyka-hub/tests/repair-bootstrap.test.mjs:52) — Windows self-test platform-contract regression.

## Red to green evidence

| Evidence | Before fix | After fix |
|---|---:|---:|
| Exit code | 1 | 0 |
| Timed out | False | False |
| Duration | 60.266 ms | 77.085 ms |
| Same command | — | True |
| Broader suite | — | passed |

### Before — failing evidence

```text
✖ Windows repair uses a shell only for schtasks and skips only Unix mode checks (3.565792ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36.4785

✖ failing tests:

test at ../hub-windows-repair-regression.test.mjs:8:1
✖ Windows repair uses a shell only for schtasks and skips only Unix mode checks (3.565792ms)
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:

    assert.ok(definition)
  
      at TestContext.<anonymous> (file:///private/tmp/hub-windows-repair-regression.test.mjs:10:10)
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
✔ Windows repair uses a shell only for schtasks and skips only Unix mode checks (0.982333ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 45.294708
```

## Root cause

The shared launcher routed only .cmd and .bat shims through cmd.exe, leaving schtasks.exe on the direct Node spawn path that fails in the reported environment. Separately, self-test ignored the same Windows no-op contract implemented by restoreExecutableScripts.

## Applied fix

Route only .cmd, .bat, and exact schtasks.exe through the existing safely quoted cmd.exe path; keep all other native executables direct. Guard only the Unix executable-bit restoration assertion on Windows and retain the post-update hook test. Bump Hobbyka Hub to 0.4.30.

**Why this is causal:** The scheduler command now avoids the exact direct spawn that returned EPERM without broadening shell execution, and self-test no longer asserts behavior that production deliberately omits on Windows.

### Production fix files

- [hobbyka-hub.mjs](/Users/ardanila/code/hobbyka-ru/_worktrees/hub-windows-repair-selftest-20260814/plugins/hobbyka-hub/bin/hobbyka-hub.mjs:438) — Guarded schtasks.exe shell route and platform-correct self-test.
- [plugin.json](/Users/ardanila/code/hobbyka-ru/_worktrees/hub-windows-repair-selftest-20260814/plugins/hobbyka-hub/.codex-plugin/plugin.json:3) — Hobbyka Hub 0.4.30 release version.

## Verification

| Check | Status | Evidence |
|---|---|---|
| Focused regression | ✅ passed | The same command changed from exit 1 to exit 0. |
| Hub test suite | ✅ passed | All ten tests passed. |
| Hub self-test | ✅ passed | hobbyka-hub self-test: ok. |
| Syntax and diff checks | ✅ passed | node --check and git diff --check completed successfully. |

## Reproduce

```bash
node --test /tmp/hub-windows-repair-regression.test.mjs
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
```bash
git diff --check
```

## Limitations

- No reachable Windows runner was available; Elvira must rerun the official repair script to confirm Task Scheduler behavior on the original machine.

## Residual risks

- If the reported endpoint policy blocks schtasks.exe beneath cmd.exe as well, the Windows rerun will remain failing and the exact policy event will be needed.

## Notes

- No dependency was added. Existing command argument validation remains in force and unrelated native executables continue to bypass the shell.

---

Generated by `$bug-reproducer`. A fix is proven only by the same red-to-green reproducer plus relevant broader checks.
