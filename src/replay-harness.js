#!/usr/bin/env node
// src/replay-harness.js — TIER-2 OFFLINE REPLAY.
//
// Answers "what if we changed X?" without spending weeks of real money.
//
// WHY THIS EXISTS
// The trade log only contains trades the bot ACTUALLY TOOK (213 of them).
// Loosening any filter creates trades that never existed, so the log is
// silent on them. On 2026-08-28 that wall was hit directly: testing a
// pre-filter change produced "the 0.6-1.0% band has ZERO historical trades
// — history cannot tell us", and the change had to be reverted on a hunch.
//
// The decision journal, however, holds ~8,900 CANDIDATE_SCORED events —
// roughly 42 scored candidates for every trade taken. Those are real,
// point-in-time decisions the bot evaluated and passed over. Combined with
// historical candles they can be replayed under ANY threshold.
//
// READ-ONLY. Touches no trading code paths, places no orders, writes only
// to data/replay-cache/. Safe to run while the bot is live.
//
//   node src/replay-harness.js --fetch          # download+cache candles (slow, once)
//   node src/replay-harness.js --run            # replay with current config
//   node src/replay-harness.js --run --score 70 --atr 6
//   node src/replay-harness.js --sweep score    # compare thresholds
//   node src/replay-harness.js --sweep moveatr
//
// FIDELITY AND ITS LIMITS — read before trusting a number:
//
//  * Geometry is REAL. Entries reuse buildTradePlan(), so stop distance,
//    targets, RRR and sizing are computed by the same code the live bot
//    uses — not a reimplementation that can silently drift from it.
//
//  * Exits are REAL. decidePositionAction() drives them, so MFE giveback,
//    trailing stops, profit-stall and time exits all behave as they do
//    live. That matters: MFE_GIVEBACK was 18-for-18 in real trading, and a
//    simplified stop/target model would badly understate results.
//
//  * Resolution is HOURLY, and this is the main source of error. Within a
//    single candle it is impossible to know whether the high or the low
//    came first. Where both the stop and a target fall inside one candle,
//    this assumes THE STOP HIT FIRST — the standard pessimistic
//    convention. Real results should land slightly better than replayed
//    ones, not worse.
//
//  * No slippage or spread. Replayed fills are perfect; real ones are not.
//    Live stop data showed fills landing worse than plan.
//
//  * Survivorship. It tests today's watchlist against the past, not the
//    list you would actually have been running at the time.
//
// A backtest does not tell you what will work. It tells you cheaply what
// definitely did NOT — which is most of the value, because most ideas are
// wrong and you want to find that out for free.
require("dotenv").config();

// Replay calls buildTradePlan() thousands of times, and each call logs a
// "📋 Plan …" line. Silence the logger BEFORE anything that constructs it
// is required — winston reads this at creation time, so the order matters.
// --verbose restores normal logging for debugging a single case.
if (!process.argv.includes("--verbose")) {
  process.env.LOG_LEVEL = "error";
}

const fs = require("fs");
const path = require("path");
const config = require("../src/config");
const etoroClient = require("./etoro-client");
const etoroMarketData = require("./data-sources/etoro-market-data");
const tradePlanner = require("./strategies/trade-planner");
const riskManager = require("./strategies/risk-manager");

// v8: --data-dir points the harness at a copy of the server's data (journal
// + replay-cache) so it can run on a workstation instead of the 1 GB server,
// where loading every candle file competes with the live bot for memory.
const dataDirArgIndex = process.argv.indexOf("--data-dir");
const dataDir =
  dataDirArgIndex !== -1 && process.argv[dataDirArgIndex + 1]
    ? path.resolve(process.argv[dataDirArgIndex + 1])
    : path.join(__dirname, "../data");
const journalDir = path.join(dataDir, "journal");
const cacheDir = path.join(dataDir, "replay-cache");
const CANDLE_INTERVAL = "OneHour";
const CANDLE_COUNT = 1000; // API ceiling; ~58 days of coverage
const MAX_FORWARD_HOURS = 48; // how far to walk a simulated trade

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f, fallback) => {
  const i = argv.indexOf(f);
  if (i === -1 || i + 1 >= argv.length) return fallback;
  const v = Number(argv[i + 1]);
  return isNaN(v) ? fallback : v;
};
const money = (v) => (v >= 0 ? "+$" : "-$") + Math.abs(v).toFixed(2);

// ── Journal ────────────────────────────────────────────────────────────
function loadScoredCandidates() {
  if (!fs.existsSync(journalDir)) return [];
  const rows = [];
  for (const file of fs.readdirSync(journalDir).filter((f) => f.endsWith(".jsonl"))) {
    const text = fs.readFileSync(path.join(journalDir, file), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.event === "CANDIDATE_SCORED" && event.symbol && event.ts) {
          rows.push(event);
        }
      } catch {
        /* a truncated final line is normal on a live-written file */
      }
    }
  }
  return rows.sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

// ── Candle cache ───────────────────────────────────────────────────────
function cachePathFor(symbol) {
  return path.join(cacheDir, symbol.toUpperCase() + ".json");
}

function loadCandles(symbol) {
  const p = cachePathFor(symbol);
  if (!fs.existsSync(p)) return null;
  try {
    // Stored oldest -> newest so a forward walk is a simple index scan.
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

async function fetchAndCacheCandles(symbols) {
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  let ok = 0;
  let failed = 0;
  for (const symbol of symbols) {
    try {
      const instrumentId = await etoroClient.resolveTickerToInstrumentId(symbol);
      if (!instrumentId) {
        console.log("  " + symbol.padEnd(7) + "unresolvable — skipped");
        failed += 1;
        continue;
      }
      const raw = await etoroMarketData.fetchCandles(
        instrumentId,
        CANDLE_INTERVAL,
        CANDLE_COUNT,
      );
      if (!raw.length) {
        console.log("  " + symbol.padEnd(7) + "no candles returned");
        failed += 1;
        continue;
      }
      // API returns newest-first; store chronologically.
      const chronological = raw
        .map((c) => ({
          t: new Date(c.fromDate).getTime(),
          o: c.open,
          h: c.high,
          l: c.low,
          c: c.close,
        }))
        .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c))
        .sort((a, b) => a.t - b.t);

      fs.writeFileSync(cachePathFor(symbol), JSON.stringify(chronological));
      console.log(
        "  " +
          symbol.padEnd(7) +
          String(chronological.length).padStart(5) +
          " candles  " +
          new Date(chronological[0].t).toISOString().slice(0, 10) +
          " → " +
          new Date(chronological[chronological.length - 1].t)
            .toISOString()
            .slice(0, 10),
      );
      ok += 1;
    } catch (error) {
      console.log("  " + symbol.padEnd(7) + "FAILED: " + error.message);
      failed += 1;
    }
  }
  console.log("\ncached " + ok + " symbols, " + failed + " failed");
}

// ── Simulation ─────────────────────────────────────────────────────────

// The exit engine measures elapsed time against Date.now(). To replay a
// historical trade we shift openedAt so that (now - openedAt) equals the
// SIMULATED elapsed time — letting the real time-exit logic run unmodified
// instead of reimplementing it here (and drifting from it later).
function simulateTrade(candidate, candles, startIndex, plan) {
  const entryPrice = plan.entryPrice;
  const meta = {
    tradeType: plan.tradeType,
    entryPrice,
    stopPrice: plan.stopPrice,
    targetT1: plan.targetT1,
    targetT2: plan.targetT2,
    targetT3: plan.targetT3,
    swingTrailPct: plan.swingTrailPct,
    lockedFloor: null,
    peakPrice: entryPrice,
    peakSetAt: Date.now(),
    recentPrices: [],
    partialDone: false,
    partialT1Done: false,
    partialT2Done: false,
    dollarAmount: plan.positionDollars,
    openedAt: Date.now(),
    plan,
    entryConditions: { atrPercent: plan.atrPercent },
  };

  let realizedFraction = 0;
  let realizedPnlPct = 0;

  const endIndex = Math.min(candles.length - 1, startIndex + MAX_FORWARD_HOURS);
  for (let i = startIndex + 1; i <= endIndex; i += 1) {
    const bar = candles[i];
    const elapsedMs = (i - startIndex) * 60 * 60 * 1000;

    // Re-anchor the clock so the real time-budget logic sees simulated age.
    meta.openedAt = Date.now() - elapsedMs;
    if (meta.peakSetAt) meta.peakSetAt = Date.now() - elapsedMs;

    // PESSIMISTIC ORDERING: if the stop is inside this candle's range at
    // all, treat it as hit before any favourable excursion. Within one
    // hourly bar the true sequence is unknowable, so assume the worse one.
    const stopLevel = meta.lockedFloor || meta.stopPrice;
    if (stopLevel && bar.l <= stopLevel) {
      const exitPct = ((stopLevel - entryPrice) / entryPrice) * 100;
      realizedPnlPct += exitPct * (1 - realizedFraction);
      return { exitReason: "STOP_LOSS", pnlPercent: realizedPnlPct, hours: i - startIndex };
    }

    // Feed the bar close to the REAL decision engine.
    meta.recentPrices.push({ price: bar.c, atMs: Date.now() - elapsedMs });
    if (meta.recentPrices.length > config.recoveryCheckMinSamples + 2) {
      meta.recentPrices.shift();
    }

    const decision = riskManager.decidePositionAction(meta, bar.c);
    if (decision.newPeak && decision.newPeak !== meta.peakPrice) {
      meta.peakPrice = decision.newPeak;
      meta.peakSetAt = Date.now() - elapsedMs;
    }

    if (decision.action === "PARTIAL" && !meta.partialDone) {
      const fraction = decision.fraction || config.partialExitFraction;
      const exitPct = ((bar.c - entryPrice) / entryPrice) * 100;
      realizedPnlPct += exitPct * fraction;
      realizedFraction += fraction;
      meta.partialDone = true;
      if (decision.flagOnSuccess) meta[decision.flagOnSuccess] = true;
      if (decision.floorOnSuccess != null) meta.lockedFloor = decision.floorOnSuccess;
      continue;
    }

    if (decision.action === "EXIT") {
      const exitPct = ((bar.c - entryPrice) / entryPrice) * 100;
      realizedPnlPct += exitPct * (1 - realizedFraction);
      return { exitReason: decision.reason, pnlPercent: realizedPnlPct, hours: i - startIndex };
    }
  }

  // Ran out of forward data — close at the last available bar.
  const last = candles[endIndex];
  const exitPct = ((last.c - entryPrice) / entryPrice) * 100;
  realizedPnlPct += exitPct * (1 - realizedFraction);
  return {
    exitReason: "WINDOW_END",
    pnlPercent: realizedPnlPct,
    hours: endIndex - startIndex,
  };
}

function indexAtOrAfter(candles, timestampMs) {
  for (let i = 0; i < candles.length; i += 1) {
    if (candles[i].t >= timestampMs) return i;
  }
  return -1;
}

// ── Replay ─────────────────────────────────────────────────────────────
function replay(scored, filters) {
  // ══════════════════════════════════════════════════════════════════
  // CRITICAL: buildTradePlan() applies config.minEntryScore ITSELF.
  //
  // Without overriding it, every sweep row was silently re-filtered at
  // the LIVE threshold (80) no matter which value was being tested —
  // making "score >= 50" and "score >= 80" produce the same population
  // and the sweep meaningless. The harness caught this on its first real
  // use: trade counts RISING as the threshold tightened, which is
  // impossible.
  //
  // Also pin sessionAwareTimeBudgets off. It measures elapsed REGULAR-
  // SESSION minutes against Date.now(), so a replayed trade's time-exit
  // would depend on what time of day the harness happened to run —
  // making results non-reproducible between sweep rows. Wall-clock
  // elapsed is fully controlled here, so replay uses that instead.
  // This is a documented fidelity trade-off: time exits fire slightly
  // sooner in replay than they would live during a closed market.
  // ══════════════════════════════════════════════════════════════════
  const savedMinScore = config.minEntryScore;
  const savedSessionAware = config.sessionAwareTimeBudgets;
  config.minEntryScore = filters.minScore != null ? filters.minScore : 0;
  config.sessionAwareTimeBudgets = false;

  try {
    return replayInner(scored, filters);
  } finally {
    config.minEntryScore = savedMinScore;
    config.sessionAwareTimeBudgets = savedSessionAware;
  }
}

function replayInner(scored, filters) {
  const results = [];
  let noCandles = 0;
  let noForwardData = 0;
  let filteredOut = 0;
  let planRejected = 0;

  for (const candidate of scored) {
    // ── Apply the filters under test ──
    if (filters.minScore != null && (candidate.score ?? 0) < filters.minScore) {
      filteredOut += 1;
      continue;
    }
    if (
      filters.maxAtr != null &&
      candidate.atrPercent != null &&
      candidate.atrPercent > filters.maxAtr
    ) {
      filteredOut += 1;
      continue;
    }

    const candles = loadCandles(candidate.symbol);
    if (!candles || candles.length < 5) {
      noCandles += 1;
      continue;
    }
    const startIndex = indexAtOrAfter(candles, new Date(candidate.ts).getTime());
    if (startIndex === -1 || startIndex >= candles.length - 2) {
      noForwardData += 1;
      continue;
    }

    const entryBar = candles[startIndex];
    const entryPrice = entryBar.c;

    // Reconstruct the move vs the prior session for the move/ATR filter.
    // The journal does not record priceChangePercent (fixed in v7.8 for
    // FUTURE trades), so for historical events it is derived from candles.
    const dayAgoIndex = Math.max(0, startIndex - 7);
    const priorClose = candles[dayAgoIndex].c;
    const movePercent = priorClose > 0 ? ((entryPrice - priorClose) / priorClose) * 100 : 0;
    if (
      filters.minMoveToAtr != null &&
      candidate.atrPercent > 0 &&
      Math.abs(movePercent) / candidate.atrPercent < filters.minMoveToAtr
    ) {
      filteredOut += 1;
      continue;
    }

    // ── REAL plan geometry: same function the live bot uses ──
    const built = tradePlanner.buildTradePlan(
      {
        symbol: candidate.symbol,
        currentPrice: entryPrice,
        atrPercent: candidate.atrPercent,
        priceChangePercent: movePercent,
        rsi: candidate.rsi,
        relativeStrength: candidate.relativeStrength,
        aboveVwap: candidate.aboveVwap,
        score: candidate.score,
        setup: candidate.setup,
        detail: "replay",
        source: candidate.source || "WATCHLIST",
        averageVolume: 1e9, // liquidity floor is not what is under test here
      },
      { regime: "TRENDING", spyChangePercent: 0, easternWeekday: 4 },
      { effectiveCapital: config.dayTradeCapital, riskMultiplier: 1 },
      { dayCount: 0, swingCount: 0 },
      false,
    );
    if (!built.accepted) {
      planRejected += 1;
      continue;
    }

    const outcome = simulateTrade(candidate, candles, startIndex, built.plan);
    results.push({
      symbol: candidate.symbol,
      ts: candidate.ts,
      score: candidate.score,
      atrPercent: candidate.atrPercent,
      movePercent,
      moveToAtr: candidate.atrPercent > 0 ? Math.abs(movePercent) / candidate.atrPercent : null,
      pnlPercent: outcome.pnlPercent,
      pnlDollars: (outcome.pnlPercent / 100) * built.plan.positionDollars,
      exitReason: outcome.exitReason,
      hours: outcome.hours,
    });
  }

  return { results, noCandles, noForwardData, filteredOut, planRejected };
}

function summarize(label, run) {
  const r = run.results;
  if (!r.length) {
    console.log(label.padEnd(30) + "no simulated trades");
    return null;
  }
  const pnl = r.map((x) => x.pnlDollars);
  const wins = pnl.filter((v) => v > 0).length;
  const total = pnl.reduce((s, v) => s + v, 0);
  console.log(
    label.padEnd(30) +
      String(r.length).padStart(5) +
      " tr  " +
      String(((wins / r.length) * 100).toFixed(0)).padStart(3) +
      "% win  " +
      money(total).padStart(11) +
      "  avg " +
      money(total / r.length).padStart(8),
  );
  return { trades: r.length, winRate: (wins / r.length) * 100, total };
}

// ── Entry point ────────────────────────────────────────────────────────
// Guarded so `require()`ing this file (e.g. from a test) does not kick off
// a full replay as a side effect.
if (require.main !== module) {
  module.exports = { loadScoredCandidates, loadCandles, replay, simulateTrade };
} else
(async () => {
  if (hasFlag("--fetch")) {
    const wl = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../watchlist-daytrade.json"), "utf8"),
    );
    const scored = loadScoredCandidates();
    const symbols = [
      ...new Set([
        ...wl.stocks.map((s) => s.symbol),
        ...scored.map((s) => s.symbol),
      ]),
    ];
    console.log(
      "Fetching " + CANDLE_INTERVAL + " x" + CANDLE_COUNT + " for " + symbols.length + " symbols…\n",
    );
    await fetchAndCacheCandles(symbols);
    console.log("\nDone. Now run:  node src/replay-harness.js --run");
    return;
  }

  const scored = loadScoredCandidates();
  if (!scored.length) {
    console.log("No CANDIDATE_SCORED events found in data/journal/.");
    return;
  }
  if (!fs.existsSync(cacheDir)) {
    console.log("No candle cache. Run:  node src/replay-harness.js --fetch");
    return;
  }

  console.log(
    "\nJournal: " +
      scored.length +
      " scored candidates, " +
      scored[0].ts.slice(0, 10) +
      " → " +
      scored[scored.length - 1].ts.slice(0, 10),
  );
  console.log(
    "Fidelity: real buildTradePlan + real decidePositionAction · hourly bars · " +
      "stop assumed first on ties · no slippage\n",
  );

  if (hasFlag("--sweep")) {
    const which = argv[argv.indexOf("--sweep") + 1];
    if (which === "score") {
      console.log("=== SCORE THRESHOLD SWEEP ===");
      for (const s of [0, 50, 60, 70, 80, 90]) {
        summarize("score >= " + s, replay(scored, { minScore: s }));
      }
    } else if (which === "atr") {
      console.log("=== ATR CEILING SWEEP ===");
      for (const a of [99, 9, 8, 7, 6, 5]) {
        summarize("ATR <= " + (a === 99 ? "any" : a + "%"), replay(scored, { maxAtr: a }));
      }
    } else if (which === "moveatr") {
      console.log("=== MOVE/ATR RATIO SWEEP ===");
      for (const m of [0, 0.3, 0.6, 1.0, 1.5]) {
        summarize("move/ATR >= " + m, replay(scored, { minMoveToAtr: m }));
      }
    } else {
      console.log("Unknown sweep. Use: score | atr | moveatr");
    }
    console.log(
      "\nCompare against the LIVE config, not against zero — the question is\n" +
        "whether a change beats what is already running.",
    );
    return;
  }

  // Single run, defaulting to the live configuration.
  const filters = {
    minScore: flagValue("--score", config.minEntryScore),
    maxAtr: flagValue("--atr", config.maxEntryAtrPct || null),
    minMoveToAtr: flagValue("--moveatr", config.minMoveToAtrRatio || null),
  };
  console.log(
    "Filters: score>=" +
      filters.minScore +
      "  ATR<=" +
      filters.maxAtr +
      "%  move/ATR>=" +
      (filters.minMoveToAtr || 0),
  );
  const run = replay(scored, filters);
  console.log("");
  summarize("RESULT", run);
  console.log("");
  console.log(
    "skipped: " +
      run.filteredOut +
      " by filters · " +
      run.noCandles +
      " no cached candles · " +
      run.noForwardData +
      " no forward data · " +
      run.planRejected +
      " rejected by planner",
  );

  const byReason = {};
  run.results.forEach((r) => {
    (byReason[r.exitReason] = byReason[r.exitReason] || []).push(r.pnlDollars);
  });
  console.log("\nby exit reason:");
  Object.entries(byReason)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([reason, list]) => {
      const t = list.reduce((s, v) => s + v, 0);
      const w = list.filter((v) => v > 0).length;
      console.log(
        "  " +
          reason.padEnd(22) +
          String(list.length).padStart(5) +
          " tr  " +
          String(((w / list.length) * 100).toFixed(0)).padStart(3) +
          "% win  " +
          money(t).padStart(11),
      );
    });
  console.log("");
})().catch((error) => {
  console.error("\nReplay failed: " + error.message + "\n");
  process.exit(1);
});
