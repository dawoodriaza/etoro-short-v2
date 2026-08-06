// src/strategies/capital-manager.js
//
// v6 (2026-07-21, review-driven upgrade) — LIVE EQUITY RECONCILIATION.
//   effectiveCapital was PURELY a local ledger number (baseCapital +
//   cumulative realized P&L that THIS bot recorded), never checked against
//   the REAL eToro agent-portfolio equity. Any gap between the two — a
//   ghost/untracked position closing outside the bot's own exit path (see
//   index.js's v6 ghost-position fix), a manual intervention on eToro, or
//   just ledger drift over time — meant sizing, the daily loss limit, and
//   the drawdown circuit breaker were all computed against a number that
//   might not match the real account AT ALL. reconcileWithLiveEquity() is
//   now called once per scan cycle with the REAL fetched equity: if it
//   drifts from the ledger's computed effectiveCapital by more than
//   config.capitalReconciliationTolerancePct, the ledger's
//   cumulativeRealizedPnl is corrected so effectiveCapital exactly matches
//   the live account going forward — loudly logged/alerted, never silent.
//   Peak/drawdown/de-risking bookkeeping (which only need EFFECTIVE
//   capital, not the raw ledger fields) automatically inherit the
//   correction on the next read.
//
// v5 (2026-07-04): added the ROLLING DRAWDOWN CIRCUIT BREAKER.
//   The ledger now tracks peakEffectiveCapital (highest effective capital
//   ever recorded). checkDrawdownBreaker() compares current effective
//   capital against that peak; if the drop exceeds
//   config.maxDrawdownFromPeakPct, the breaker trips: data/halt.flag is
//   written and index.js blocks all NEW entries (exits keep running).
//   Recovery is deliberately MANUAL — delete data/halt.flag on the server
//   and restart nothing; the next scan resumes entries. A slow multi-day
//   bleed should stop the bot until a human looks at it, not auto-resume.
//
// v4 jobs retained:
//   1. COMPOUNDING EFFECTIVE CAPITAL.
//        effectiveCapital = baseCapital + cumulative realized P&L
//      floored at capitalFloorPctOfBase × base.
//   2. DRAWDOWN DE-RISKING. After N consecutive losing DAYS the risk
//      multiplier drops until the next green day.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { logger } = require("../logger");
const config = require("../config");

const capitalLedgerPath = path.join(
  __dirname,
  "../../data/capital-ledger.json",
);
const haltFlagPath = path.join(__dirname, "../../data/halt.flag");

function loadLedger() {
  try {
    if (!fs.existsSync(capitalLedgerPath)) {
      return {
        baseCapital: config.dayTradeCapital,
        ownerAdjustments: 0, // v7.1: net owner deposits/withdrawals
        cumulativeRealizedPnl: 0,
        peakEffectiveCapital: config.dayTradeCapital,
        dailyPnl: {}, // { "YYYY-MM-DD": netDollars }
      };
    }
    const ledger = JSON.parse(fs.readFileSync(capitalLedgerPath, "utf8"));
    // If the user raises DT_CAPITAL in .env, honor the new base.
    ledger.baseCapital = config.dayTradeCapital;
    if (!ledger.dailyPnl) ledger.dailyPnl = {};
    // v7.1: ledgers written before owner-transfer tracking existed simply
    // have no adjustments yet — zero is the correct migration.
    if (typeof ledger.ownerAdjustments !== "number") {
      ledger.ownerAdjustments = 0;
    }
    if (typeof ledger.peakEffectiveCapital !== "number") {
      ledger.peakEffectiveCapital =
        computeEffectiveBase(ledger) + Number(ledger.cumulativeRealizedPnl || 0);
    }
    return ledger;
  } catch {
    return {
      baseCapital: config.dayTradeCapital,
      ownerAdjustments: 0,
      cumulativeRealizedPnl: 0,
      peakEffectiveCapital: config.dayTradeCapital,
      dailyPnl: {},
    };
  }
}

function saveLedger(ledger) {
  try {
    const directory = path.dirname(capitalLedgerPath);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(capitalLedgerPath, JSON.stringify(ledger, null, 2));
  } catch (saveError) {
    logger.warn("Could not save capital ledger: " + saveError.message);
  }
}

function todayKeyEastern() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

// ═══════════════════════════════════════════════════════════════════════
// v7.1 — OWNER DEPOSITS AND WITHDRAWALS.
//
// Money the OWNER moves in or out of the eToro account is not trading
// P&L, but before v7.1 the bot had no way to tell the two apart — both
// simply looked like equity changing. Two things broke as a result:
//
//   1. THE DRAWDOWN BREAKER HALTED THE BOT ON A WITHDRAWAL. peak is only
//      ever allowed to rise, so withdrawing $3,000 from a $9,300 account
//      with a $10,032 peak reads as a 37% drawdown against a 15% limit —
//      halt.flag is written and every new entry stops until someone SSHes
//      in and deletes it.
//   2. THE CAPITAL FLOOR IGNORED THE WITHDRAWAL. floorCapital was
//      baseCapital (a fixed .env number) × 0.4, so after withdrawing down
//      to $2,800 real equity the bot still sized against $4,000 — 43%
//      oversized, then "Insufficient cash" on every order.
//
// FIX: track owner transfers separately from P&L in `ownerAdjustments`.
// The effective BASE moves with them (so the floor scales), and the peak
// is scaled PROPORTIONALLY rather than left frozen.
//
// Why proportional scaling is safe: it preserves the drawdown percentage
// exactly. peak×r vs equity×r gives the same (peak-equity)/peak. So a
// transfer can never hide a drawdown breach that already existed — a book
// 16% underwater before a withdrawal is still 16% underwater after, and
// still trips the breaker.
// ═══════════════════════════════════════════════════════════════════════

// The capital base the owner has actually put in: the .env base plus every
// net deposit/withdrawal since. Everything proportional keys off this.
function computeEffectiveBase(ledger) {
  return ledger.baseCapital + Number(ledger.ownerAdjustments || 0);
}

function computeEffectiveCapital(ledger) {
  const effectiveBase = computeEffectiveBase(ledger);
  // The floor scales with withdrawals — it is a fraction of what the owner
  // actually has in the account, not of a number frozen in .env.
  const floorCapital = Math.max(0, effectiveBase * config.capitalFloorPctOfBase);
  return Math.max(
    floorCapital,
    effectiveBase + Number(ledger.cumulativeRealizedPnl || 0),
  );
}

// Call on EVERY closed trade.
function recordRealizedPnl(pnlDollars) {
  if (typeof pnlDollars !== "number" || isNaN(pnlDollars)) return;
  const ledger = loadLedger();
  ledger.cumulativeRealizedPnl =
    Number(ledger.cumulativeRealizedPnl || 0) + pnlDollars;
  const dayKey = todayKeyEastern();
  ledger.dailyPnl[dayKey] = Number(ledger.dailyPnl[dayKey] || 0) + pnlDollars;

  // v5: keep the peak up to date (peak only ever rises)
  const effectiveCapital = computeEffectiveCapital(ledger);
  if (effectiveCapital > (ledger.peakEffectiveCapital || 0)) {
    ledger.peakEffectiveCapital = effectiveCapital;
  }

  saveLedger(ledger);
}

// Consecutive losing days ending at the most recent RECORDED day.
function computeConsecutiveLosingDays(ledger) {
  const recordedDays = Object.keys(ledger.dailyPnl || {}).sort(); // ascending
  let losingStreak = 0;
  for (let index = recordedDays.length - 1; index >= 0; index--) {
    const dayPnl = Number(ledger.dailyPnl[recordedDays[index]] || 0);
    if (dayPnl < 0) losingStreak++;
    else break;
  }
  return losingStreak;
}

// Everything sizing needs, in one object.
function getCapitalState() {
  const ledger = loadLedger();
  const effectiveCapital = computeEffectiveCapital(ledger);

  const consecutiveLosingDays = computeConsecutiveLosingDays(ledger);
  const riskMultiplier =
    consecutiveLosingDays >= config.deriskAfterLosingDays
      ? config.deriskMultiplier
      : 1;

  if (riskMultiplier < 1) {
    logger.warn(
      "🩹 De-risking active: " +
        consecutiveLosingDays +
        " consecutive losing day(s) → risk multiplier ×" +
        riskMultiplier +
        " until a green day",
    );
  }

  return {
    baseCapital: ledger.baseCapital,
    // v7.1: net owner deposits/withdrawals, and the base after them.
    ownerAdjustments: Number(Number(ledger.ownerAdjustments || 0).toFixed(2)),
    effectiveBase: Number(computeEffectiveBase(ledger).toFixed(2)),
    cumulativeRealizedPnl: Number(
      Number(ledger.cumulativeRealizedPnl || 0).toFixed(2),
    ),
    effectiveCapital: Number(effectiveCapital.toFixed(2)),
    peakEffectiveCapital: Number(
      (ledger.peakEffectiveCapital || effectiveCapital).toFixed(2),
    ),
    consecutiveLosingDays,
    riskMultiplier,
  };
}

// ── v5: HALT FLAG (manual kill switch + breaker target) ────────────────────
function isHalted() {
  return fs.existsSync(haltFlagPath);
}

function tripHalt(reason) {
  try {
    fs.writeFileSync(
      haltFlagPath,
      JSON.stringify(
        { trippedAt: new Date().toISOString(), reason },
        null,
        2,
      ),
    );
    logger.error("🛑 HALT FLAG WRITTEN: " + reason);
  } catch (writeError) {
    logger.error("Could not write halt flag: " + writeError.message);
  }
}

// ── v5: ROLLING DRAWDOWN CIRCUIT BREAKER ────────────────────────────────────
// Returns { tripped, alreadyHalted, drawdownPct, peak, effective }.
// Trips (writes halt.flag) at most once — if halt.flag already exists,
// reports alreadyHalted so the caller doesn't re-alert every scan.
function checkDrawdownBreaker() {
  const capitalState = getCapitalState();
  const peak = capitalState.peakEffectiveCapital;
  const effective = capitalState.effectiveCapital;

  if (!peak || peak <= 0) {
    return { tripped: false, alreadyHalted: isHalted(), drawdownPct: 0 };
  }

  const drawdownPct = (peak - effective) / peak;
  const breached = drawdownPct >= config.maxDrawdownFromPeakPct;

  if (breached && !isHalted()) {
    tripHalt(
      "Rolling drawdown breaker: effective capital $" +
        effective.toFixed(2) +
        " is " +
        (drawdownPct * 100).toFixed(1) +
        "% below peak $" +
        peak.toFixed(2) +
        " (limit " +
        config.maxDrawdownFromPeakPct * 100 +
        "%)",
    );
    return {
      tripped: true,
      alreadyHalted: false,
      drawdownPct,
      peak,
      effective,
    };
  }

  return {
    tripped: false,
    alreadyHalted: isHalted(),
    drawdownPct,
    peak,
    effective,
  };
}

// v6: reconcile the local ledger against the REAL eToro agent-portfolio
// equity. Called once per scan cycle with `liveEquity` (portfolio.totalEquity,
// already fetched for other purposes — zero extra API calls). Corrects
// cumulativeRealizedPnl so computeEffectiveCapital(ledger) === liveEquity
// going forward whenever the drift exceeds the configured tolerance; the
// peak is bumped up too if the live figure is a new high (never down —
// the drawdown breaker must never have its bar lowered by a reconciliation).
// Returns { reconciled: bool, driftDollars, driftPct } for the caller to
// log/alert on.
function reconcileWithLiveEquity(liveEquity, options = {}) {
  if (typeof liveEquity !== "number" || isNaN(liveEquity) || liveEquity <= 0) {
    return { reconciled: false, driftDollars: 0, driftPct: 0 };
  }

  // ══════════════════════════════════════════════════════════════════════
  // v7.3 — GUARD AGAINST PHANTOM "WITHDRAWALS".
  //
  // On 2026-07-31 this function converted a reporting artefact into a
  // $6,596.66 phantom withdrawal: two queued orders reserved $6,550 of
  // cash, the equity figure excluded it, and the drift looked exactly like
  // money leaving the account. The capital base, the drawdown peak and all
  // position sizing were rewritten off a number that was never real.
  //
  // The underlying equity bug is fixed in etoro-client.js, but a silent
  // false positive here is destructive enough that it needs its own
  // independent guard. Money movement is never urgent — waiting several
  // cycles to be sure costs nothing, while acting on one bad reading costs
  // the entire capital baseline.
  // ══════════════════════════════════════════════════════════════════════
  const pendingOrderCount = options.pendingOrderCount || 0;
  const ledger = loadLedger();
  const ledgerEffective = computeEffectiveCapital(ledger);
  const driftDollars = liveEquity - ledgerEffective;
  const driftPct = ledgerEffective > 0 ? Math.abs(driftDollars) / ledgerEffective : 0;

  if (driftPct <= config.capitalReconciliationTolerancePct) {
    return { reconciled: false, driftDollars, driftPct };
  }

  // v7.1: a drift this large is money moving in or out of the account, not
  // ordinary ledger slippage — treat it as an owner transfer so the peak
  // scales with it and the drawdown breaker is not tripped by a withdrawal.
  // Below this threshold the old conservative behaviour is kept (correct
  // the ledger, never lower the peak), because a small unexplained gap is
  // more likely an untracked/ghost close than a deliberate transfer.
  const driftLooksLikeTransfer =
    config.capitalAutoDetectTransfers &&
    driftPct >= config.capitalTransferDetectPct;

  // GUARD 1: never while orders are in flight. Reserved cash is the single
  // most likely source of a large, temporary, entirely fake drift.
  if (driftLooksLikeTransfer && pendingOrderCount > 0) {
    logger.warn(
      "💰 Large equity drift ($" +
        driftDollars.toFixed(2) +
        ") but " +
        pendingOrderCount +
        " order(s) are PENDING — NOT treating this as a transfer. Reserved " +
        "order cash is the classic cause of a phantom drift; re-checking " +
        "once the orders settle.",
    );
    ledger.transferConfirmStreak = 0;
    saveLedger(ledger);
    return { reconciled: false, driftDollars, driftPct, blockedByPending: true };
  }

  // GUARD 2: the drift must persist across several consecutive checks in the
  // SAME direction before anything is rewritten. A real transfer is
  // permanent and will still be there next cycle; an artefact will not.
  let looksLikeOwnerTransfer = false;
  if (driftLooksLikeTransfer) {
    const priorStreak = ledger.transferConfirmStreak || 0;
    const priorSign = ledger.transferConfirmSign || 0;
    const currentSign = driftDollars < 0 ? -1 : 1;
    const streak = priorSign === currentSign ? priorStreak + 1 : 1;

    ledger.transferConfirmStreak = streak;
    ledger.transferConfirmSign = currentSign;
    saveLedger(ledger);

    if (streak < config.capitalTransferConfirmCycles) {
      logger.warn(
        "💰 Large equity drift ($" +
          driftDollars.toFixed(2) +
          ", " +
          (driftPct * 100).toFixed(1) +
          "%) seen " +
          streak +
          "/" +
          config.capitalTransferConfirmCycles +
          " consecutive checks — NOT acting yet. A real deposit/withdrawal " +
          "persists; a reporting artefact does not.",
      );
      return {
        reconciled: false,
        driftDollars,
        driftPct,
        awaitingConfirmation: true,
        streak,
      };
    }
    looksLikeOwnerTransfer = true;
  } else {
    // Drift back within tolerance → whatever it was, it was not a transfer.
    if (ledger.transferConfirmStreak) {
      ledger.transferConfirmStreak = 0;
      ledger.transferConfirmSign = 0;
      saveLedger(ledger);
    }
  }

  if (looksLikeOwnerTransfer) {
    ledger.transferConfirmStreak = 0;
    ledger.transferConfirmSign = 0;
    saveLedger(ledger);
    const result = applyCapitalTransfer(
      driftDollars,
      driftDollars < 0
        ? "auto-detected withdrawal (live equity fell well below the ledger)"
        : "auto-detected deposit (live equity rose well above the ledger)",
    );
    return {
      reconciled: true,
      driftDollars,
      driftPct,
      treatedAsTransfer: true,
      newPeak: result.newPeak,
      previousPeak: result.previousPeak,
    };
  }

  const effectiveBase = computeEffectiveBase(ledger);
  const floorCapital = Math.max(0, effectiveBase * config.capitalFloorPctOfBase);
  // Re-derive cumulativeRealizedPnl so the NEXT computeEffectiveCapital()
  // call returns exactly liveEquity (unless the capital floor would clamp
  // it — the floor is a deliberate risk control and must still apply).
  const targetEffective = Math.max(floorCapital, liveEquity);
  ledger.cumulativeRealizedPnl = targetEffective - effectiveBase;

  if (targetEffective > (ledger.peakEffectiveCapital || 0)) {
    ledger.peakEffectiveCapital = targetEffective;
  }

  saveLedger(ledger);

  logger.warn(
    "💰 CAPITAL RECONCILED: ledger said $" +
      ledgerEffective.toFixed(2) +
      " effective, live eToro equity is $" +
      liveEquity.toFixed(2) +
      " (drift $" +
      driftDollars.toFixed(2) +
      ", " +
      (driftPct * 100).toFixed(1) +
      "%) — corrected the ledger to match the REAL account. This can happen " +
      "after a ghost/untracked position closed outside the bot's own exit " +
      "path, a deposit/withdrawal, or manual intervention on eToro.",
  );

  return { reconciled: true, driftDollars, driftPct, treatedAsTransfer: false };
}

// ── v7.1: OWNER DEPOSIT / WITHDRAWAL ───────────────────────────────────────
// The exact, unambiguous path. Positive = money added, negative = money
// removed. Use src/capital-adjust.js on the server for a declared transfer;
// reconcileWithLiveEquity() calls this itself when it auto-detects one.
//
// Adjusts the capital base (so sizing and the floor both follow the real
// account) and scales the peak PROPORTIONALLY, which preserves the current
// drawdown percentage exactly — the breaker is neither falsely tripped by a
// withdrawal nor silently disarmed by one.
function applyCapitalTransfer(amountDollars, note) {
  if (typeof amountDollars !== "number" || isNaN(amountDollars) || amountDollars === 0) {
    return { applied: false, reason: "invalid or zero amount" };
  }

  const ledger = loadLedger();
  const equityBefore = computeEffectiveCapital(ledger);
  const previousPeak = ledger.peakEffectiveCapital || equityBefore;

  ledger.ownerAdjustments =
    Number(ledger.ownerAdjustments || 0) + amountDollars;

  const equityAfter = computeEffectiveCapital(ledger);

  // Scale the peak by the same ratio the equity moved, so drawdown % is
  // unchanged by the transfer itself.
  if (equityBefore > 0 && equityAfter > 0) {
    const scaleRatio = equityAfter / equityBefore;
    ledger.peakEffectiveCapital = Number(
      (previousPeak * scaleRatio).toFixed(2),
    );
  }

  // A transfer is NOT trading P&L: dailyPnl is deliberately untouched, so
  // this can never create or extend a "losing day" or trigger de-risking.
  ledger.transferHistory = (ledger.transferHistory || []).concat([
    {
      at: new Date().toISOString(),
      amountDollars: Number(amountDollars.toFixed(2)),
      note: note || "",
      equityBefore: Number(equityBefore.toFixed(2)),
      equityAfter: Number(equityAfter.toFixed(2)),
      peakBefore: Number(previousPeak.toFixed(2)),
      peakAfter: ledger.peakEffectiveCapital,
    },
  ]);

  saveLedger(ledger);

  const drawdownBefore =
    previousPeak > 0 ? ((previousPeak - equityBefore) / previousPeak) * 100 : 0;
  const drawdownAfter =
    ledger.peakEffectiveCapital > 0
      ? ((ledger.peakEffectiveCapital - equityAfter) /
          ledger.peakEffectiveCapital) *
        100
      : 0;

  logger.warn(
    "🏦 CAPITAL TRANSFER: " +
      (amountDollars < 0 ? "withdrawal of $" : "deposit of $") +
      Math.abs(amountDollars).toFixed(2) +
      (note ? " (" + note + ")" : "") +
      " — effective capital $" +
      equityBefore.toFixed(2) +
      " → $" +
      equityAfter.toFixed(2) +
      ", peak rescaled $" +
      previousPeak.toFixed(2) +
      " → $" +
      ledger.peakEffectiveCapital.toFixed(2) +
      ". Drawdown reads " +
      drawdownBefore.toFixed(1) +
      "% before / " +
      drawdownAfter.toFixed(1) +
      "% after (unchanged by design — a transfer is not a loss). " +
      "Position sizing now follows the real account balance.",
  );

  return {
    applied: true,
    equityBefore: Number(equityBefore.toFixed(2)),
    equityAfter: Number(equityAfter.toFixed(2)),
    previousPeak: Number(previousPeak.toFixed(2)),
    newPeak: ledger.peakEffectiveCapital,
    ownerAdjustments: Number(ledger.ownerAdjustments.toFixed(2)),
  };
}

module.exports = {
  recordRealizedPnl,
  getCapitalState,
  checkDrawdownBreaker,
  isHalted,
  tripHalt,
  reconcileWithLiveEquity,
  applyCapitalTransfer,
  computeEffectiveBase,
};
