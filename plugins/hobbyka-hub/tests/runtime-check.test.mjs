import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OFFICIAL_PLUGINS,
  confirmedWrite,
  pathIsInside,
  parseVerifyArgs,
  runRuntimeVerification,
  runtimeScenarioCatalog,
  windowsRuntimeTaskXML,
  windowsVerifyLauncher,
} from "../bin/runtime-check.mjs";

test("marketplace paths stay inside their root on Windows", () => {
  assert.equal(pathIsInside("C:\\Hub", "C:\\Hub\\plugins\\work-memory", "\\"), true);
  assert.equal(pathIsInside("C:\\Hub", "C:\\Hub-evil\\plugin", "\\"), false);
});

test("outcome_unknown writes are never retried automatically", () => {
  let calls = 0;
  const ctx = {
    state: { uncertainWrites: {} },
    spawn: (_executable, args) => {
      calls++;
      return args.includes("--yes") ? ok('{"status":"outcome_unknown"}') : ok('{"status":"ok"}');
    },
  };
  const preview = { executable: "fixture", args: [] };
  const confirm = { executable: "fixture", args: ["--yes"] };
  const first = confirmedWrite(ctx, preview, confirm, { logical: "fixture", key: "fixture:1" });
  const second = confirmedWrite(ctx, preview, confirm, { logical: "fixture", key: "fixture:1" });
  assert.equal(first.outcome.status, "blocked");
  assert.equal(second.outcome.status, "blocked");
  assert.equal(calls, 2);
});

test("verify contract exposes unique scenarios for the official allowlist", () => {
  assert.deepEqual(parseVerifyArgs(["--mode", "post-update", "--plugin", "work-memory", "--json"]), { mode: "post-update", plugin: "work-memory", list: false, json: true });
  assert.throws(() => parseVerifyArgs(["--mode", "post-update"]), /--plugin/);
  assert.throws(() => parseVerifyArgs(["--mode", "daily", "--plugin", "unknown"]), /шести официальных/);
  const catalog = runtimeScenarioCatalog();
  assert.equal(new Set(catalog.map((item) => item.id)).size, catalog.length);
  assert.deepEqual([...new Set(catalog.filter((item) => item.plugin !== "environment").map((item) => item.plugin))].sort(), [...OFFICIAL_PLUGINS].sort());
  assert.ok(catalog.every((item) => /^[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+/.test(item.id)));
});

test("Windows runtime task is hidden, bounded and fixed to Moscow time", () => {
  const launcher = windowsVerifyLauncher("C:\\Program Files\\node.exe", "C:\\Users\\Danya Test\\hub.mjs", "C:\\Users\\Danya Test\\codex.cmd");
  assert.match(launcher, /verify --mode daily --json/);
  assert.match(launcher, /HOBBYKA_CODEX_COMMAND/);
  const beforeSix = windowsRuntimeTaskXML("S-1-5-21-1", "C:\\Danya Test\\verify-hidden.vbs", new Date("2026-08-27T02:00:00Z"));
  const afterSix = windowsRuntimeTaskXML("S-1-5-21-1", "C:\\Danya Test\\verify-hidden.vbs", new Date("2026-08-27T04:00:00Z"));
  assert.match(beforeSix, /2026-08-27T06:00:00\+03:00/);
  assert.match(afterSix, /2026-08-28T06:00:00\+03:00/);
  assert.match(beforeSix, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(beforeSix, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(beforeSix, /<ExecutionTimeLimit>PT30M<\/ExecutionTimeLimit>/);
  assert.match(beforeSix, /<RunLevel>LeastPrivilege<\/RunLevel>/);
});

test("daily runtime run passes with configured fixtures and sanitized local state", async () => {
  const home = await mkdtemp(join(tmpdir(), "hobbyka-runtime-home-"));
  const stateRoot = join(home, "state");
  const marketplace = join(home, ".codex", "hobbyka-hub-marketplace");
  const plugins = [];
  for (const slug of OFFICIAL_PLUGINS) {
    const root = join(marketplace, "plugins", slug);
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    const manifest = {
      name: slug,
      version: "1.0.0",
      interface: slug === "hobbyka-hub" ? {
        websiteURL: "https://10.8.1.0:8443/plugins/hobbyka-hub",
        privacyPolicyURL: "https://github.com/hobbyka-ru/hobbyka-hub-plugin/blob/main/plugins/hobbyka-hub/PRIVACY.md",
        termsOfServiceURL: "https://github.com/hobbyka-ru/hobbyka-hub-plugin/blob/main/plugins/hobbyka-hub/TERMS.md",
      } : {},
    };
    await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify(manifest));
    if (slug === "hobbyka-agent-chat") {
      await mkdir(join(root, "hooks"), { recursive: true });
      await writeFile(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [], PostToolUse: [] } }));
    }
    if (slug === "work-memory") {
      await writeFile(join(root, ".codex-plugin", "post-update.mjs"), "");
      await mkdir(join(root, "scripts"), { recursive: true });
      await writeFile(join(root, "scripts", "work-memory.ps1"), "");
    }
    plugins.push({ name: slug, source: { source: "local", path: `./plugins/${slug}` }, policy: { installation: "AVAILABLE" } });
  }
  await mkdir(join(marketplace, ".agents", "plugins"), { recursive: true });
  await writeFile(join(marketplace, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "hobbyka-hub", plugins }));
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, "config.json"), JSON.stringify({
    schemaVersion: 1,
    liveWrites: true,
    codexDiscovery: true,
    agentChat: { testTargetQuery: "codex-vps-test", threadId: "" },
    onec: { metadataType: "Documents", metadataMask: "Заказ" },
    amo: { leadId: "123", leadName: "[AUTO-CODEX-WIN] Runtime" },
    commercialOffers: { itemId: "7112", quantity: 1, offerNumber: "AUTO-1", allowCreate: false },
    workMemory: { allowSetup: true },
  }));
  await writeFile(join(stateRoot, "state.json"), JSON.stringify({ schemaVersion: 1, activeFailures: {}, appliedVersions: {}, testRefs: { offerNumber: "AUTO-1" } }));

  const installed = OFFICIAL_PLUGINS.map((name) => ({ name, version: "1.0.0", installed: true, marketplaceName: "hobbyka-hub" }));
  const spawn = (executable, args) => {
    if (args[0] === "--version") return ok("codex 1.2.3");
    if (args.join(" ").includes("plugin list --json")) return ok(JSON.stringify({ installed }));
    if (args[0] === "exec") return ok(`${OFFICIAL_PLUGINS.join(" ")} SessionStart PostToolUse`);
    return ok('{"status":"ok","ok":true}');
  };
  const verification = await runRuntimeVerification(["--mode", "daily", "--json"], {
    home,
    stateRoot,
    platform: "win32",
    arch: "x64",
    spawn,
    fetch: async () => new Response('{"ok":true}', { status: 200 }),
    reportBug: async () => ({ status: "ok", bugId: "00000000-0000-0000-0000-000000000001" }),
  });
  assert.equal(verification.exitCode, 0);
  assert.ok(verification.report.scenarios.length > 20);
  assert.ok(verification.report.scenarios.every((item) => item.status === "pass"));
});

test("the same product failure is reported only once until it passes", async () => {
  const home = await mkdtemp(join(tmpdir(), "hobbyka-runtime-dedupe-"));
  const stateRoot = join(home, "state");
  const marketplace = join(home, ".codex", "hobbyka-hub-marketplace");
  const plugins = [];
  for (const slug of OFFICIAL_PLUGINS) {
    const root = join(marketplace, "plugins", slug);
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: slug,
      version: "1.0.0",
      interface: slug === "hobbyka-hub" ? {
        websiteURL: "https://10.8.1.0:8443/plugins/hobbyka-agent-chat",
        privacyPolicyURL: "https://example.invalid/hobbyka-agent-chat/PRIVACY.md",
        termsOfServiceURL: "https://example.invalid/hobbyka-agent-chat/TERMS.md",
      } : {},
    }));
    plugins.push({ name: slug, source: { source: "local", path: `./plugins/${slug}` } });
  }
  await mkdir(join(marketplace, ".agents", "plugins"), { recursive: true });
  await writeFile(join(marketplace, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "hobbyka-hub", plugins }));
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, "config.json"), JSON.stringify({ schemaVersion: 1, codexDiscovery: true }));
  const installed = OFFICIAL_PLUGINS.map((name) => ({ name, version: "1.0.0", installed: true, marketplaceName: "hobbyka-hub" }));
  const spawn = (_executable, args) => {
    if (args[0] === "--version") return ok("codex 1.2.3");
    if (args.join(" ").includes("plugin list --json")) return ok(JSON.stringify({ installed }));
    if (args[0] === "exec") return ok(`${OFFICIAL_PLUGINS.join(" ")} SessionStart PostToolUse`);
    return ok('{"status":"ok","ok":true}');
  };
  let submissions = 0;
  const options = {
    home,
    stateRoot,
    platform: "win32",
    arch: "x64",
    spawn,
    fetch: async () => new Response('{"ok":true}', { status: 200 }),
    reportBug: async () => { submissions++; return { status: "ok", bugId: "00000000-0000-0000-0000-000000000001" }; },
  };
  const first = await runRuntimeVerification(["--mode", "post-update", "--plugin", "hobbyka-hub", "--json"], options);
  const second = await runRuntimeVerification(["--mode", "post-update", "--plugin", "hobbyka-hub", "--json"], options);
  assert.equal(first.exitCode, 1);
  assert.equal(second.exitCode, 1);
  assert.equal(submissions, 1);
  assert.equal(first.report.reports[0].status, "ok");
  assert.equal(second.report.reports.length, 0);
});

function ok(stdout) { return { status: 0, error: null, stdout, stderr: "", durationMs: 1 }; }
