#!/bin/sh
set -eu

fail() { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail "скрипт предназначен для macOS"

codex="$(command -v codex 2>/dev/null || true)"
for candidate in "$HOME/.local/bin/codex" /Applications/ChatGPT.app/Contents/Resources/codex; do
  [ -n "$codex" ] || [ ! -x "$candidate" ] || codex="$candidate"
done
[ -n "$codex" ] || fail "не найден Codex"

node="$(command -v node 2>/dev/null || true)"
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$node" ] || [ ! -x "$candidate" ] || node="$candidate"
done
[ -n "$node" ] || fail "не найден Node.js"
command -v curl >/dev/null 2>&1 || fail "не найден curl"
command -v unzip >/dev/null 2>&1 || fail "не найден unzip"

work="$(mktemp -d "${TMPDIR:-/tmp}/hobbyka-repair.XXXXXX")"
trap 'rm -rf "$work"' EXIT HUP INT TERM

state="$HOME/Library/Application Support/Hobbyka/AgentChat/session.json"
state_hash=""
[ ! -f "$state" ] || state_hash="$(shasum -a 256 "$state" | awk '{print $1}')"

old_service="$HOME/Library/Application Support/Hobbyka/AgentChat/bin/hchat-router"
if [ -x "$old_service" ]; then
  "$old_service" inbox status >"$work/old-status.json" 2>/dev/null || :
fi

printf '1/4 Загружаю официальный Hobbyka Hub…\n'
curl --proto '=https' --tlsv1.2 --fail --location --retry 3 \
  https://github.com/hobbyka-ru/hobbyka-hub-plugin/archive/refs/heads/main.zip \
  --output "$work/hobbyka-hub.zip"
unzip -q "$work/hobbyka-hub.zip" -d "$work"
bootstrap="$work/hobbyka-hub-plugin-main/plugins/hobbyka-hub/bin/hobbyka-hub.mjs"
[ -f "$bootstrap" ] || fail "в официальном архиве нет Hobbyka Hub"

printf '2/4 Восстанавливаю единый обновлятор и переношу старые установки…\n'
HOBBYKA_CODEX_COMMAND="$codex" "$node" "$bootstrap" repair

managed="$HOME/.codex/hobbyka-hub-marketplace/plugins"
hub="$managed/hobbyka-hub/bin/hobbyka-hub.mjs"
[ -f "$hub" ] || fail "Hobbyka Hub не зарегистрирован в Codex"

printf '3/4 Переустанавливаю актуальный Agent Chat без удаления его данных…\n'
HOBBYKA_CODEX_COMMAND="$codex" "$node" "$hub" install hobbyka-agent-chat
HOBBYKA_CODEX_COMMAND="$codex" "$node" "$hub" self-test

hchat="$managed/hobbyka-agent-chat/scripts/hchat"
[ -x "$hchat" ] || fail "Agent Chat не установлен"
"$hchat" version >"$work/version.json"
"$hchat" inbox status >"$work/status.json"
"$codex" plugin list --json >"$work/plugins.json"

printf '4/4 Проверяю версии, Inbox и фоновые службы…\n'
"$node" - "$work/version.json" "$work/status.json" "$work/plugins.json" "${work}/old-status.json" <<'NODE'
const fs = require("node:fs");
const [versionPath, statusPath, pluginsPath, oldStatusPath] = process.argv.slice(2);
const read = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const numbers = (value) => value.split(/[.+-]/).slice(0, 3).map(Number);
const atLeast = (actual, minimum) => {
  const left = numbers(actual), right = numbers(minimum);
  if (left.length < 3 || left.some(Number.isNaN)) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
};
const version = read(versionPath).result?.version ?? "";
if (!atLeast(version, "0.6.11")) throw new Error(`Agent Chat остался на версии ${version || "unknown"}`);
const status = read(statusPath).result ?? {};
if (!status.route?.target_thread_id) throw new Error("Inbox не привязан к задаче Codex");
if (!status.router?.installed || !status.router?.running) throw new Error("router Agent Chat не работает");
if (!status.router?.updater_installed) throw new Error("обновлятор Hobbyka Hub не установлен");
if (fs.existsSync(oldStatusPath)) {
  try {
    const oldTarget = read(oldStatusPath).result?.route?.target_thread_id;
    if (oldTarget && oldTarget !== status.route.target_thread_id) throw new Error("привязка Inbox изменилась");
  } catch (error) {
    if (error.message === "привязка Inbox изменилась") throw error;
  }
}
const installed = read(pluginsPath).installed ?? [];
for (const [name, minimum] of [["hobbyka-hub", "0.4.29"], ["hobbyka-agent-chat", "0.6.11"]]) {
  const plugin = installed.find((item) => item.name === name && item.installed && item.marketplaceName === "hobbyka-hub");
  if (!plugin) throw new Error(`${name} не установлен из управляемого Hobbyka Hub`);
  if (!atLeast(plugin.version, minimum)) throw new Error(`${name} ${plugin.version} старее ${minimum}`);
}
NODE

if [ -n "$state_hash" ]; then
  [ -f "$state" ] || fail "локальная сессия Agent Chat исчезла"
  [ "$(shasum -a 256 "$state" | awk '{print $1}')" = "$state_hash" ] || fail "локальная сессия Agent Chat изменилась"
fi

launchctl print "gui/$(id -u)/ru.hobbyka.hub-updater" >/dev/null 2>&1 || fail "служба автообновления Hobbyka Hub не зарегистрирована"
if launchctl print "gui/$(id -u)/ru.hobbyka.agent-chat-updater" >/dev/null 2>&1; then
  fail "устаревший обновлятор Agent Chat всё ещё зарегистрирован"
fi

printf '\nГОТОВО: Hobbyka Hub и Agent Chat переустановлены и обновлены; данные и привязка Inbox сохранены; router и единый автообновлятор работают.\n'
