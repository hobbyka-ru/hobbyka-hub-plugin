# Bug Reproducer

## ✅ FIX_PROVEN — Bug reproduced and fix proven

> The same reproducer changed from failing to passing and broader checks passed.

**Project:** Hobbyka Hub  
**Bug:** Hub snapshots plugins before post-update dependencies exist  
**Environment:** macOS, Node.js 26, Hobbyka Hub 0.4.33, email-cli 0.3.1  
**Generated:** 2026-08-17

## Original report

email-cli 0.3.1 help fails from the Codex cache with ERR_MODULE_NOT_FOUND for @napi-rs/keyring although the Hub installation succeeded and post-update installed dependencies in the managed marketplace copy.

| Contract | Expected | Actual |
|---|---|---|
| Observed behavior | The post-update hook finishes preparing the managed plugin before Codex snapshots that plugin into its executable cache; email-cli help returns one JSON object with exit code 0. | Hub registered the plugin with Codex before running post-update, so the managed copy gained node_modules after the cache snapshot and the cached entrypoint could not import @napi-rs/keyring. |

## Minimal reproduction

A focused regression extracts the real install function and requires post-update to precede marketplace registration and plugin add. The unmodified 0.4.33 order fails. A temporary email-cli managed copy then runs its real post-update hook, is copied as the cache snapshot, and its real help entrypoint returns JSON with exit 0.

**Confirming signal:** The focused install-order assertion fails on 0.4.33 because runPostUpdateHook appears after codex plugin add.

### Reproduction files

- [repair-bootstrap.test.mjs](/Users/ardanila/code/hobbyka-ru/_worktrees/fix-hub-post-update-cache-20260817/plugins/hobbyka-hub/tests/repair-bootstrap.test.mjs:21) — Regression contract for post-update before cache snapshot.

## Red to green evidence

| Evidence | Before fix | After fix |
|---|---:|---:|
| Exit code | 1 | 0 |
| Timed out | False | False |
| Duration | 67.944 ms | 59.433 ms |
| Same command | — | True |
| Broader suite | — | passed |

### Before — failing evidence

```text
✔ repair bootstraps the managed marketplace before updating legacy plugins (0.355625ms)
✔ normal install immediately reconciles legacy Hobbyka plugins (0.066375ms)
✖ install completes post-update before Codex snapshots the plugin cache (2.200458ms)
✔ macOS repair script preserves Agent Chat state and verifies the real services (6.037042ms)
✔ Windows repair script preserves Agent Chat state and verifies scheduled tasks (0.498458ms)
✔ self-test skips only Unix executable bits on Windows (0.097125ms)
✔ self-update reads the manifest from the downloaded archive (0.055083ms)
ℹ tests 7
ℹ suites 0
ℹ pass 6
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 43.587166

✖ failing tests:

test at plugins/hobbyka-hub/tests/repair-bootstrap.test.mjs:21:1
✖ install completes post-update before Codex snapshots the plugin cache (2.200458ms)
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
  
    assert.ok(hook >= 0 && hook < marketplace && marketplace < add)
  
      at TestContext.<anonymous> (file:///private/tmp/hub-post-update-red-3064/plugins/hobbyka-hub/tests/repair-bootstrap.test.mjs:27:10)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1106:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:788:18)
      at Test.postRun (node:internal/test_runner/test:1235:19)
      at Test.run (node:internal/test_runner/test:1163:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:788:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }
```

### After — fixed evidence

```text
✔ repair bootstraps the managed marketplace before updating legacy plugins (0.335458ms)
✔ normal install immediately reconciles legacy Hobbyka plugins (0.058042ms)
✔ install completes post-update before Codex snapshots the plugin cache (0.062583ms)
✔ macOS repair script preserves Agent Chat state and verifies the real services (5.958792ms)
✔ Windows repair script preserves Agent Chat state and verifies scheduled tasks (0.6315ms)
✔ self-test skips only Unix executable bits on Windows (0.099583ms)
✔ self-update reads the manifest from the downloaded archive (0.056083ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37.595125
```

## Root cause

Hobbyka Hub called codex plugin add before runPostUpdateHook, while Codex snapshots the local plugin at add time.

## Applied fix

Moved the existing copy-updater and post-update preparation before configureMarketplace and codex plugin add; no email-cli-specific fallback was added.

**Why this is causal:** Every generated runtime dependency now exists in the managed plugin before the single cache snapshot that must contain it.

### Production fix files

- [hobbyka-hub.mjs](/Users/ardanila/code/hobbyka-ru/_worktrees/fix-hub-post-update-cache-20260817/plugins/hobbyka-hub/bin/hobbyka-hub.mjs:151) — Shared causal install-order correction.
- [plugin.json](/Users/ardanila/code/hobbyka-ru/_worktrees/fix-hub-post-update-cache-20260817/plugins/hobbyka-hub/.codex-plugin/plugin.json:3) — Release version 0.4.34.

## Verification

| Check | Status | Evidence |
|---|---|---|
| Focused regression | ✅ passed | Same command changed from exit 1 to exit 0. |
| Full Hub tests | ✅ passed | 13 of 13 tests passed. |
| Hub self-test | ✅ passed | hobbyka-hub self-test: ok. |
| Real email-cli cache fixture | ✅ passed | @napi-rs/keyring existed in the cache copy and help returned one JSON object with exit 0. |

## Reproduce

```bash
node --test plugins/hobbyka-hub/tests/repair-bootstrap.test.mjs
```
```bash
node --test plugins/hobbyka-hub/tests/*.test.mjs
```
```bash
node plugins/hobbyka-hub/bin/hobbyka-hub.mjs self-test
```

## Limitations

- The real cache fixture was verified on macOS; Windows packaging remains covered by the existing Hub regression suite.

## Residual risks

- A future post-update hook that requires its own target plugin to already be registered would need an explicit separate contract. No current shipped hook has that dependency.

## Notes

- The dirty standalone /Users/ardanila/code/email-cli checkout was not modified.
- The fix applies to every Hub plugin with generated runtime artifacts, not only email-cli.

---

Generated by `$bug-reproducer`. A fix is proven only by the same red-to-green reproducer plus relevant broader checks.
