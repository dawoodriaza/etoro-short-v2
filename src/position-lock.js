// src/position-lock.js
//
// v8 (2026-09-12) — ONE LOCK FOR EVERY FLOW THAT READS-THEN-WRITES
// data/position-meta.json.
//
// Before this, index.js coordinated its flows with three booleans
// (scanInProgress / exitCheckInProgress / reviewInProgress). Those only make
// flows SKIP each other, and they left two real gaps:
//
//   1. Two writers were never covered at all: the EOD force-close cron and
//      the daily reviewer's save after its (minutes-long) AI calls. Either
//      could write back a stale copy of the meta file, silently dropping a
//      position opened in between — no stop, no EOD close, "UNTRACKED".
//
//   2. The exit monitor AND the price-stream emergency path both skipped
//      for the entire scan. Measured on the live server in Sep 2026 a scan
//      averages ~133s, so stops went unenforced for roughly a fifth of every
//      trading hour.
//
// v8.1 (2026-09-13) — ACROSS PROCESSES TOO.
//
// src/close-position.js runs as its own process while the bot is live, so
// an in-process queue alone could not stop the two from reading the same
// meta file and writing conflicting copies back. Each holder now also owns
// data/position-meta.lock, created with O_EXCL. A lock left behind by a
// process that died is taken over immediately (its pid is gone); one held
// longer than LOCK_STALE_MS is treated as hung. A caller never waits more
// than LOCK_WAIT_LIMIT_MS — exits must not stall forever behind a stuck
// manual tool — and says so loudly if it has to take the lock by force.
//
// withPositionLock() runs its callback exclusively. Callers queue in
// arrival order and a throwing callback never wedges the queue. Hold the
// lock only while touching positions (manage / open / apply a review /
// EOD close / manual close) — never across enrichment or AI calls — and
// never nest it: calling withPositionLock inside a locked callback deadlocks.
const fs = require("fs");
const path = require("path");

const LOCK_FILE_PATH =
  process.env.DT_POSITION_LOCK_FILE ||
  path.join(__dirname, "../data/position-meta.lock");
const LOCK_POLL_MS = 150;
const LOCK_WAIT_LIMIT_MS = 90 * 1000;
const LOCK_STALE_MS = 5 * 60 * 1000;
// A lock file with no readable content was interrupted mid-write.
const UNREADABLE_LOCK_STALE_MS = 10 * 1000;

let queueTail = Promise.resolve();
let currentHolder = null;
let tokenCounter = 0;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLockFile() {
  try {
    const stat = fs.statSync(LOCK_FILE_PATH);
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(LOCK_FILE_PATH, "utf8"));
    } catch {
      holder = null;
    }
    return { holder, ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null; // no lock file
  }
}

function tryCreateLockFile(record) {
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE_PATH), { recursive: true });
    fs.writeFileSync(LOCK_FILE_PATH, JSON.stringify(record), { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

// Remove the lock file only if it still holds the token we judged stale —
// never a lock someone else created in the meantime.
function removeLockFileIfHeldBy(expectedToken) {
  const current = readLockFile();
  if (!current) return;
  const currentToken = current.holder ? current.holder.token : undefined;
  if (currentToken !== expectedToken) return;
  try {
    fs.unlinkSync(LOCK_FILE_PATH);
  } catch {
    /* already gone */
  }
}

async function acquireFileLock(label) {
  const token = process.pid + ":" + ++tokenCounter + ":" + Date.now();
  const startedMs = Date.now();
  for (;;) {
    if (tryCreateLockFile({ pid: process.pid, label, token, atMs: Date.now() })) {
      return token;
    }
    const existing = readLockFile();
    if (!existing) continue; // released between our attempt and the read

    const { holder, ageMs } = existing;
    const stale = holder
      ? !processIsAlive(holder.pid) || ageMs > LOCK_STALE_MS
      : ageMs > UNREADABLE_LOCK_STALE_MS;
    const waitedTooLong = Date.now() - startedMs > LOCK_WAIT_LIMIT_MS;

    if (stale || waitedTooLong) {
      if (!stale) {
        // eslint-disable-next-line no-console
        console.warn(
          "[position-lock] " +
            label +
            " waited " +
            Math.round((Date.now() - startedMs) / 1000) +
            "s for " +
            (holder ? holder.label + " (pid " + holder.pid + ")" : "an unreadable lock") +
            " — taking the lock so position management does not stall",
        );
      }
      removeLockFileIfHeldBy(holder ? holder.token : undefined);
      continue;
    }
    await pause(LOCK_POLL_MS);
  }
}

function releaseFileLock(token) {
  removeLockFileIfHeldBy(token);
}

function withPositionLock(label, callback) {
  const run = queueTail.then(async () => {
    const token = await acquireFileLock(label);
    currentHolder = { label, sinceMs: Date.now() };
    try {
      return await callback();
    } finally {
      currentHolder = null;
      releaseFileLock(token);
    }
  });
  // The chain must survive a rejected callback; the caller still sees it.
  queueTail = run.catch(() => {});
  return run;
}

function getPositionLockHolder() {
  return currentHolder ? { ...currentHolder } : null;
}

module.exports = {
  withPositionLock,
  getPositionLockHolder,
  LOCK_FILE_PATH,
  // exported for tests
  processIsAlive,
};
