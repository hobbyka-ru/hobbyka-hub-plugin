import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("../skills/hobbyka-bug-report/SKILL.md", import.meta.url), "utf8");

test("bug evidence installs and calls the bundled Agent Chat launcher", () => {
  assert.match(skill, /install hobbyka-agent-chat/);
  assert.match(skill, /scripts\\hchat\.ps1/);
  assert.match(skill, /scripts\/hchat/);
  assert.doesNotMatch(skill, /`hchat comment/);
});
