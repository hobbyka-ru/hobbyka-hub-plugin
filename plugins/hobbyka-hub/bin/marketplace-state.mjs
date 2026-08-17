import { mkdir, mkdtemp, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const retryDelayMs = 25;
const defaultTimeoutMs = 120_000;
const defaultStaleAfterMs = 300_000;
const defaultOwnerlessStaleAfterMs = 1_000;

export async function withMarketplaceLock(root, action, { timeoutMs = defaultTimeoutMs, staleAfterMs = defaultStaleAfterMs, ownerlessStaleAfterMs = defaultOwnerlessStaleAfterMs } = {}) {
  await mkdir(root, { recursive: true });
  const lockPath = join(root, ".hobbyka-hub.lock");
  const owner = JSON.stringify({ pid: process.pid, token: `${process.pid}-${Date.now()}-${Math.random()}` });
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    let candidate;
    try {
      candidate = await open(lockPath, "wx");
      await candidate.writeFile(owner, "utf8");
      handle = candidate;
      candidate = undefined;
    } catch (error) {
      if (candidate) {
        try { await candidate.close(); } finally { await rm(lockPath, { force: true }); }
      }
      if (error?.code !== "EEXIST") throw error;
      await reclaimDeadLock(lockPath, staleAfterMs, ownerlessStaleAfterMs);
      if (Date.now() >= deadline) throw new Error(`Не удалось получить блокировку marketplace за ${timeoutMs} мс.`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, Math.max(1, deadline - Date.now()))));
    }
  }
  const heartbeatDelay = Math.max(1, Math.min(Math.floor(staleAfterMs / 3), 10_000));
  const heartbeat = setInterval(() => { void utimes(lockPath, new Date(), new Date()).catch(() => {}); }, heartbeatDelay);
  heartbeat.unref?.();
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    await handle.close();
    try {
      if ((await readFile(lockPath, "utf8")) === owner) await rm(lockPath, { force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export async function atomicWriteFile(path, data) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(directory, `.${basename(path)}-`));
  const temporaryPath = join(temporaryDirectory, basename(path));
  try {
    await writeFile(temporaryPath, data);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function atomicCopyFile(source, destination) {
  await atomicWriteFile(destination, await readFile(source));
}

async function reclaimDeadLock(lockPath, staleAfterMs, ownerlessStaleAfterMs) {
  let metadata;
  try { metadata = await stat(lockPath); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  let owner;
  try { owner = await readFile(lockPath, "utf8"); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  let ownerData;
  try { ownerData = JSON.parse(owner); } catch { if (Date.now() - metadata.mtimeMs < ownerlessStaleAfterMs) return; }
  const validOwner = ownerData && Number.isInteger(ownerData.pid) && ownerData.pid > 0;
  if (ownerData && !validOwner) { if (Date.now() - metadata.mtimeMs < ownerlessStaleAfterMs) return; }
  if (ownerData?.pid) {
    try { process.kill(ownerData.pid, 0); if (Date.now() - metadata.mtimeMs < staleAfterMs) return; } catch (error) { if (error?.code !== "ESRCH" && Date.now() - metadata.mtimeMs < staleAfterMs) return; }
  } else if (Date.now() - metadata.mtimeMs < ownerlessStaleAfterMs) return;
  try {
    if ((await readFile(lockPath, "utf8")) === owner) await rm(lockPath, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
