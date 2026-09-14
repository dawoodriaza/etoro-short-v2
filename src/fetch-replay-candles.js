#!/usr/bin/env node
// src/fetch-replay-candles.js — DAILY MARKET-DATA CAPTURE FOR REPLAYS (v8.1).
//
// eToro's candle endpoint returns at most 1,000 bars per request: about 3.5
// days of 5-minute bars and 10 days of 15-minute bars for 24/5 names. The
// 2026-09 audit therefore had only HOURLY bars for July-August, which blurs
// every intraday entry and exit test. Run daily, this MERGES each fetch into
// data/replay-candles/SYMBOL.json so fine-grained history accumulates rather
// than scrolling out of the API window. src/replay-exits.js reads this
// directory by default.
//
// Schedule it inside the 00:00-04:00 ET overnight freeze, when the bot makes
// no scan calls against the shared eToro market-data rate limit:
//   15 5 * * 2-6  cd ~/etoro-v2-short && node src/fetch-replay-candles.js >> logs/replay-candles.log 2>&1
// (05:15 UTC = 01:15 EDT / 00:15 EST.)
//
// READ-ONLY market-data calls. Places no orders, touches no bot state.
//   node src/fetch-replay-candles.js [--out DIR] [--max-symbols 160] [--spacing-ms 1300]
process.env.LOG_LEVEL = "error";
const fs = require("fs");
const path = require("path");
const etoroClient = require("./etoro-client");
const etoroMarketData = require("./data-sources/etoro-market-data");

const ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index !== -1 && argv[index + 1] ? argv[index + 1] : fallback;
};
const OUT_DIR = path.resolve(argValue("--out", path.join(ROOT, "data/replay-candles")));
const MAX_SYMBOLS = Number(argValue("--max-symbols", "160"));
const SPACING_MS = Number(argValue("--spacing-ms", "1300"));
const DAY_MS = 24 * 3600 * 1000;

const INTERVALS = {
  OneDay: { count: 120, retentionDays: 400 },
  OneHour: { count: 1000, retentionDays: 180 },
  FifteenMinutes: { count: 1000, retentionDays: 90 },
  FiveMinutes: { count: 1000, retentionDays: 45 },
};

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

function compactCandles(candles) {
  return candles
    .map((c) => ({ t: new Date(c.fromDate).getTime(), o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume || 0 }))
    .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c));
}

// Union by bar start time (newest fetch wins), trimmed to the retention window.
function mergeBars(existing, fresh, retentionDays, nowMs) {
  const byTime = new Map();
  (existing || []).forEach((bar) => byTime.set(bar.t, bar));
  (fresh || []).forEach((bar) => byTime.set(bar.t, bar));
  const cutoffMs = nowMs - retentionDays * DAY_MS;
  return [...byTime.values()].filter((bar) => bar.t >= cutoffMs).sort((a, b) => a.t - b.t);
}

// Watchlist, index proxies, recently traded names, and the names the bot has
// recently evaluated most often — the universe a replay will ask about.
function selectSymbols() {
  const weights = new Map();
  const add = (symbol, weight) => {
    if (!symbol) return;
    const key = String(symbol).toUpperCase();
    weights.set(key, (weights.get(key) || 0) + weight);
  };
  const watchlist = readJson(path.join(ROOT, "watchlist-daytrade.json"));
  ((watchlist && watchlist.stocks) || []).forEach((entry) => add(entry.symbol, 1000));
  ["SPY", "QQQ", "VXX"].forEach((symbol) => add(symbol, 1000));

  const recentCutoffMs = Date.now() - 60 * DAY_MS;
  (readJson(path.join(ROOT, "data/trade-history.json")) || [])
    .filter((trade) => Date.parse(trade.closedAt) >= recentCutoffMs)
    .forEach((trade) => add(trade.symbol, 500));

  const journalDir = path.join(ROOT, "data/journal");
  if (fs.existsSync(journalDir)) {
    const journalCutoff = "decisions-" + new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
    for (const file of fs.readdirSync(journalDir).filter((f) => f.endsWith(".jsonl") && f >= journalCutoff)) {
      for (const line of fs.readFileSync(path.join(journalDir, file), "utf8").split("\n")) {
        if (!/"(CANDIDATE_SCORED|PLAN_BUILT|PLAN_REJECTED|SHADOW_SIGNAL|TRADE_OPENED|DIP_ENTRY)"/.test(line)) continue;
        try {
          const event = JSON.parse(line);
          // v8.2: every AI-approved dip order is captured too — including the
          // rockets that never dipped, so what they did next can be measured.
          add(
            event.symbol || (event.plan && event.plan.symbol),
            event.event === "TRADE_OPENED" || event.event === "DIP_ENTRY" ? 500 : 1,
          );
        } catch {
          /* truncated tail line */
        }
      }
    }
  }
  return [...weights.entries()]
    .filter(([, weight]) => weight >= 8)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SYMBOLS)
    .map(([symbol]) => symbol);
}

async function fetchInterval(instrumentId, interval, count) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await pause(SPACING_MS);
      return compactCandles(await etoroMarketData.fetchCandles(instrumentId, interval, count));
    } catch (error) {
      if (attempt === 3) throw error;
      await pause(15000 * attempt);
    }
  }
  return [];
}

// One run at a time: a slow day must not overlap the next scheduled run.
function acquireRunLock() {
  const lockPath = path.join(OUT_DIR, ".fetch.lock");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch {
    const pid = Number(fs.readFileSync(lockPath, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (error) {
      alive = error.code === "EPERM";
    }
    if (alive) return null;
    fs.writeFileSync(lockPath, String(process.pid));
  }
  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };
}

module.exports = { mergeBars, compactCandles };

if (require.main === module) {
  (async () => {
    const releaseRunLock = acquireRunLock();
    if (!releaseRunLock) {
      console.log(new Date().toISOString() + " another capture run is still active — exiting");
      return;
    }
    const startedMs = Date.now();
    let updated = 0;
    let unresolvable = 0;
    let failed = 0;
    try {
      const symbols = selectSymbols();
      for (const symbol of symbols) {
        const filePath = path.join(OUT_DIR, symbol + ".json");
        const existing = readJson(filePath) || { symbol };
        try {
          let instrumentId = existing.instrumentId;
          if (!instrumentId) {
            await pause(SPACING_MS);
            instrumentId = await etoroClient.resolveTickerToInstrumentId(symbol);
          }
          if (!instrumentId) {
            unresolvable++;
            continue;
          }
          const record = { symbol, instrumentId, updatedAt: new Date().toISOString() };
          for (const [interval, settings] of Object.entries(INTERVALS)) {
            const fresh = await fetchInterval(instrumentId, interval, settings.count);
            record[interval] = mergeBars(existing[interval], fresh, settings.retentionDays, Date.now());
          }
          const tempPath = filePath + ".tmp";
          fs.writeFileSync(tempPath, JSON.stringify(record));
          fs.renameSync(tempPath, filePath);
          updated++;
        } catch (error) {
          failed++;
          console.log(new Date().toISOString() + " " + symbol + " failed: " + error.message);
        }
      }
      console.log(
        new Date().toISOString() +
          " replay candles: " + updated + "/" + symbols.length + " updated, " +
          unresolvable + " unresolvable, " + failed + " failed, " +
          Math.round((Date.now() - startedMs) / 1000) + "s → " + OUT_DIR,
      );
    } finally {
      releaseRunLock();
    }
  })().catch((error) => {
    console.error(new Date().toISOString() + " replay candle capture crashed: " + error.message);
    process.exit(1);
  });
}
