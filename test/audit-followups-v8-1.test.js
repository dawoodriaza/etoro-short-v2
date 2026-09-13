// v8.1 follow-up tests (2026-09-13): cross-process position lock, drawdown
// peak repair, equity drift trail, partial P&L backfill, shadow signals,
// split stats and replay candle merging.
//
// NOTE ON CONFIG: reads the RESOLVED config — it is a shared singleton.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const config = require("../src/config");

module.exports = {
  name: "audit follow-ups v8.1 (lock file, peak repair, drift, backfill, shadow, stats)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass: !!pass });

    // ══ 1. Position lock across processes ══
    const positionLock = require("../src/position-lock");
    const lockPath = positionLock.LOCK_FILE_PATH;
    check("lock: this process is reported alive", positionLock.processIsAlive(process.pid));

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483000, label: "crashed", token: "dead", atMs: Date.now() }));
    const staleStart = Date.now();
    const staleRan = await positionLock.withPositionLock("after-crash", async () => "ran");
    check(
      "lock: a lock left by a dead process is taken over at once",
      staleRan === "ran" && Date.now() - staleStart < 2000,
    );
    check("lock: the lock file is removed after release", !fs.existsSync(lockPath));

    const childScript =
      "const lock = require(" + JSON.stringify(path.join(__dirname, "../src/position-lock.js")) + ");" +
      "lock.withPositionLock('child', () => new Promise((resolve) => { console.log('held'); setTimeout(resolve, 700); }))" +
      ".then(() => process.exit(0));";
    const child = spawn(process.execPath, ["-e", childScript], { stdio: ["ignore", "pipe", "inherit"] });
    const childHolds = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      child.stdout.on("data", (data) => {
        if (String(data).includes("held")) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    let waitedMs = -1;
    if (childHolds) {
      const waitStart = Date.now();
      await positionLock.withPositionLock("parent", async () => {
        waitedMs = Date.now() - waitStart;
      });
    }
    await new Promise((resolve) => (child.exitCode != null ? resolve() : child.on("exit", resolve)));
    check(
      "lock: a second PROCESS waits for the lock the first one holds (manual close vs bot)",
      childHolds && waitedMs >= 400,
    );

    // ══ 2. Drawdown peak repair (isolated ledger) ══
    const ledgerPath = path.join(__dirname, "../data/capital-ledger.json");
    const ledgerBackup = ledgerPath + ".v81-test-backup";
    const hadLedger = fs.existsSync(ledgerPath);
    if (hadLedger) fs.renameSync(ledgerPath, ledgerBackup);
    try {
      const base = config.dayTradeCapital;
      fs.writeFileSync(
        ledgerPath,
        JSON.stringify({ baseCapital: base, ownerAdjustments: 0, cumulativeRealizedPnl: -631.55, peakEffectiveCapital: base + 98.27, dailyPnl: {} }),
      );
      delete require.cache[require.resolve("../src/strategies/capital-manager")];
      const capitalManager = require("../src/strategies/capital-manager");
      check("peak reset: raising a peak is refused", capitalManager.validateDrawdownPeakReset(base + 200).ok === false);
      check(
        "peak reset: a peak below current effective capital is refused",
        capitalManager.validateDrawdownPeakReset(base - 700).ok === false,
      );
      const reset = capitalManager.resetDrawdownPeak(base + 32.85, "inflated by pre-v8 reconciliation");
      const ledgerAfter = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      check(
        "peak reset: an inflated peak is lowered and the repair is recorded",
        reset.applied &&
          ledgerAfter.peakEffectiveCapital === Number((base + 32.85).toFixed(2)) &&
          ledgerAfter.repairHistory.some((entry) => entry.type === "PEAK_RESET" && entry.previousPeak === base + 98.27),
      );

      // ══ 3. Equity drift trail ══
      const quiet = capitalManager.describeEquityDrift({
        liveEquity: 9500, unrealizedPnl: 120, ledgerEffective: 9368.45, lastRecordedDriftDollars: null, recordThresholdDollars: 25,
      });
      check("drift: a gap below the threshold is not journaled", quiet.shouldRecord === false && Math.abs(quiet.driftDollars - 11.55) < 0.01);
      const material = capitalManager.describeEquityDrift({
        liveEquity: 9500, unrealizedPnl: 50, ledgerEffective: 9368.45, lastRecordedDriftDollars: null, recordThresholdDollars: 25,
      });
      check("drift: a material gap net of open P&L is journaled", material.shouldRecord === true && Math.abs(material.driftDollars - 81.55) < 0.01);
      const unchanged = capitalManager.describeEquityDrift({
        liveEquity: 9508.45, unrealizedPnl: 50, ledgerEffective: 9368.45, lastRecordedDriftDollars: 81.55, recordThresholdDollars: 25,
      });
      check("drift: the same gap is not re-journaled every scan", unchanged.shouldRecord === false);
    } finally {
      if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
      if (hadLedger) fs.renameSync(ledgerBackup, ledgerPath);
      delete require.cache[require.resolve("../src/strategies/capital-manager")];
    }

    // ══ 4. Partial P&L backfill (estimate only, pnlDollars untouched) ══
    const backfillTool = require("../src/backfill-partial-pnl");
    const hood = {
      symbol: "HOOD", entryPrice: 100, openedAt: "2026-09-03T12:50:00Z", closedAt: "2026-09-03T13:52:00Z",
      dollarAmount: 580, pnlDollars: 44.07, plan: { positionDollars: 1160 },
    };
    const hoodEvents = [{ tsMs: Date.parse("2026-09-03T13:32:00Z"), reason: "TARGET_1_HIT", price: 106.46 }];
    const hoodEstimate = backfillTool.estimatePartialPnl(hood, hoodEvents);
    check(
      "backfill: a halved record is sized from the plan (HOOD +6.46% on half of $1,160)",
      Math.abs(hoodEstimate.dollars - 1160 * config.partialExitFraction * 0.0646) < 0.05 && hoodEstimate.originalDollarAmount === 1160,
    );
    const outside = backfillTool.estimatePartialPnl(hood, [{ tsMs: Date.parse("2026-09-04T13:32:00Z"), reason: "TARGET_1_HIT", price: 110 }]);
    check("backfill: a partial from another holding of the symbol is ignored", outside.dollars === 0 && outside.partials.length === 0);
    check("backfill: v8 records are left alone", backfillTool.estimatePartialPnl({ ...hood, pnlAccountingVersion: 2 }, hoodEvents) === null);
    const history = [{ ...hood }, { ...hood, symbol: "X", pnlAccountingVersion: 2 }];
    const events = new Map([["HOOD", hoodEvents]]);
    backfillTool.backfill(history, events, "2026-09-13T00:00:00Z");
    const firstEstimate = history[0].estimatedPartialPnlDollars;
    const second = backfillTool.backfill(history, events, "2026-09-14T00:00:00Z");
    check(
      "backfill: pnlDollars is untouched and a re-run changes nothing",
      history[0].pnlDollars === 44.07 && history[0].estimatedPartialPnlDollars === firstEstimate &&
        second.alreadyDone === 1 && history[1].estimatedPartialPnlDollars === undefined,
    );

    // ══ 5. Shadow signals ══
    const shadowSignals = require("../src/strategies/shadow-signals");
    const book = shadowSignals.createShadowBook();
    const candidate = {
      symbol: "amd", currentPrice: 102, recentIntradayHigh: 104, recentIntradayLow: 99, vwap: 101,
      atrPercent: 4, priceChangePercent: 2.5, rsi: 66.21, volumeRatio: 1.3, source: "WATCHLIST", quoteTimestamp: "2026-09-11T14:00:00Z",
    };
    shadowSignals.recordShadowCandidate(book, candidate, { rejected: false, score: 85.123, setup: "MOMENTUM_SURGE", relativeStrength: 2 }, { regime: "TRENDING", spyChangePercent: 0.5 });
    const signal = book.get("AMD");
    const expectedStop = Math.min(config.dayStopClampMaxPct, Math.max(config.dayStopClampMinPct, 0.04 * config.dayAtrStopMultiple)) * 100;
    check(
      "shadow: scan-time location features are recorded (range position, below high, VWAP distance, move/ATR)",
      signal.rangePosition === 0.6 && signal.belowHighPct === 1.961 && signal.vwapDistancePct === 0.99 && signal.moveToAtr === 0.625,
    );
    check("shadow: the planner's own stop distance is recorded", Math.abs(signal.stopDistancePct - expectedStop) < 0.001);
    shadowSignals.markShadowOutcome(book, "AMD", "AI_SKIP", "confidence 4");
    check("shadow: the final outcome replaces the earlier stage", book.get("AMD").outcome === "AI_SKIP");
    shadowSignals.recordShadowCandidate(book, { ...candidate, symbol: "META" }, { rejected: true, rejectReason: "below VWAP" }, { regime: "CHOP", spyChangePercent: 0 });
    check(
      "shadow: a scoring rejection keeps its reason and has no score",
      book.get("META").outcome === "SCORING_REJECTED" && book.get("META").outcomeDetail === "below VWAP" && book.get("META").score === null,
    );

    // ══ 6. Stats split by accounting era ══
    const performance = require("../src/strategies/performance-tracker");
    const stats = performance.computeStats([
      { symbol: "A", setup: "S", pnlDollars: 50, pnlAccountingVersion: 2 },
      { symbol: "B", setup: "S", pnlDollars: -10, estimatedPartialPnlDollars: 30 },
      { symbol: "C", setup: "S", pnlDollars: -20 },
    ]);
    check(
      "stats: a pre-v8 runner loss with a larger estimated partial counts as a win",
      performance.tradeResultDollars({ pnlDollars: -10, estimatedPartialPnlDollars: 30 }) === 20,
    );
    check(
      "stats: totals are split into after-fix and before-fix eras",
      stats.totalPnl === 50 && stats.segments.afterFix.totalPnl === 50 && stats.segments.beforeFix.totalPnl === 0 &&
        stats.segments.beforeFixEstimated === true,
    );
    const report = performance.formatStatsForTelegram(stats);
    check("stats: Telegram shows both eras", /Since the v8 accounting fix/.test(report) && /Before the fix/.test(report));

    // ══ 7. Replay candle capture merges instead of overwriting ══
    const { mergeBars } = require("../src/fetch-replay-candles");
    const nowMs = Date.parse("2026-09-13T00:00:00Z");
    const day = 24 * 3600 * 1000;
    const merged = mergeBars(
      [{ t: nowMs - 50 * day, c: 1 }, { t: nowMs - 2 * day, c: 2 }],
      [{ t: nowMs - 2 * day, c: 9 }, { t: nowMs - day, c: 3 }],
      45,
      nowMs,
    );
    check(
      "candles: bars merge by time, the newest fetch wins, and retention trims old bars",
      merged.length === 2 && merged[0].c === 9 && merged[1].c === 3,
    );

    return results;
  },
};
