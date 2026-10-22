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

    // ══ 8. v8.2 dip entry: buy approved stocks on a pullback, not the spike ══
    const planner = require("../src/strategies/trade-planner");
    const dipPlan = {
      symbol: "amd", entryPrice: 100, stopPrice: 98, stopDistancePct: 2, targetT1: 102, targetT2: 104,
      targetT3: null, positionDollars: 2500, riskDollars: 50, atrPercent: 2, score: 90,
      priceChangePercent: 6.5, rsi: 71,
    };
    const armedAt = Date.parse("2026-09-14T14:00:00Z");
    const newOrder = () => planner.buildDipEntryOrder(dipPlan, { depthOfStop: 1, windowMinutes: 120, nowMs: armedAt });
    const order = newOrder();
    check("dip: buy price is one stop distance below the approval price", order.triggerPrice === 98 && order.symbol === "AMD");
    check("dip: a further full stop distance lower counts as a breakdown", Math.abs(order.breakdownPrice - 96.04) < 1e-9);
    check("dip: waits while the price stays above the buy price", planner.evaluateDipEntry(order, 99.5, armedAt + 60000).action === "WAIT");
    const filled = planner.evaluateDipEntry(order, 97.9, armedAt + 30 * 60000);
    check("dip: buys when the ask reaches the buy price", filled.action === "FILL" && filled.price === 97.9 && order.lowestPrice === 97.9);
    check("dip: never buys into a breakdown", planner.evaluateDipEntry(newOrder(), 95, armedAt + 60000).action === "CANCEL");
    const expiring = newOrder();
    check(
      "dip: expires with no trade when no dip comes in time",
      planner.evaluateDipEntry(expiring, 103, armedAt + 121 * 60000).action === "EXPIRE" && expiring.highestPrice === 103,
    );
    const noQuoteOrder = newOrder();
    check(
      "dip: no usable quote just waits, and the missed check is counted",
      planner.evaluateDipEntry(noQuoteOrder, null, armedAt + 60000).action === "WAIT" && noQuoteOrder.quoteMisses === 1,
    );
    const rebased = planner.rebasePlanToFill(dipPlan, 98);
    check(
      "dip: the plan moves to the fill price with the same stop % and the same size",
      rebased.entryPrice === 98 && Math.abs(rebased.stopPrice - 96.04) < 1e-9 && Math.abs(rebased.targetT1 - 99.96) < 1e-9 &&
        rebased.stopDistancePct === 2 && rebased.positionDollars === 2500 && rebased.targetT3 === null,
    );
    const described = planner.describeDipEntryOrder(order, armedAt + 30 * 60000);
    check("dip: the journal record says how deep the dip went, in stop distances", described.deepestDipOfStop === 1.05 && described.minutesWaited === 30);
    check(
      "dip: the journal record carries what the stock looked like at approval",
      described.approval.priceChangePercent === 6.5 && described.approval.rsi === 71 && described.quoteMisses === 0 && described.checkFailures === 0,
    );
    check(
      "dip: on by default — a quarter of the stop distance within 60 minutes (v8.3)",
      config.dipEntryEnabled === true && config.dipEntryDepthOfStop === 0.25 && config.dipEntryWindowMinutes === 60,
    );
    const telegramPlan = {
      ...rebased, symbol: "AMD", tradeType: "DAY", source: "WATCHLIST", setup: "MOMENTUM", archetype: "MOMENTUM_BREAKOUT",
      volatilityBucket: "NORMAL", trendDirection: "UP", regime: "TRENDING", riskPctOfCapital: 0.5, riskRewardRatio: 2,
      expectedReturnDollars: 100, dipEntry: { signalPrice: 100, triggerPrice: 98, minutesWaited: 42 },
    };
    const openMessage = planner.formatPlanForTelegram(telegramPlan, null);
    check(
      "dip: the Telegram OPEN message says it was bought on a dip, from which price and after how long",
      /Bought on a dip: approved at \$100\.00, bought at \$98\.00 \(-2\.00%\) after 42 min/.test(openMessage),
    );
    check(
      "dip: a normal OPEN message has no dip line",
      !/Bought on a dip/.test(planner.formatPlanForTelegram({ ...telegramPlan, dipEntry: undefined }, null)),
    );

    // ══ 9. v8.3: wait for breakeven instead of selling a red position on the clock ══
    const riskManager = require("../src/strategies/risk-manager");
    const { describeExitReason } = require("../src/notifications/format-helpers");
    const savedTime = {
      sessionAwareTimeBudgets: config.sessionAwareTimeBudgets,
      maxHoldMinutes: config.maxHoldMinutes,
      maxHoldWallClockCeilingMultiplier: config.maxHoldWallClockCeilingMultiplier,
      staleWaitForBreakeven: config.staleWaitForBreakeven,
    };
    Object.assign(config, {
      sessionAwareTimeBudgets: false,
      maxHoldMinutes: 90,
      maxHoldWallClockCeilingMultiplier: 8,
      staleWaitForBreakeven: true,
    });
    const MINUTE = 60000;
    const staleMeta = (heldMinutes, extra) => ({
      tradeType: "DAY", entryPrice: 100, stopPrice: 95, targetT1: 105, peakPrice: 100,
      peakSetAt: Date.now() - heldMinutes * MINUTE, openedAt: Date.now() - heldMinutes * MINUTE,
      recentPrices: [98, 98, 98].map((price, k) => ({ price, atMs: Date.now() - (3 - k) * MINUTE })),
      staleGraceUsedAt: 1, partialDone: false, entryConditions: { atrPercent: 3 },
      plan: { dipEntry: { signalPrice: 101, triggerPrice: 100 } }, ...extra,
    });
    const startWait = riskManager.decidePositionAction(staleMeta(120), 98);
    check(
      "breakeven wait: red when time runs out → holds and starts waiting (no sale at a loss)",
      startWait.action === "HOLD" && startWait.startBreakevenWait === true,
    );
    const waiting = staleMeta(150, { waitingForBreakevenSince: Date.now() - 30 * MINUTE });
    const stillRed = riskManager.decidePositionAction(waiting, 99);
    check("breakeven wait: still red → keeps waiting", stillRed.action === "HOLD" && !stillRed.startBreakevenWait);
    const recovered = riskManager.decidePositionAction(waiting, 100.2);
    check("breakeven wait: back at breakeven → sells as STALE_RECOVERED", recovered.action === "EXIT" && recovered.reason === "STALE_RECOVERED");
    const stoppedWhileWaiting = riskManager.decidePositionAction(waiting, 94);
    check("breakeven wait: the stop-loss still fires while waiting", stoppedWhileWaiting.action === "EXIT" && stoppedWhileWaiting.reason === "STOP_LOSS");
    const pastCeiling = riskManager.decidePositionAction(staleMeta(800), 98);
    check("breakeven wait: the wall-clock ceiling still force-exits", pastCeiling.action === "EXIT" && pastCeiling.reason === "TIME_EXIT_STALE");
    check("breakeven wait: the status line shows WAITING_BREAKEVEN", riskManager.describePositionState(waiting, 99).state === "WAITING_BREAKEVEN");
    const notADip = riskManager.decidePositionAction(staleMeta(120, { plan: { score: 90 } }), 98);
    check(
      "breakeven wait: only for positions bought on a dip — others keep the old time exit",
      notADip.action === "EXIT" && notADip.reason === "TIME_EXIT_STALE",
    );
    config.staleWaitForBreakeven = false;
    const legacyExit = riskManager.decidePositionAction(staleMeta(120), 98);
    check("breakeven wait: switched off → the old time exit", legacyExit.action === "EXIT" && legacyExit.reason === "TIME_EXIT_STALE");
    Object.assign(config, savedTime);
    check("breakeven wait: STALE_RECOVERED has a plain Telegram label", /Breakeven/.test(describeExitReason("STALE_RECOVERED").trigger));

    // ══ 11. v8.4: trend score V2 (logged beside the live score) ══
    const scanner = require("../src/strategies/momentum-scanner");
    const shadow = require("../src/strategies/shadow-signals");
    const sessionStart = Date.parse("2026-09-15T13:30:00Z"); // 09:30 ET
    const FIVE = 5 * 60000;
    const pathUpAfterDip = (k) => (k < 3 ? 100 - k * 0.33 : 99 + (k - 3) * 0.17);
    const makeBars = (pricePath, count, startMs) => {
      const out = [];
      let previous = pricePath(0);
      for (let k = 0; k < count; k++) {
        const close = pricePath(k);
        out.push({ t: startMs + k * FIVE, o: previous, h: Math.max(previous, close) + 0.05, l: Math.min(previous, close) - 0.05, c: close, v: 1000 });
        previous = close;
      }
      return out;
    };
    const risingBars = makeBars(pathUpAfterDip, 18, sessionStart);
    const at1100 = sessionStart + 18 * FIVE; // 11:00 ET, all 18 bars complete
    const rising = scanner.extractTrendFeatures({ bars: risingBars, nowMs: at1100, price: null, previousClose: 106, atrPercent: 3 });
    const risingScore = scanner.scoreTrendV2(rising);
    check(
      "trend V2: a dip-then-rally scores high even while RED vs yesterday's close (the AMD Sep 14 case)",
      rising.changeVsPreviousClosePct < 0 && risingScore.score >= 70 && rising.higherLowsLastHour === 2,
    );
    const fallingBars = makeBars((k) => 101.38 - k * 0.14, 18, sessionStart);
    const falling = scanner.scoreTrendV2(scanner.extractTrendFeatures({ bars: fallingBars, nowMs: at1100, atrPercent: 3 }));
    check("trend V2: a stock sliding below VWAP scores 0", falling.score === 0 && falling.reason === "not above VWAP");
    const midBar = scanner.extractTrendFeatures({ bars: risingBars, nowMs: at1100 - 2.5 * 60000, atrPercent: 3 });
    check("trend V2: only COMPLETED bars are used (no peeking into the bar still forming)", midBar.sessionBars === 17);
    const withYesterday = makeBars((k) => 90 + k, 20, sessionStart - 24 * 3600000).concat(risingBars);
    check(
      "trend V2: yesterday's bars never leak into today's VWAP, low or high",
      scanner.extractTrendFeatures({ bars: withYesterday, nowMs: at1100, atrPercent: 3 }).dayLow === rising.dayLow,
    );
    check(
      "trend V2: under 30 minutes of today's bars → no score (not a fake 0)",
      scanner.scoreTrendV2(scanner.extractTrendFeatures({ bars: risingBars, nowMs: sessionStart + 20 * 60000, atrPercent: 3 })).score === null,
    );
    const shadowCandidate = { symbol: "amd", currentPrice: 101.38, priceChangePercent: -4.36, atrPercent: 3, vwap: 100, rsi: 60 };
    Object.defineProperty(shadowCandidate, "intradayBars", { value: risingBars, enumerable: false });
    const shadowRecord = shadow.buildShadowSignal(shadowCandidate, { rejected: true, rejectReason: "relative strength" }, {
      spyChangePercent: -0.5, scoreV2: true, nowMs: at1100,
    });
    check(
      "trend V2: the SHADOW_SIGNAL record carries scoreV2 + features, and the bars stay out of JSON",
      typeof shadowRecord.scoreV2 === "number" && shadowRecord.trendFeatures && !JSON.stringify(shadowCandidate).includes("intradayBars"),
    );
    check("trend V2: logging is on by default and nothing trades on it", config.scoreV2LoggingEnabled === true);

    // ══ 12. v8.5: a position the bot just closed is settling, not untracked ══
    const cooldowns = require("../src/strategies/cooldown-tracker");
    const cooldownFile = path.join(__dirname, "../data/trade-cooldowns.json");
    const savedCooldowns = fs.existsSync(cooldownFile) ? fs.readFileSync(cooldownFile, "utf8") : null;
    cooldowns.startCooldown("ZZTEST", { wasLoss: false });
    const justClosed = cooldowns.checkCooldown("ZZTEST");
    check(
      "untracked alert: a symbol closed seconds ago reports minutesSinceExit inside the settle grace",
      justClosed.minutesSinceExit != null && justClosed.minutesSinceExit < config.closeSettleGraceMinutes && config.closeSettleGraceMinutes === 5,
    );
    check("untracked alert: a symbol never closed has no minutesSinceExit", cooldowns.checkCooldown("ZZNEVER").minutesSinceExit == null);
    if (savedCooldowns != null) fs.writeFileSync(cooldownFile, savedCooldowns);
    else if (fs.existsSync(cooldownFile)) fs.unlinkSync(cooldownFile);

    // ══ 10. v8.3: a stock beating a red market is not "sideways" ══
    check(
      "trend label: above VWAP and beating a RED market reads BULLISH, not SIDEWAYS",
      planner.classifyTrend({ aboveVwap: true, relativeStrength: 2, priceChangePercent: 1.5 }, -0.5, { regime: "TRENDING" }) === "BULLISH",
    );
    check(
      "trend label: a CHOP regime still reads SIDEWAYS",
      planner.classifyTrend({ aboveVwap: true, relativeStrength: 2, priceChangePercent: 1.5 }, 0.5, { regime: "CHOP" }) === "SIDEWAYS",
    );


    // ══ 14. v8.6 dip measured from the running high, capped at the signal ══
    // The frozen buy level was why approved runners (META, MU, SMCI on
    // Sep 17-25) sent "waiting to buy the dip" and never filled.
    const trailPlan = {
      symbol: "meta", entryPrice: 100, stopPrice: 96, stopDistancePct: 4, targetT1: 104,
      targetT2: 108, targetT3: null, positionDollars: 2500, riskDollars: 50, atrPercent: 4, score: 88,
    };
    const trailAt = Date.parse("2026-09-26T14:00:00Z");
    const trailOrder = (trail) =>
      planner.buildDipEntryOrder(trailPlan, { depthOfStop: 0.25, windowMinutes: 60, nowMs: trailAt, trailFromHigh: trail });

    const frozen = trailOrder(false);
    planner.evaluateDipEntry(frozen, 105, trailAt + 60000);
    check(
      "dip anchor: without trailing, a run-up leaves the buy price where it was",
      frozen.triggerPrice === 99 &&
        planner.evaluateDipEntry(frozen, 103.95, trailAt + 120000).action === "WAIT",
    );

    const trailing = trailOrder(true);
    check("dip anchor: starts one dip below the approval price", trailing.triggerPrice === 99);
    planner.evaluateDipEntry(trailing, 105, trailAt + 60000);
    check(
      "dip anchor: after a run-up the buy price rises, but never above the approval price",
      trailing.triggerPrice === 100 && trailing.highestPrice === 105,
    );
    const trailFill = planner.evaluateDipEntry(trailing, 100, trailAt + 120000);
    check("dip anchor: a pullback to the approval price now fills", trailFill.action === "FILL" && trailFill.price === 100);

    const smallRun = trailOrder(true);
    planner.evaluateDipEntry(smallRun, 100.4, trailAt + 60000);
    check(
      "dip anchor: a small run-up moves the buy price by the same small amount",
      Math.abs(smallRun.triggerPrice - 99.396) < 1e-9,
    );

    const trailBreak = trailOrder(true);
    planner.evaluateDipEntry(trailBreak, 105, trailAt + 60000);
    check(
      "dip anchor: the breakdown guard moves with the buy price",
      Math.abs(trailBreak.breakdownPrice - 96) < 1e-9 &&
        planner.evaluateDipEntry(trailBreak, 95.9, trailAt + 120000).action === "CANCEL",
    );

    const trailExpired = trailOrder(true);
    planner.evaluateDipEntry(trailExpired, 106, trailAt + 60000);
    const trailRecord = planner.describeDipEntryOrder(trailExpired, trailAt + 61 * 60000);
    check(
      "dip anchor: the journal records the anchor and how far the stock ran while waiting",
      trailRecord.trailFromHigh === true && trailRecord.runUpFromSignalPct === 6,
    );

    {
// ══ 15. v10 shadow strategies — own books, no look-ahead, isolated ══
    const shadowBooks = require("../src/shadow-strategies");
    check("shadow: 5-day average and 14-day ATR compute correctly",
      shadowBooks.sma([1, 2, 3, 4, 5], 5) === 3 &&
        Math.abs(shadowBooks.atr([{ h: 10, l: 9, c: 9.5 }, { h: 11, l: 10, c: 10.5 }, { h: 12, l: 11, c: 11.5 }], 2) - 1.5) < 1e-9);
    check("shadow: 2-day RSI drops under 10 after three sharp down days, and is high after two up days",
      shadowBooks.rsi([10, 11, 12, 13, 14, 15, 16, 14, 12, 10], 2) < 10 && shadowBooks.rsi([16, 15, 14, 13, 12, 11, 10, 11, 12], 2) > 70);
    const open930 = Date.parse("2026-10-12T13:30:00Z"); // 09:30 ET (daylight time)
    const p930 = shadowBooks.etParts(open930);
    check("shadow: New York clock is right (09:30 ET on 2026-10-12)", p930.date === "2026-10-12" && p930.minute === 570);
    const fiveMin = (iso, o, h, l, c) => ({ t: Date.parse(iso), o, h, l, c, v: 1 });
    const sess = shadowBooks.buildSessions({
      FiveMinutes: [
        fiveMin("2026-10-12T04:00:00Z", 50, 200, 1, 50), // 00:00 ET overnight — must be ignored
        fiveMin("2026-10-12T13:30:00Z", 100, 101, 99, 100.5),
        fiveMin("2026-10-12T15:00:00Z", 100.5, 103, 100, 102),
        fiveMin("2026-10-12T19:55:00Z", 102, 102.5, 101, 101.5),
        fiveMin("2026-10-12T21:00:00Z", 101.5, 150, 1, 120), // 17:00 ET after-hours — ignored
      ],
    }).get("2026-10-12");
    check("shadow: session prices use 09:30-16:00 ET only (overnight and after-hours ignored)",
      sess && sess.o === 100 && sess.h === 103 && sess.l === 99 && sess.c === 101.5);
    check("shadow: size risks $50 to the stop, capped at $3,500, refused at or below the stop",
      shadowBooks.sizeFor(100, 98) === 2500 && shadowBooks.sizeFor(100, 99.5) === 3500 && shadowBooks.sizeFor(100, 100) === null);

    const mkCtx = (sessions, daily) => {
      const universe = { AAA: { daily: daily || [], sessions: new Map(Object.entries(sessions)) } };
      const cal = Object.keys(sessions).sort();
      return {
        universe, symbols: ["AAA"],
        prevSession: (d) => cal[Math.max(0, cal.indexOf(d) - 1)],
        nextSessionAfter: (d) => cal.find((x) => x > d) || null,
        nextSessionOnOrAfter: (d) => cal.find((x) => x >= d) || null,
        earnings: null,
      };
    };
    const noop = () => {};
    const fillState = shadowBooks.emptyState("SWING_BREAKOUT");
    fillState.pending = [{ symbol: "AAA", atr: 2, stopAtr: 2, stopAbove: null, reason: "test", signalDate: "2026-10-09" }];
    shadowBooks.processSession("SWING_BREAKOUT", fillState, "2026-10-12",
      mkCtx({ "2026-10-09": { o: 99, h: 99, l: 99, c: 99 }, "2026-10-12": { o: 100, h: 104, l: 99, c: 103 } }), noop);
    const filled = fillState.open.AAA;
    check("shadow: a signal fills at the NEXT session's open, with the stop set from that fill",
      filled && filled.entry === 100 && filled.stop === 96 && filled.size === 1250);

    const gapState = shadowBooks.emptyState("SWING_BREAKOUT");
    gapState.open.AAA = { symbol: "AAA", entryDate: "2026-10-09", entry: 100, stop: 96, stopKind: "initial", size: 1250, riskDollars: 50, peak: 100, trough: 100, heldSessions: 1 };
    shadowBooks.processSession("SWING_BREAKOUT", gapState, "2026-10-12",
      mkCtx({ "2026-10-09": { o: 100, h: 100, l: 100, c: 100 }, "2026-10-12": { o: 90, h: 91, l: 88, c: 89 } }), noop);
    const gapExit = gapState.closed[0];
    check("shadow: a gap through the stop fills at the open, not at the stop", gapExit && gapExit.exit === 90 && gapExit.reason === "STOP");

    const daily = ["2026-10-08", "2026-10-09", "2026-10-12"].map((d, i) => ({ date: d, t: Date.parse(d + "T00:00:00Z"), o: 1, h: 2, l: 0.5, c: 1 + i, v: 1 }));
    const seen = shadowBooks.view({ AAA: { daily, sessions: new Map() } }, "AAA", "2026-10-09");
    check("shadow: signals on a day see only bars up to that day (no look-ahead)",
      seen.bars.length === 2 && seen.bars[seen.bars.length - 1].date === "2026-10-09");

    const rotState = shadowBooks.emptyState("ROTATION");
    const rotCtx = mkCtx({ "2026-10-12": { o: 1, h: 1, l: 1, c: 1 }, "2026-10-13": { o: 1, h: 1, l: 1, c: 1 } });
    shadowBooks.processSession("ROTATION", rotState, "2026-10-12", rotCtx, noop);
    const weekAfterFirst = rotState.lastRebalanceWeek;
    let rebalances = 0;
    shadowBooks.processSession("ROTATION", rotState, "2026-10-13", rotCtx, (e) => { if (e.event === "REBALANCE") rebalances++; });
    check("shadow: rotation re-ranks once per week, not every day", weekAfterFirst === shadowBooks.isoWeek("2026-10-12") && rebalances === 0);

    const shadowSource = fs.readFileSync(path.join(__dirname, "../src/shadow-strategies.js"), "utf8");
    check("shadow: writes only data/shadow-strategies and never touches the live book",
      /data", "shadow-strategies"/.test(shadowSource) &&
        !/position-meta|capital-ledger|decision-journal|trade-history|etoro-client|cooldown/.test(shadowSource.replace(/^\s*\/\/.*$/gm, "")));

    }
    return results;
  },
};
