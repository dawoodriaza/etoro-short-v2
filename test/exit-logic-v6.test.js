// v6 exit-logic tests against the REAL risk-manager module: recovery-aware
// time exits (DAY stale-exit + SWING time-exit), the profit-stall lock, and
// volatility-scaled time budgets. All timestamps are constructed directly
// (no real sleeping needed except where explicitly noted) so the suite runs
// in milliseconds.
process.env.DT_RECOVERY_CHECK_ENABLED = "true";
process.env.DT_RECOVERY_MIN_SAMPLES = "3";
process.env.DT_RECOVERY_MIN_SLOPE_PCT = "0.05";
process.env.DT_DAY_STALE_GRACE_MINUTES = "45";
process.env.DT_SWING_TIME_GRACE_DAYS = "3";
process.env.DT_MAX_HOLD_MINUTES = "90";
process.env.DT_SWING_MAX_HOLD_DAYS = "10";
process.env.DT_TIME_BUDGET_LOW_VOL_MULT = "1.5";
process.env.DT_TIME_BUDGET_HIGH_VOL_MULT = "0.7";
process.env.DT_LOW_VOL_ATR_PCT = "2.5";
process.env.DT_HIGH_VOL_ATR_PCT = "5.0";
process.env.DT_PROFIT_STALL_ENABLED = "true";
process.env.DT_PROFIT_STALL_MIN_MINUTES = "45";
process.env.DT_PROFIT_STALL_MIN_PROFIT_PCT = "0.4";
process.env.DT_PROFIT_STALL_LOCK_FRACTION = "0.5";
process.env.DT_STOP_CONFIRM_TICKS = "2";
process.env.DT_STOP_WICK_BAND_PCT = "0.005";
// v7.1: this suite tests the RECOVERY-GRACE logic, not time accounting, and
// it builds "held N minutes" fixtures from the wall clock. v7.1 made the DAY
// budget spend REGULAR-SESSION minutes instead, so these fixtures accrue zero
// budget whenever the suite happens to run outside US market hours — the
// tests would pass or fail depending on the time of day they were run.
// Pinning wall-clock mode here keeps this suite deterministic and focused;
// the session-minutes accounting has its own dedicated suite in
// session-time-budget-v7.test.js.
process.env.DT_SESSION_AWARE_TIME_BUDGETS = "false";

const riskManager = require("../src/strategies/risk-manager");

const MIN = 60000;
const DAY = 86400000;

function risingPrices(base) {
  // 3 samples, each a real step up, well past the 0.05% slope floor.
  return [
    { price: base * 0.995, atMs: Date.now() - 3 * MIN },
    { price: base * 0.998, atMs: Date.now() - 2 * MIN },
    { price: base, atMs: Date.now() - 1 * MIN },
  ];
}
function flatPrices(base) {
  return [
    { price: base, atMs: Date.now() - 3 * MIN },
    { price: base, atMs: Date.now() - 2 * MIN },
    { price: base, atMs: Date.now() - 1 * MIN },
  ];
}

module.exports = {
  name: "exit-logic v6 (recovery-aware time exits + profit-stall)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass });

    // ── 1. DAY stale-exit: no recovery signal → exits immediately ────────
    let meta = {
      tradeType: "DAY",
      entryPrice: 100,
      stopPrice: 97,
      targetT1: 105,
      peakPrice: 100,
      peakSetAt: Date.now() - 100 * MIN,
      openedAt: Date.now() - 100 * MIN, // 100min held > 90min budget
      recentPrices: flatPrices(99.8), // flat, not "RISING"
      partialDone: false,
    };
    let decision = riskManager.decidePositionAction(meta, 99.8); // -0.2%, in the loser/flat zone
    check(
      "DAY stale, no recovery signal: exits immediately",
      decision.action === "EXIT" && decision.reason === "TIME_EXIT_STALE",
    );

    // ── 2. DAY stale-exit: RISING signal → grants ONE bounded grace ──────
    meta = {
      tradeType: "DAY",
      entryPrice: 100,
      stopPrice: 97,
      targetT1: 105,
      peakPrice: 100,
      peakSetAt: Date.now() - 100 * MIN,
      openedAt: Date.now() - 100 * MIN,
      recentPrices: risingPrices(99.8),
      partialDone: false,
    };
    decision = riskManager.decidePositionAction(meta, 99.8);
    check(
      "DAY stale, RISING signal: grants grace instead of exiting",
      decision.action === "HOLD" && decision.grantStaleGrace === true,
    );

    // Simulate the caller (index.js) having stamped staleGraceUsedAt just now
    meta.staleGraceUsedAt = Date.now();
    decision = riskManager.decidePositionAction(meta, 99.8);
    check(
      "DAY stale, grace window still active: holds (doesn't re-grant or exit)",
      decision.action === "HOLD" && !decision.grantStaleGrace,
    );

    // Simulate the grace window having elapsed (45min ago + 1)
    meta.staleGraceUsedAt = Date.now() - 46 * MIN;
    decision = riskManager.decidePositionAction(meta, 99.8);
    check(
      "DAY stale, grace window EXPIRED with no recovery: exits (bounded, not unlimited)",
      decision.action === "EXIT" && decision.reason === "TIME_EXIT_STALE",
    );

    // ── 3. Profit-stall: modest profit below MFE-arm threshold, stalled,
    // NOT rising → locks in a partial ──────────────────────────────────
    meta = {
      tradeType: "DAY",
      entryPrice: 100,
      stopPrice: 97,
      targetT1: 106, // comfortably above the test price — not reached
      peakPrice: 100.5,
      peakSetAt: Date.now() - 50 * MIN, // stalled well past the 45min window
      openedAt: Date.now() - 50 * MIN,
      recentPrices: flatPrices(100.5),
      partialDone: false,
      entryConditions: { atrPercent: 3 }, // MEDIUM vol; MFE arm threshold = 0.75%
    };
    decision = riskManager.decidePositionAction(meta, 100.5); // +0.5% — above the 0.4% stall floor, below the 0.75% MFE-arm bar
    check(
      "profit-stall: modest stalled profit, not rising → PARTIAL lock",
      decision.action === "PARTIAL" &&
        decision.reason === "PROFIT_STALL_LOCK" &&
        decision.fraction === 0.5,
    );

    // ── 4. Profit-stall: same setup, but STILL RISING → extends instead ──
    meta = {
      ...meta,
      recentPrices: risingPrices(100.5),
    };
    decision = riskManager.decidePositionAction(meta, 100.5);
    check(
      "profit-stall: still rising → holds/extends instead of locking",
      decision.action === "HOLD" &&
        decision.reason.includes("still rising"),
    );

    // ── 5. Volatility-scaled time budget: HIGH-vol name gets a SHORTER
    // budget than the same held-time would allow at MEDIUM vol ──────────
    const heldMinutes = 70; // > 90×0.7=63 (HIGH), but < 90×1=90 (MEDIUM)
    const highVolMeta = {
      tradeType: "DAY",
      entryPrice: 100,
      stopPrice: 97,
      targetT1: 105,
      peakPrice: 100, // never yet profitable — matches a realistic peak >= entry
      peakSetAt: Date.now() - heldMinutes * MIN,
      openedAt: Date.now() - heldMinutes * MIN,
      recentPrices: flatPrices(99.9),
      partialDone: false,
      entryConditions: { atrPercent: 9 }, // HIGH vol (>= 5.0 threshold)
    };
    decision = riskManager.decidePositionAction(highVolMeta, 99.9);
    check(
      "volatility-scaled budget: HIGH-vol name exits EARLIER (63min effective budget)",
      decision.action === "EXIT" && decision.reason === "TIME_EXIT_STALE",
    );

    const mediumVolMeta = {
      ...highVolMeta,
      entryConditions: { atrPercent: 3 }, // MEDIUM vol, multiplier ×1
    };
    decision = riskManager.decidePositionAction(mediumVolMeta, 99.9);
    check(
      "volatility-scaled budget: MEDIUM-vol name at the SAME held-time still just holds",
      decision.action === "HOLD" && decision.reason === "in trade",
    );

    // ── 6. SWING time-exit: LOSS + no recovery → exits ───────────────────
    let swingMeta = {
      tradeType: "SWING",
      entryPrice: 100,
      stopPrice: 90,
      lockedFloor: null,
      targetT1: 105,
      targetT2: 110,
      targetT3: null,
      partialT1Done: false,
      partialT2Done: false,
      peakPrice: 100,
      openedAt: Date.now() - 11 * DAY, // > 10-day budget
      recentPrices: flatPrices(95),
    };
    decision = riskManager.decidePositionAction(swingMeta, 95); // in a loss
    check(
      "SWING time-exit, loss + no recovery: exits",
      decision.action === "EXIT" && decision.reason === "SWING_TIME_EXIT",
    );

    // ── 7. SWING time-exit: LOSS + RISING → grants a bounded day-grace ───
    swingMeta = { ...swingMeta, recentPrices: risingPrices(95) };
    decision = riskManager.decidePositionAction(swingMeta, 95);
    check(
      "SWING time-exit, loss + RISING: grants grace instead of exiting",
      decision.action === "HOLD" && decision.grantSwingTimeGrace === true,
    );

    // ── 8. SWING time-exit: PROFIT at the day limit is NOT gated — exits
    // unconditionally regardless of trend (the floor ladder already
    // protects a winner; there's no "blind exit on a winner" to fix).
    // Price picked BELOW targetT1 (105) so the T1-partial rule (which runs
    // earlier in decideSwingAction) doesn't intercept this test first. ────
    swingMeta = {
      ...swingMeta,
      recentPrices: risingPrices(102),
    };
    decision = riskManager.decidePositionAction(swingMeta, 102); // in PROFIT, below T1
    check(
      "SWING time-exit, IN PROFIT at the limit: exits regardless of trend",
      decision.action === "EXIT" && decision.reason === "SWING_TIME_EXIT",
    );

    return results;
  },
};
