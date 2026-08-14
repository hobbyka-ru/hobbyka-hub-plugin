# Bug Reproducer

## ✅ FIX_PROVEN — Bug reproduced and fix proven

> The same reproducer changed from failing to passing and broader checks passed.

**Project:** Hobbyka Hub  
**Bug:** Windows repair requires Node and does not verify Agent Chat round-trip
**Environment:** Windows target; deterministic script-contract regression run on macOS because no reachable Windows runner was available.
**Generated:** 2026-08-14

## Original report

Elvira's Windows repair must install Node.js if it is absent, send one test message to @ardanila, and finish only after confirming the matching reply.

| Contract | Expected | Actual |
|---|---|---|
| Observed behavior | The repair installs official Node.js LTS when needed, preserves Agent Chat data and Inbox routing, sends one nonce-bearing message to @ardanila, and confirms a reply from that exact profile with the same nonce. | The previous repair stopped when Node.js was absent and declared success after local service checks without testing message delivery or a reply. |

## Minimal reproduction

A focused test inspects the public Windows repair and requires the winget Node.js LTS installation plus find, open, send, read, and mark-read commands for the exact @ardanila conversation.

**Confirming signal:** The focused test exits 1 because the previous script contains neither the winget Node.js installation nor the Agent Chat round-trip.

### Reproduction files

- [repair-bootstrap.test.mjs](/Users/ardanila/code/hobbyka-ru/_worktrees/hub-windows-roundtrip-20260814/plugins/hobbyka-hub/tests/repair-bootstrap.test.mjs:34) — Focused Windows repair contract regression.

## Red to green evidence

| Evidence | Before fix | After fix |
|---|---:|---:|
| Exit code | 1 | 0 |
| Timed out | False | False |
| Duration | 60.613 ms | 56.755 ms |
| Same command | — | True |
| Broader suite | — | passed |

### Before — failing evidence

```text
✔ repair bootstraps the managed marketplace before updating legacy plugins (0.362333ms)
✔ normal install immediately reconciles legacy Hobbyka plugins (0.132042ms)
✔ macOS repair script preserves Agent Chat state and verifies the real services (5.409958ms)
✖ Windows repair script preserves Agent Chat state and verifies scheduled tasks (0.986208ms)
ℹ tests 4
ℹ suites 0
ℹ pass 3
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37.602542

✖ failing tests:

test at plugins/hobbyka-hub/tests/repair-bootstrap.test.mjs:34:1
✖ Windows repair script preserves Agent Chat state and verifies scheduled tasks (0.986208ms)
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /winget\.exe.*OpenJS\.NodeJS\.LTS/s. Input:
  
  '$ErrorActionPreference = "Stop"\n' +
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n' +
    '\n' +
    'function Fail([string]$Message) { throw "ОШИБКА: $Message" }\n' +
    'function Find-Command([string[]]$Names, [string[]]$Candidates) {\n' +
    '  foreach ($name in $Names) {\n' +
    '    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1\n' +
    '    if ($command) { return $command.Source }\n' +
    '  }\n' +
    '  foreach ($candidate in $Candidates) { if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate } }\n' +
    '  return $null\n' +
    '}\n' +
    'function Run([string]$File, [string[]]$Arguments) {\n' +
    '  & $File @Arguments\n' +
    '  if ($LASTEXITCODE -ne 0) { Fail "команда завершилась с кодом $LASTEXITCODEˋ: $File" }\n' +
    '}\n' +
    'function Read-JsonCommand([string]$File, [string[]]$Arguments) {\n' +
    '  $output = & $File @Arguments | Out-String\n' +
    '  if ($LASTEXITCODE -ne 0) { Fail "команда проверки завершилась с кодом $LASTEXITCODEˋ: $File" }\n' +
    '  return $output | ConvertFrom-Json\n' +
    '}\n' +
    '\n' +
    'if ($env:OS -ne "Windows_NT") { Fail "скрипт предназначен для Windows" }\n' +
    '$codex = Find-Command @("codex.cmd", "codex.exe", "codex") @()\n' +
    '$node = Find-Command @("node.exe", "node") @(\n' +
    '  (Join-Path $env:ProgramFiles "nodejs\\node.exe"),\n' +
    '  (Join-Path $env:LOCALAPPDATA "Programs\\nodejs\\node.exe")\n' +
    ')\n' +
    'if (-not $codex) { Fail "не найден Codex" }\n' +
    'if (-not $node) { Fail "не найден Node.js" }\n' +
    '\n' +
    '$work = Join-Path ([IO.Path]::GetTempPath()) ("hobbyka-repair-" + [guid]::NewGuid().ToString("N"))\n' +
    'New-Item -ItemType Directory -Path $work | Out-Null\n' +
    'try {\n' +
    '  $state = Join-Path $env:APPDATA "Hobbyka\\AgentChat\\session.json"\n' +
    '  $stateHash = if (Test-Path -LiteralPath $state) { (Get-FileHash -Algorithm SHA256 -LiteralPath $state).Hash } else { $null }\n' +
    '  $oldTarget = $null\n' +
    '  $oldService = Join-Path $env:LOCALAPPDATA "Hobbyka\\AgentChat\\bin\\hchat-router.exe"\n' +
    '  if (Test-Path -LiteralPath $oldService) {\n' +
    '    try { $oldTar
... [output truncated] ...
ub = Join-Path $managed "hobbyka-hub\\bin\\hobbyka-hub.mjs"\n  if (-not (Test-Path -LiteralPath $hub)) { Fail "Hobbyka Hub не зарегистрирован в Codex" }\n\n  Write-Host "3/4 Переустанавливаю актуальный Agent Chat без удаления его данных…"\n  Run $node @($hub, "install", "hobbyka-agent-chat")\n  Run $node @($hub, "self-test")\n\n  $hchat = Join-Path $managed "hobbyka-agent-chat\\scripts\\hchat.ps1"\n  if (-not (Test-Path -LiteralPath $hchat)) { Fail "Agent Chat не установлен" }\n  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source\n  $prefix = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $hchat)\n  $version = Read-JsonCommand $powershell ($prefix + @("version"))\n  $status = Read-JsonCommand $powershell ($prefix + @("inbox", "status"))\n  $plugins = Read-JsonCommand $codex @("plugin", "list", "--json")\n\n  Write-Host "4/4 Проверяю версии, Inbox и фоновые задачи…"\n  if ([version]($version.result.version) -lt [version]"0.6.11") { Fail "Agent Chat остался на версии $($version.result.version)" }\n  if (-not $status.result.route.target_thread_id) { Fail "Inbox не привязан к задаче Codex" }\n  if (-not $status.result.router.installed -or -not $status.result.router.running) { Fail "Router Agent Chat не работает" }\n  if (-not $status.result.router.updater_installed) { Fail "обновлятор Hobbyka Hub не установлен" }\n  if ($oldTarget -and $oldTarget -ne $status.result.route.target_thread_id) { Fail "привязка Inbox изменилась" }\n\n  foreach ($required in @(\n    [pscustomobject]@{ Name = "hobbyka-hub"; Minimum = "0.4.29" },\n    [pscustomobject]@{ Name = "hobbyka-agent-chat"; Minimum = "0.6.11" }\n  )) {\n    $plugin = $plugins.installed | Where-Object { $_.name -eq $required.Name -and $_.installed -and $_.marketplaceName -eq "hobbyka-hub" } | Select-Object -First 1\n    if (-not $plugin) { Fail "$($required.Name) не установлен из управляемого Hobbyka Hub" }\n    if ([version]($plugin.version) -lt [version]($required.Minimum)) { Fail "$($required.Name) $($plugin.version) старее $($required.Minimum)" }\n  }\n\n  if ($stateHash) {\n    if (-not (Test-Path -LiteralPath $state)) { Fail "локальная сессия Agent Chat исчезла" }\n    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $state).Hash -ne $stateHash) { Fail "локальная сессия Agent Chat изменилась" }\n  }\n  & schtasks.exe /Query /TN "Hobbyka Hub Auto Update" *> $null\n  if ($LASTEXITCODE -ne 0) { Fail "задача автообновления Hobbyka Hub не зарегистрирована" }\n  & schtasks.exe /Query /TN "Hobbyka Agent Chat Updater" *> $null\n  if ($LASTEXITCODE -eq 0) { Fail "устаревший обновлятор Agent Chat всё ещё зарегистрирован" }\n\n  Write-Host "ˋnГОТОВО: Hobbyka Hub и Agent Chat переустановлены и обновлены; данные и Inbox сохранены; Router и единый автообновлятор работают."\n} finally {\n  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue\n}\n',
    expected: /winget\.exe.*OpenJS\.NodeJS\.LTS/s,
    operator: 'mat
```

### After — fixed evidence

```text
✔ repair bootstraps the managed marketplace before updating legacy plugins (0.331375ms)
✔ normal install immediately reconciles legacy Hobbyka plugins (0.060834ms)
✔ macOS repair script preserves Agent Chat state and verifies the real services (5.840292ms)
✔ Windows repair script preserves Agent Chat state and verifies scheduled tasks (0.759042ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35.801042
```

## Root cause

The repair treated Node.js as a prerequisite and ended after local health checks; it had no end-to-end communication acceptance check.

## Applied fix

Install official Node.js LTS through winget when missing, then use the installed hchat binary to open the exact @ardanila profile, send one nonce-bearing test message, wait at most five minutes for the matching reply, and mark it read.

**Why this is causal:** The changed script now supplies its missing runtime prerequisite and makes the requested remote round-trip the condition for success.

### Production fix files

- [repair-elvira-windows.ps1](/Users/ardanila/code/hobbyka-ru/_worktrees/hub-windows-roundtrip-20260814/scripts/repair-elvira-windows.ps1:34) — Node.js bootstrap and bounded Agent Chat round-trip.

## Verification

| Check | Status | Evidence |
|---|---|---|
| Focused regression | ✅ passed | The same command changed from exit 1 to exit 0. |
| Hub test suite | ✅ passed | All eight tests passed. |
| Hub syntax check | ✅ passed | node --check completed successfully. |
| Diff whitespace check | ✅ passed | git diff --check completed successfully. |

## Reproduce

```bash
node --test plugins/hobbyka-hub/tests/repair-bootstrap.test.mjs
```
```bash
node --test plugins/hobbyka-hub/tests/*.test.mjs
```
```bash
node --check plugins/hobbyka-hub/bin/hobbyka-hub.mjs
```
```bash
git diff --check
```

## Limitations

- No reachable Windows runner was available; the actual delivery and reply can be proven only when Elvira runs the public script.

## Residual risks

- winget may request Windows elevation; if the newly installed node.exe is not visible until a new PowerShell opens, the script stops before changing Hub or Agent Chat.

## Notes

- No dependency was added. The test sends only one message and refuses a blind retry when delivery outcome is unknown.

---

Generated by `$bug-reproducer`. A fix is proven only by the same red-to-green reproducer plus relevant broader checks.
