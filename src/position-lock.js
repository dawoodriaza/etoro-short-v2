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
// withPositionLock() runs its callback exclusively. Callers queue in
// arrival order and a throwing callback never wedges the queue. Hold the
// lock only while touching positions (manage / open / apply a review /
// EOD close) — never across enrichment or AI calls — and never nest it:
// calling withPositionLock from inside a locked callback deadlocks.
let queueTail = Promise.resolve();
let currentHolder = null;

function withPositionLock(label, callback) {
  const run = queueTail.then(async () => {
    currentHolder = { label, sinceMs: Date.now() };
    try {
      return await callback();
    } finally {
      currentHolder = null;
    }
  });
  // The chain must survive a rejected callback; the caller still sees it.
  queueTail = run.catch(() => {});
  return run;
}

function getPositionLockHolder() {
  return currentHolder ? { ...currentHolder } : null;
}

module.exports = { withPositionLock, getPositionLockHolder };
