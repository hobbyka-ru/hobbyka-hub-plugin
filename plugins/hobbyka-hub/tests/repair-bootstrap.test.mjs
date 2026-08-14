import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../bin/hobbyka-hub.mjs", import.meta.url), "utf8");

test("repair bootstraps the managed marketplace before updating legacy plugins", () => {
  assert.match(source, /command === "repair"/);
  const repair = source.match(/async function repair\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(repair, /configureMarketplace/);
  assert.match(repair, /enableAutoupdate/);
  assert.match(repair, /await update/);
});

test("normal install immediately reconciles legacy Hobbyka plugins", () => {
  const dispatch = source.match(/else if \(command === "install"\)[^\n]+/)?.[0] ?? "";
  assert.match(dispatch, /installAndReconcile/);
});

test("macOS repair script preserves Agent Chat state and verifies the real services", async () => {
  const scriptURL = new URL("../../../scripts/repair-elvira-macos.sh", import.meta.url);
  const repair = await readFile(scriptURL, "utf8");
  execFileSync("/bin/sh", ["-n", scriptURL.pathname]);
  assert.match(repair, /"\$bootstrap" repair/);
  assert.match(repair, /install hobbyka-agent-chat/);
  assert.match(repair, /inbox status/);
  assert.match(repair, /ru\.hobbyka\.hub-updater/);
  assert.match(repair, /ru\.hobbyka\.agent-chat-updater/);
  assert.match(repair, /state_hash/);
  assert.doesNotMatch(repair, /rm -rf [^"']*(?:AgentChat|\.codex)/);
});

test("Windows repair script preserves Agent Chat state and verifies scheduled tasks", async () => {
  const repair = await readFile(new URL("../../../scripts/repair-elvira-windows.ps1", import.meta.url), "utf8");
  assert.match(repair, /hobbyka-hub\.mjs.*repair/s);
  assert.match(repair, /install.*hobbyka-agent-chat/s);
  assert.match(repair, /"inbox", "status"/);
  assert.match(repair, /Hobbyka Hub Auto Update/);
  assert.match(repair, /Hobbyka Agent Chat Updater/);
  assert.match(repair, /Get-FileHash/);
  assert.match(repair, /target_thread_id/);
  assert.match(repair, /winget\.exe.*OpenJS\.NodeJS\.LTS/s);
  assert.match(repair, /find.*colleague.*ardanila/s);
  assert.match(repair, /\$userRef = "user:.*@\("open", \$userRef, "--confirm"\)/s);
  assert.match(repair, /\$conversationRef = "conversation:.*@\("send", \$conversationRef, "--stdin", "--confirm"\)/s);
  assert.match(repair, /@\("read", \$conversationRef\)/);
  assert.match(repair, /@\("mark-read", "message:\$\(\$reply\.id\)", "--confirm"\)/);
  assert.doesNotMatch(repair, /Remove-Item[^\n]*(?:AgentChat|\.codex)/i);
});
