# Hobbyka Hub updater runtime repair

**FIX_PROVEN**

## Symptom

The macOS Hub updater exited with status 1. Its managed copy could not import `bin/marketplace-state.mjs`; after that file was restored, the minimal `launchd` environment still could not execute npm-based plugin hooks.

## Root cause

`copyUpdater` copied only the main CLI file although that file imports a sibling runtime module. The generated LaunchAgent also omitted `PATH`, while post-update hooks execute installed tools such as `npm`.

## Fix

- Copy `marketplace-state.mjs` into the same managed `bin` directory.
- Give the macOS LaunchAgent a bounded executable path containing the Node directory and standard Homebrew/system locations.
- Keep one bootstrap regression covering both runtime files and the generated LaunchAgent environment.

## Evidence

- Focused test failed before the fix because the managed dependency did not exist.
- The same test passes after the fix.
- All 43 Hub tests and `self-test` pass.
- A real `launchd` run completed with exit code 0 and ran the installed post-update hooks.

No server code, plugin business logic, credentials, or user data changed.
