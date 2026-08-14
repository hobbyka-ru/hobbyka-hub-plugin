$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Fail([string]$Message) { throw "ОШИБКА: $Message" }
function Find-Command([string[]]$Names, [string[]]$Candidates) {
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
  }
  foreach ($candidate in $Candidates) { if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate } }
  return $null
}
function Run([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { Fail "команда завершилась с кодом $LASTEXITCODE`: $File" }
}
function Read-JsonCommand([string]$File, [string[]]$Arguments) {
  $output = & $File @Arguments | Out-String
  if ($LASTEXITCODE -ne 0) { Fail "команда проверки завершилась с кодом $LASTEXITCODE`: $File" }
  return $output | ConvertFrom-Json
}

if ($env:OS -ne "Windows_NT") { Fail "скрипт предназначен для Windows" }
$codex = Find-Command @("codex.cmd", "codex.exe", "codex") @()
$node = Find-Command @("node.exe", "node") @(
  (Join-Path $env:ProgramFiles "nodejs\node.exe"),
  (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
)
if (-not $codex) { Fail "не найден Codex" }
if (-not $node) { Fail "не найден Node.js" }

$work = Join-Path ([IO.Path]::GetTempPath()) ("hobbyka-repair-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $state = Join-Path $env:APPDATA "Hobbyka\AgentChat\session.json"
  $stateHash = if (Test-Path -LiteralPath $state) { (Get-FileHash -Algorithm SHA256 -LiteralPath $state).Hash } else { $null }
  $oldTarget = $null
  $oldService = Join-Path $env:LOCALAPPDATA "Hobbyka\AgentChat\bin\hchat-router.exe"
  if (Test-Path -LiteralPath $oldService) {
    try { $oldTarget = (Read-JsonCommand $oldService @("inbox", "status")).result.route.target_thread_id } catch { }
  }

  Write-Host "1/4 Загружаю официальный Hobbyka Hub…"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $archive = Join-Path $work "hobbyka-hub.zip"
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/hobbyka-ru/hobbyka-hub-plugin/archive/refs/heads/main.zip" -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $work
  $bootstrap = Join-Path $work "hobbyka-hub-plugin-main\plugins\hobbyka-hub\bin\hobbyka-hub.mjs"
  if (-not (Test-Path -LiteralPath $bootstrap)) { Fail "в официальном архиве нет Hobbyka Hub" }

  Write-Host "2/4 Восстанавливаю единый обновлятор и переношу старые установки…"
  $env:HOBBYKA_CODEX_COMMAND = $codex
  Run $node @($bootstrap, "repair")

  $managed = Join-Path $env:USERPROFILE ".codex\hobbyka-hub-marketplace\plugins"
  $hub = Join-Path $managed "hobbyka-hub\bin\hobbyka-hub.mjs"
  if (-not (Test-Path -LiteralPath $hub)) { Fail "Hobbyka Hub не зарегистрирован в Codex" }

  Write-Host "3/4 Переустанавливаю актуальный Agent Chat без удаления его данных…"
  Run $node @($hub, "install", "hobbyka-agent-chat")
  Run $node @($hub, "self-test")

  $hchat = Join-Path $managed "hobbyka-agent-chat\scripts\hchat.ps1"
  if (-not (Test-Path -LiteralPath $hchat)) { Fail "Agent Chat не установлен" }
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $prefix = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $hchat)
  $version = Read-JsonCommand $powershell ($prefix + @("version"))
  $status = Read-JsonCommand $powershell ($prefix + @("inbox", "status"))
  $plugins = Read-JsonCommand $codex @("plugin", "list", "--json")

  Write-Host "4/4 Проверяю версии, Inbox и фоновые задачи…"
  if ([version]($version.result.version) -lt [version]"0.6.11") { Fail "Agent Chat остался на версии $($version.result.version)" }
  if (-not $status.result.route.target_thread_id) { Fail "Inbox не привязан к задаче Codex" }
  if (-not $status.result.router.installed -or -not $status.result.router.running) { Fail "Router Agent Chat не работает" }
  if (-not $status.result.router.updater_installed) { Fail "обновлятор Hobbyka Hub не установлен" }
  if ($oldTarget -and $oldTarget -ne $status.result.route.target_thread_id) { Fail "привязка Inbox изменилась" }

  foreach ($required in @(
    [pscustomobject]@{ Name = "hobbyka-hub"; Minimum = "0.4.29" },
    [pscustomobject]@{ Name = "hobbyka-agent-chat"; Minimum = "0.6.11" }
  )) {
    $plugin = $plugins.installed | Where-Object { $_.name -eq $required.Name -and $_.installed -and $_.marketplaceName -eq "hobbyka-hub" } | Select-Object -First 1
    if (-not $plugin) { Fail "$($required.Name) не установлен из управляемого Hobbyka Hub" }
    if ([version]($plugin.version) -lt [version]($required.Minimum)) { Fail "$($required.Name) $($plugin.version) старее $($required.Minimum)" }
  }

  if ($stateHash) {
    if (-not (Test-Path -LiteralPath $state)) { Fail "локальная сессия Agent Chat исчезла" }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $state).Hash -ne $stateHash) { Fail "локальная сессия Agent Chat изменилась" }
  }
  & schtasks.exe /Query /TN "Hobbyka Hub Auto Update" *> $null
  if ($LASTEXITCODE -ne 0) { Fail "задача автообновления Hobbyka Hub не зарегистрирована" }
  & schtasks.exe /Query /TN "Hobbyka Agent Chat Updater" *> $null
  if ($LASTEXITCODE -eq 0) { Fail "устаревший обновлятор Agent Chat всё ещё зарегистрирован" }

  Write-Host "`nГОТОВО: Hobbyka Hub и Agent Chat переустановлены и обновлены; данные и Inbox сохранены; Router и единый автообновлятор работают."
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
