import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/hobbyka-hub.mjs", import.meta.url));

async function runDisable({ fixture, preload, platform: platformOverride, mode, trace }) {
  return await new Promise((resolve) => {
    const args = preload ? ["--import", preload, cli, "autoupdate", "disable"] : [cli, "autoupdate", "disable"];
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        HOME: fixture,
        PATH: `${fixture}:${process.env.PATH ?? ""}`,
        HOBBYKA_HUB_CA_READY: "1",
        ...(platformOverride ? { CR336_PLATFORM: platformOverride } : {}),
        ...(mode ? { CR336_MODE: mode } : {}),
        ...(trace ? { CR336_TRACE: trace } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (status) => resolve({ status, output }));
  });
}

async function writePlatformPreload(path) {
  await writeFile(path, `
if (process.env.CR336_PLATFORM) {
  Object.defineProperty(process, "platform", { value: process.env.CR336_PLATFORM });
  Object.defineProperty(process, "getuid", { value: () => 501 });
}
`, "utf8");
}

test("autoupdate disable fails when scheduler refuses and succeeds when job is already absent (CR-336)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-autoupdate-disable-"));
  const launchctl = join(fixture, "launchctl");
  const launchctlTrace = join(fixture, "launchctl.trace");
  const plist = join(fixture, "Library", "LaunchAgents", "ru.hobbyka.hub-updater.plist");

  try {
    await mkdir(join(fixture, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(launchctl, `#!/bin/sh
printf '%s %s\\n' "$CR336_MODE" "$*" >> "$CR336_TRACE"
if [ "$CR336_MODE" = failure ]; then
  case "$1" in
    bootout) exit 77 ;;
    print) exit 0 ;;
  esac
else
  case "$1" in
    bootout) exit 113 ;;
    print) exit 1 ;;
  esac
fi
`, { mode: 0o755 });

    const runMacDisable = async (mode) => {
      await writeFile(plist, "job\n", "utf8");
      return await runDisable({ fixture, mode, trace: launchctlTrace });
    };

    const failure = await runMacDisable("failure");
    assert.notEqual(failure.status, 0, failure.output);
    assert.doesNotMatch(failure.output, /Автообновление выключено/);
    assert.equal(await readFile(plist, "utf8"), "job\n");

    const absent = await runMacDisable("absent");
    assert.equal(absent.status, 0, absent.output);
    assert.match(absent.output, /Автообновление выключено/);
    await assert.rejects(readFile(plist, "utf8"), { code: "ENOENT" });
    const trace = await readFile(launchctlTrace, "utf8");
    assert.match(trace, /failure bootout/);
    assert.match(trace, /failure print/);
    assert.match(trace, /absent bootout/);
    assert.match(trace, /absent print/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("autoupdate disable fails closed when Linux scheduler state is unknown and accepts only inactive disabled/not-found (CR-336)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-autoupdate-disable-linux-"));
  const preload = join(fixture, "platform-preload.mjs");
  const systemctl = join(fixture, "systemctl");
  const systemctlTrace = join(fixture, "systemctl.trace");
  const systemdRoot = join(fixture, ".config", "systemd", "user");
  const timer = join(systemdRoot, "hobbyka-hub-updater.timer");
  const service = join(systemdRoot, "hobbyka-hub-updater.service");

  try {
    await writePlatformPreload(preload);
    await writeFile(systemctl, `#!/bin/sh
printf '%s %s\\n' "$CR336_MODE" "$*" >> "$CR336_TRACE"
if [ "$1" = "--user" ]; then shift; fi
case "$1" in
  disable) exit 0 ;;
  daemon-reload) exit 0 ;;
  show)
    case "$CR336_MODE" in
      query-failure) exit 42 ;;
      active) printf 'LoadState=loaded\\nActiveState=active\\nUnitFileState=enabled\\n' ;;
      disabled) printf 'LoadState=loaded\\nActiveState=inactive\\nUnitFileState=disabled\\n' ;;
      not-found) printf 'LoadState=not-found\\nActiveState=inactive\\nUnitFileState=\\n' ;;
    esac
    ;;
esac
exit 0
`, { mode: 0o755 });

    const prepareUnits = async () => {
      await mkdir(systemdRoot, { recursive: true });
      await writeFile(timer, "timer\n", "utf8");
      await writeFile(service, "service\n", "utf8");
    };
    const runLinux = async (mode) => {
      await prepareUnits();
      return await runDisable({ fixture, preload, platform: "linux", mode, trace: systemctlTrace });
    };

    const queryFailure = await runLinux("query-failure");
    assert.notEqual(queryFailure.status, 0, queryFailure.output);
    assert.doesNotMatch(queryFailure.output, /Автообновление выключено/);
    assert.equal(await readFile(timer, "utf8"), "timer\n");

    const active = await runLinux("active");
    assert.notEqual(active.status, 0, active.output);
    assert.doesNotMatch(active.output, /Автообновление выключено/);
    assert.equal(await readFile(timer, "utf8"), "timer\n");

    const disabled = await runLinux("disabled");
    assert.equal(disabled.status, 0, disabled.output);
    assert.match(disabled.output, /Автообновление выключено/);
    await assert.rejects(readFile(timer, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(service, "utf8"), { code: "ENOENT" });

    const notFound = await runLinux("not-found");
    assert.equal(notFound.status, 0, notFound.output);
    assert.match(notFound.output, /Автообновление выключено/);
    await assert.rejects(readFile(timer, "utf8"), { code: "ENOENT" });
    const trace = await readFile(systemctlTrace, "utf8");
    assert.match(trace, /query-failure --user disable --now hobbyka-hub-updater.timer/);
    assert.match(trace, /query-failure --user show hobbyka-hub-updater.timer --property=LoadState,ActiveState,UnitFileState/);
    assert.match(trace, /active --user show hobbyka-hub-updater.timer/);
    assert.match(trace, /disabled --user daemon-reload/);
    assert.match(trace, /not-found --user show hobbyka-hub-updater.timer/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("autoupdate disable reports a present Windows task and succeeds only when it is absent (CR-336)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-autoupdate-disable-windows-"));
  const preload = join(fixture, "platform-preload.mjs");
  const schtasks = join(fixture, "schtasks.exe");
  const tracePath = join(fixture, "schtasks.trace");

  try {
    await writePlatformPreload(preload);
    await writeFile(schtasks, `#!/bin/sh
printf '%s %s\\n' "$CR336_MODE" "$*" >> "$CR336_TRACE"
case "$1" in
  /Delete) exit 0 ;;
  /Query)
    case "$CR336_MODE" in
      present) exit 0 ;;
      absent) exit 1 ;;
      query-failure) exit 5 ;;
    esac
    ;;
esac
exit 0
`, { mode: 0o755 });

    const present = await runDisable({ fixture, preload, platform: "win32", mode: "present", trace: tracePath });
    assert.notEqual(present.status, 0, present.output);
    assert.doesNotMatch(present.output, /Автообновление выключено/);

    const absent = await runDisable({ fixture, preload, platform: "win32", mode: "absent", trace: tracePath });
    assert.equal(absent.status, 0, absent.output);
    assert.match(absent.output, /Автообновление выключено/);

    const queryFailure = await runDisable({ fixture, preload, platform: "win32", mode: "query-failure", trace: tracePath });
    assert.notEqual(queryFailure.status, 0, queryFailure.output);
    assert.doesNotMatch(queryFailure.output, /Автообновление выключено/);
    const trace = await readFile(tracePath, "utf8");
    assert.match(trace, /present \/Delete/);
    assert.match(trace, /present \/Query/);
    assert.match(trace, /absent \/Query/);
    assert.match(trace, /query-failure \/Query/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
