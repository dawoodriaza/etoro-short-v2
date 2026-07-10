// src/strategies/capital-manager.js
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
        cumulativeRealizedPnl: 0,
        peakEffectiveCapital: config.dayTradeCapital,
        dailyPnl: {}, // { "YYYY-MM-DD": netDollars }
      };
    }
    const ledger = JSON.parse(fs.readFileSync(capitalLedgerPath, "utf8"));
    // If the user raises DT_CAPITAL in .env, honor the new base.
    ledger.baseCapital = config.dayTradeCapital;
    if (!ledger.dailyPnl) ledger.dailyPnl = {};
    if (typeof ledger.peakEffectiveCapital !== "number") {
      ledger.peakEffectiveCapital =
        ledger.baseCapital + Number(ledger.cumulativeRealizedPnl || 0);
    }
    return ledger;
  } catch {
    return {
      baseCapital: config.dayTradeCapital,
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

function computeEffectiveCapital(ledger) {
  const floorCapital = ledger.baseCapital * config.capitalFloorPctOfBase;
  return Math.max(
    floorCapital,
    ledger.baseCapital + Number(ledger.cumulativeRealizedPnl || 0),
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

module.exports = {
  recordRealizedPnl,
  getCapitalState,
  checkDrawdownBreaker,
  isHalted,
  tripHalt,
};
