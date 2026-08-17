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
  $code = $LASTEXITCODE
  $parsed = $output | ConvertFrom-Json
  if ($parsed.status -eq "outcome_unknown") { Fail "исход отправки неизвестен; не запускайте сценарий повторно, передайте этот вывод Даниилу" }
  if ($code -ne 0) { Fail "команда проверки завершилась с кодом $code`: $File" }
  return $parsed
}
function Read-JsonInputCommand([string]$File, [string[]]$Arguments, [string]$InputText) {
  $output = $InputText | & $File @Arguments | Out-String
  $code = $LASTEXITCODE
  $parsed = $output | ConvertFrom-Json
  if ($parsed.status -eq "outcome_unknown") { Fail "исход отправки неизвестен; не запускайте сценарий повторно, передайте этот вывод Даниилу" }
  if ($code -ne 0) { Fail "команда отправки завершилась с кодом $code`: $File" }
  return $parsed
}

if ($env:OS -ne "Windows_NT") { Fail "скрипт предназначен для Windows" }
$codex = Find-Command @("codex.cmd", "codex.exe", "codex") @()
$nodeCandidates = @(
  (Join-Path $env:ProgramFiles "nodejs\node.exe"),
  (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
)
$node = Find-Command @("node.exe", "node") $nodeCandidates
if (-not $codex) { Fail "не найден Codex" }
if (-not $node) {
  $winget = Find-Command @("winget.exe", "winget") @()
  if (-not $winget) { Fail "не найдены Node.js и штатный установщик winget" }
  Write-Host "Устанавливаю официальный Node.js LTS…"
  Run $winget @("install", "--id", "OpenJS.NodeJS.LTS", "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements")
  $node = Find-Command @("node.exe", "node") $nodeCandidates
  if (-not $node) { Fail "Node.js установлен, но node.exe не найден; откройте новый PowerShell и повторите" }
}

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

  Write-Host "1/5 Загружаю официальный Hobbyka Hub…"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $archive = Join-Path $work "hobbyka-hub.zip"
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/hobbyka-ru/hobbyka-hub-plugin/archive/refs/heads/main.zip" -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $work
  $bootstrap = Join-Path $work "hobbyka-hub-plugin-main\plugins\hobbyka-hub\bin\hobbyka-hub.mjs"
  if (-not (Test-Path -LiteralPath $bootstrap)) { Fail "в официальном архиве нет Hobbyka Hub" }

  Write-Host "2/5 Восстанавливаю единый обновлятор и переношу старые установки…"
  $env:HOBBYKA_CODEX_COMMAND = $codex
  Run $node @($bootstrap, "repair")

  $managed = Join-Path $env:USERPROFILE ".codex\hobbyka-hub-marketplace\plugins"
  $hub = Join-Path $managed "hobbyka-hub\bin\hobbyka-hub.mjs"
  if (-not (Test-Path -LiteralPath $hub)) { Fail "Hobbyka Hub не зарегистрирован в Codex" }

  Write-Host "3/5 Переустанавливаю актуальный Agent Chat без удаления его данных…"
  Run $node @($hub, "install", "hobbyka-agent-chat")
  Run $node @($hub, "self-test")

  $agentRoot = Join-Path $managed "hobbyka-agent-chat"
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
  $hchat = Join-Path $agentRoot "bin\windows-$arch\hchat.exe"
  if (-not (Test-Path -LiteralPath $hchat)) { Fail "Agent Chat не установлен" }
  if (-not $env:HCHAT_SERVER) { $env:HCHAT_SERVER = "https://172.29.172.1" }
  if (-not $env:HCHAT_CA_FILE) { $env:HCHAT_CA_FILE = Join-Path $agentRoot "assets\hobbyka-chat-root.crt" }
  $version = Read-JsonCommand $hchat @("version")
  $status = Read-JsonCommand $hchat @("inbox", "status")
  $plugins = Read-JsonCommand $codex @("plugin", "list", "--json")

  Write-Host "4/5 Проверяю версии, Inbox и фоновые задачи…"
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

  Write-Host "5/5 Отправляю Даниилу тестовое сообщение и проверяю ответ…"
  $directory = Read-JsonCommand $hchat @("find", "colleague", "ardanila")
  $person = @($directory.result.items | Where-Object { $_.handle -eq "ardanila" })
  if ($person.Count -ne 1) { Fail "не найден единственный профиль @ardanila" }
  $userRef = "user:$($person[0].id)"
  $opened = Read-JsonCommand $hchat @("open", $userRef, "--confirm")
  $conversation = @($opened.refs | Where-Object { $_.type -eq "conversation" }) | Select-Object -First 1
  if (-not $conversation) { Fail "не удалось открыть прямой чат с @ardanila" }
  $conversationRef = "conversation:$($conversation.id)"
  $nonce = [guid]::NewGuid().ToString("N")
  $expected = "HOBBYKA_AGENT_CHAT_OK $nonce"
  $message = "Тест связи после восстановления Agent Chat на Windows. Ответьте ровно: $expected"
  $sent = Read-JsonInputCommand $hchat @("send", $conversationRef, "--stdin", "--confirm") $message
  $sentMessage = @($sent.refs | Where-Object { $_.type -eq "message" }) | Select-Object -First 1
  if (-not $sentMessage) { Fail "сервер не подтвердил отправленное тестовое сообщение" }

  $reply = $null
  for ($attempt = 0; $attempt -lt 60 -and -not $reply; $attempt++) {
    if ($attempt -gt 0) { Start-Sleep -Seconds 5 }
    $messages = Read-JsonCommand $hchat @("read", $conversationRef)
    $reply = @($messages.result.items | Where-Object {
      $_.sender_user_id -eq $person[0].id -and $_.id -ne $sentMessage.id -and $_.body_markdown -match [regex]::Escape($expected)
    }) | Select-Object -Last 1
  }
  if (-not $reply) { Fail "за 5 минут не получен проверочный ответ от @ardanila с кодом $nonce" }
  Read-JsonCommand $hchat @("mark-read", "message:$($reply.id)", "--confirm") | Out-Null

  Write-Host "`nГОТОВО: всё переустановлено; данные и Inbox сохранены; Router и автообновление работают; тестовое сообщение доставлено, ответ @ardanila подтверждён."
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
