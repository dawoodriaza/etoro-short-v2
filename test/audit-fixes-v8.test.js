// v8 audit-fix tests (2026-09-12).
//
// Each case guards a defect measured in the September audit of the live
// server's journal, logs and trade history:
//   · partial exits realized cash that trade-history never recorded
//     (HOOD 2026-09-03: +$37.70 banked at +6.5%, only the +$44.07 runner kept)
//   · equity reconciliation booked OPEN positions' P&L as realized
//   · position-meta writers (EOD cron, reviewer) were not serialised
//   · positions opened after the Friday force-close ran into the weekend
//   · identical frozen-price plans were re-sent to the AI screener
//   · no readable per-position management state
//
// NOTE ON CONFIG: reads the RESOLVED config — it is a shared singleton.
const fs = require("fs");
const path = require("path");
const config = require("../src/config");

module.exports = {
  name: "audit fixes v8 (partial P&L, reconciliation, lock, cutoffs, diagnostics)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass: !!pass });

    // ══ 1. A closed trade's result includes the partial banked earlier ══
    const { buildClosedTradeRecord } = require("../src/strategies/performance-tracker");
    const hood = buildClosedTradeRecord({
      symbol: "HOOD",
      positionMeta: {
        entryPrice: 100,
        originalDollarAmount: 1160,
        dollarAmount: 580,
        realizedPartialPnl: 37.7,
        partialFills: [{ reason: "TARGET_1_HIT", fraction: 0.5, pnlDollars: 37.7 }],
        peakPrice: 108,
        troughPrice: 99.5,
      },
      livePosition: {
        unrealizedProfitLoss: 44.07,
        unrealizedProfitLossPercent: 0.076,
        openPrice: 100,
        amountInvested: 580,
      },
      exitReason: "MFE_GIVEBACK",
      heldMinutes: 62,
    });
    check("closed trade: pnlDollars = partial banked + final leg", Math.abs(hood.pnlDollars - 81.77) < 0.01);
    check(
      "closed trade: the two legs are kept separately",
      hood.finalLegPnlDollars === 44.07 && hood.partialPnlDollars === 37.7,
    );
    check(
      "closed trade: percent is measured on the ORIGINAL amount",
      Math.abs(hood.pnlPercent - (81.77 / 1160) * 100) < 1e-6,
    );
    check(
      "closed trade: dollarAmount is the original size, not the runner",
      hood.dollarAmount === 1160 && hood.remainingDollarAmount === 580,
    );
    check("closed trade: exit price is derived (EOD closes used to store null)", Math.abs(hood.exitPrice - 107.6) < 1e-6);
    check(
      "closed trade: MFE, MAE and giveback from the peak are recorded",
      hood.mfePercent === 8 && hood.maePercent === -0.5 && Math.abs(hood.givebackFromPeakPercent - 0.4) < 1e-9,
    );
    const amd = buildClosedTradeRecord({
      symbol: "AMD",
      positionMeta: { entryPrice: 100, originalDollarAmount: 2000, dollarAmount: 1000, realizedPartialPnl: 19.2 },
      livePosition: { unrealizedProfitLoss: -0.1, unrealizedProfitLossPercent: -0.0001, openPrice: 100 },
      exitReason: "TRAILING_STOP",
    });
    check(
      "closed trade: a -$0.10 runner after a +$19.20 partial is a WIN (was recorded as a loss, with a loss cooldown)",
      amd.pnlDollars > 0,
    );
    const single = buildClosedTradeRecord({
      symbol: "X",
      positionMeta: { entryPrice: 50, dollarAmount: 1000 },
      livePosition: { unrealizedProfitLoss: -20, unrealizedProfitLossPercent: -0.02, openPrice: 50 },
      exitReason: "STOP_LOSS",
    });
    check("closed trade: with no partial the result equals the single leg", single.pnlDollars === -20 && single.partialPnlDollars === 0);

    // ══ 2. Reconciliation compares realized with realized ══
    const ledgerPath = path.join(__dirname, "../data/capital-ledger.json");
    const ledgerBackup = ledgerPath + ".v8-test-backup";
    const hadLedger = fs.existsSync(ledgerPath);
    if (hadLedger) fs.renameSync(ledgerPath, ledgerBackup);
    try {
      delete require.cache[require.resolve("../src/strategies/capital-manager")];
      const capitalManager = require("../src/strategies/capital-manager");
      const base = config.dayTradeCapital;
      const openGain = base * config.capitalReconciliationTolerancePct * 3;
      const ignored = capitalManager.reconcileWithLiveEquity(base + openGain, { unrealizedPnl: openGain });
      check(
        "reconcile: equity that is up only by OPEN P&L is not booked into the ledger",
        ignored.reconciled === false && capitalManager.getCapitalState().effectiveCapital === base,
      );
      const legacyCall = capitalManager.reconcileWithLiveEquity(base + openGain);
      check("reconcile: a caller that passes no unrealized figure keeps the old behaviour", legacyCall.reconciled === true);
    } finally {
      if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
      if (hadLedger) fs.renameSync(ledgerBackup, ledgerPath);
      delete require.cache[require.resolve("../src/strategies/capital-manager")];
    }

    // ══ 3. The position lock serialises writers and survives errors ══
    const { withPositionLock } = require("../src/position-lock");
    const order = [];
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await Promise.all([
      withPositionLock("first", async () => {
        order.push("a-start");
        await pause(25);
        order.push("a-end");
      }),
      withPositionLock("second", async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);
    check("lock: a second writer waits until the first has finished", order.join(",") === "a-start,a-end,b-start,b-end");
    let rejected = false;
    await withPositionLock("throws", async () => {
      throw new Error("boom");
    }).catch(() => {
      rejected = true;
    });
    const next = await withPositionLock("after", async () => "ran");
    check("lock: a throwing holder still releases the lock", rejected && next === "ran");

    // ══ 4. Entry cutoffs around the EOD force-close ══
    const sessionTiming = require("../src/strategies/session-timing");
    // September is EDT (UTC-4). 2026-09-10 is a Thursday, 2026-09-11 a Friday.
    const easternInstant = (date, minuteOfDay) =>
      new Date(new Date(date + "T00:00:00Z").getTime() + (minuteOfDay + 240) * 60000);
    const forceCloseMinute = 16 * 60 - config.forceCloseMinutesBeforeClose;
    if (config.fridayCloseAll) {
      check(
        "cutoff: Friday after the force-close blocks new entries (weekend with no exit monitor)",
        sessionTiming.getEntryCutoffStatus(easternInstant("2026-09-11", forceCloseMinute + 30)).gate === "FRIDAY_AFTER_CLOSE",
      );
      check(
        "cutoff: Friday 19:30 ET is still blocked",
        sessionTiming.getEntryCutoffStatus(easternInstant("2026-09-11", 19 * 60 + 30)).blocked === true,
      );
    }
    check(
      "cutoff: Thursday after the close stays OPEN (the after-hours cohort was profitable)",
      sessionTiming.getEntryCutoffStatus(easternInstant("2026-09-10", forceCloseMinute + 30)).blocked === false,
    );
    if (config.eodNoEntryMinutesBeforeClose > 0) {
      check(
        "cutoff: minutes before the force-close are blocked",
        sessionTiming.getEntryCutoffStatus(easternInstant("2026-09-10", forceCloseMinute - 10)).gate === "PRE_EOD_CLOSE",
      );
    }
    check(
      "cutoff: mid-morning is open",
      sessionTiming.getEntryCutoffStatus(easternInstant("2026-09-10", 10 * 60 + 30)).blocked === false,
    );

    // ══ 5. Identical frozen-price plans share one screener verdict ══
    const { planFingerprint } = require("../src/models/ai-screener");
    const frozen = { symbol: "AMD", tradeType: "DAY", entryPrice: 477.385, score: 100.2 };
    check(
      "screener dedupe: the same frozen price is the same plan",
      planFingerprint(frozen) === planFingerprint({ ...frozen, score: 99.8 }),
    );
    check("screener dedupe: a moved price is a new plan", planFingerprint(frozen) !== planFingerprint({ ...frozen, entryPrice: 478.1 }));

    // ══ 6. Position status reads the engine's own levels ══
    const riskManager = require("../src/strategies/risk-manager");
    const freshMeta = () => ({
      tradeType: "DAY",
      entryPrice: 100,
      stopPrice: 96,
      targetT1: 104,
      peakPrice: 100,
      peakSetAt: Date.now(),
      openedAt: Date.now() - 5 * 60000,
      recentPrices: [],
      partialDone: false,
      entryConditions: { atrPercent: 4 },
    });
    let status = riskManager.describePositionState(freshMeta(), 100.5);
    check(
      "status: a fresh small winner is HOLD, exits at the initial stop, next trim is T1",
      status.state === "HOLD" && status.stopKind === "STOP" && status.stopPrice === 96 && /T1 \$104/.test(status.nextTrim),
    );
    status = riskManager.describePositionState({ ...freshMeta(), peakPrice: 103 }, 102.2);
    check(
      "status: once armed, the profit floor replaces the stop as the exit level",
      status.stopKind === "PROFIT_FLOOR" && status.stopPrice > 100,
    );
    status = riskManager.describePositionState({ ...freshMeta(), partialDone: true, peakPrice: 106 }, 105.5);
    check("status: after a partial the position is a RUNNER with no further trim", status.state === "RUNNER" && /banked/.test(status.nextTrim));
    status = riskManager.describePositionState(freshMeta(), 95);
    check("status: through the stop the engine says EXIT", status.state === "EXIT");
    check("status: never claims ADD — adding to winners is not enabled", status.state !== "ADD" && /not enabled/.test(status.nextAdd));

    // ══ 7. The EOD close books the WHOLE trade ══
    const eodCloser = require("../src/strategies/eod-closer");
    let tradeRecord = null;
    let dailyTrackerPnl = null;
    let hookArguments = null;
    let savedMeta = null;
    await eodCloser.forceCloseAllPositions(
      {
        fetchRawPortfolio: async () => ({}),
        parsePortfolioFromRawData: () => ({
          openPositions: [
            {
              symbol: "AFRM",
              positionId: 1,
              instrumentId: 2,
              unrealizedProfitLoss: 4.04,
              unrealizedProfitLossPercent: 0.0035,
              openPrice: 70.845,
              amountInvested: 1145,
            },
          ],
        }),
        labelPositionsWithTickers: async (portfolio) => portfolio,
        closeExistingPosition: async () => ({}),
        sleep: async () => {},
      },
      { sendTelegramMessage: async () => {} },
      { recordClosedTradeResult: (pnl) => (dailyTrackerPnl = pnl) },
      { recordTrade: (record) => (tradeRecord = record) },
      () => ({
        AFRM: {
          tradeType: "DAY",
          entryPrice: 70.845,
          originalDollarAmount: 2290,
          dollarAmount: 1145,
          realizedPartialPnl: 6.7,
          openedAt: Date.now() - 294 * 60000,
        },
      }),
      (meta) => (savedMeta = meta),
      "ALL",
      { onClosed: (...args) => (hookArguments = args) },
    );
    check(
      "EOD close: trade history records final leg + earlier partial, with an exit price",
      tradeRecord && Math.abs(tradeRecord.pnlDollars - 10.74) < 0.01 && tradeRecord.exitPrice != null,
    );
    check("EOD close: the daily tracker judges the whole trade", Math.abs(dailyTrackerPnl - 10.74) < 0.01);
    check(
      "EOD close: the capital-ledger hook gets ONLY the final leg (the partial was booked when it filled)",
      hookArguments && Math.abs(hookArguments[1] - 4.04) < 0.01 && Math.abs(hookArguments[4].pnlDollars - 10.74) < 0.01,
    );
    check("EOD close: the closed position is removed from meta", savedMeta && !savedMeta.AFRM);

    // ══ 8. Stop geometry defaults match the replay decision ══
    const tradePlanner = require("../src/strategies/trade-planner");
    const plan = tradePlanner.buildTradePlan(
      { symbol: "TESTSTOP", currentPrice: 100, atrPercent: 4, priceChangePercent: 2, rsi: 65, relativeStrength: 1, aboveVwap: true, score: 100, setup: "MOMENTUM_SURGE", detail: "test", source: "WATCHLIST", averageVolume: 1e9 },
      { regime: "TRENDING", spyChangePercent: 0.2, easternWeekday: 4 },
      { effectiveCapital: 10000, riskMultiplier: 1 },
      { dayCount: 0, swingCount: 0 },
      false,
    );
    const expectedStopPct = Math.min(config.dayStopClampMaxPct, Math.max(config.dayStopClampMinPct, 0.04 * config.dayAtrStopMultiple));
    check(
      "stop geometry: the DAY stop follows dayAtrStopMultiple x ATR within the clamps",
      plan.accepted && Math.abs(plan.plan.stopDistancePct / 100 - expectedStopPct) < 0.0015,
    );
    check(
      "stop geometry: sizing keeps the risked dollars at riskPctDay regardless of stop width",
      plan.accepted && plan.plan.riskDollars <= 10000 * config.riskPctDay + 1,
    );

    return results;
  },
};
