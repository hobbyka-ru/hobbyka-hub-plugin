# Hobbyka Hub

Публичный установщик внутреннего каталога плагинов Хоббики.

```sh
codex plugin marketplace add https://github.com/hobbyka-ru/hobbyka-hub-plugin
codex plugin add hobbyka-hub@hobbyka-hub
```

После установки логин и токен не нужны. Подключите VPN-профиль Хоббики: по нему ХАБ определяет сотрудника.

Безопасное восстановление старой macOS-установки с сохранением Agent Chat и Inbox:

```sh
sh scripts/repair-elvira-macos.sh
```

На Windows запустите PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\repair-elvira-windows.ps1
```

Если Node.js отсутствует, сценарий устанавливает официальный LTS через `winget`.
В конце он отправляет `@ardanila` одноразовое тестовое сообщение и подтверждает ответ с тем же кодом.
