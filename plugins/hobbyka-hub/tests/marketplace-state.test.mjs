import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteFile, withMarketplaceLock } from "../bin/marketplace-state.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("serializes marketplace mutations and preserves both writers (CR-333)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-marketplace-state-"));
  const state = join(fixture, "marketplace.json");
  let active = 0;
  let maximumActive = 0;

  try {
    await Promise.all(["alpha", "beta"].map((name) => withMarketplaceLock(fixture, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      let previous = [];
      try { previous = JSON.parse(await readFile(state, "utf8")).plugins; } catch (error) { if (error?.code !== "ENOENT") throw error; }
      await delay(30);
      await atomicWriteFile(state, JSON.stringify({ plugins: [...new Set([...previous, name])] }));
      active -= 1;
    })));

    assert.equal(maximumActive, 1);
    assert.deepEqual(JSON.parse(await readFile(state, "utf8")).plugins.sort(), ["alpha", "beta"]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("atomic marketplace writes never expose partial JSON (CR-333)", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-marketplace-atomic-"));
  const state = join(fixture, "marketplace.json");
  const failures = [];

  try {
    await Promise.all([
      (async () => {
        for (let version = 0; version < 30; version += 1) await atomicWriteFile(state, JSON.stringify({ version, plugins: ["hobbyka-hub"] }));
      })(),
      (async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try { JSON.parse(await readFile(state, "utf8")); } catch (error) { if (error?.code !== "ENOENT") failures.push(error); }
          await delay(1);
        }
      })(),
    ]);
    assert.deepEqual(failures, []);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("reclaims a crashed ownerless lock before the production acquisition timeout", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-marketplace-stale-"));
  const lock = join(fixture, ".hobbyka-hub.lock");
  try {
    await writeFile(lock, "");
    const staleAt = new Date(Date.now() - 2_000);
    await utimes(lock, staleAt, staleAt);
    let entered = false;
    await withMarketplaceLock(fixture, async () => { entered = true; }, { timeoutMs: 120_000, staleAfterMs: 300_000 });
    assert.equal(entered, true);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("bounds waiting on a live but abandoned lock", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hobbyka-marketplace-timeout-"));
  const lock = join(fixture, ".hobbyka-hub.lock");
  try {
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "hung" }));
    await assert.rejects(withMarketplaceLock(fixture, async () => {}, { timeoutMs: 60, staleAfterMs: 300_000 }), /блокировку marketplace/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
