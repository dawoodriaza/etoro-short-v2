#!/usr/bin/env node
// src/replay-exits.js — EXIT-MANAGEMENT REPLAY ON REAL ENTRIES (v8).
//
// WHY A SECOND HARNESS
// replay-harness.js asks "which ENTRY filter?" at hourly resolution. The
// 2026-09 audit found the entry signal carries ~no forward edge: taken,
// AI-skipped and score-floor-rejected candidates all resolve +1R-first vs
// -1R-first at about the same rate within 150 minutes. Tuning entry filters
// on that is curve fitting. What CAN change the outcome is what happens
// after entry — how losers are cut and how winners are protected, trimmed,
// added to and run. This harness measures exactly that.
//
// FIDELITY
//  * The REAL engine decides: risk-manager.decidePositionAction() runs on
//    every bar under a VIRTUAL CLOCK (Date.now is pinned to the bar), so
//    session-aware time budgets, the MFE floor, the profit-stall lock and
//    recovery grace behave as they do live instead of being re-implemented.
//  * Finest bars available per moment: 5m where cached, else 15m, else 1h.
//  * Intrabar order is pessimistic: price-level exits (stop, MFE floor,
//    runner trail) are tested against the bar LOW using the peak from BEFORE
//    the bar; only then is the peak raised to the bar high and targets
//    checked; time-based rules run on the close.
//  * Stop whipsaw filter mirrored: a shallow poke (inside
//    DT_STOP_WICK_BAND_PCT) that closes back above the stop is held.
//  * EOD rules: Mon-Thu at the force-close, losers close and winners are held
//    (24/5 keep-winners mode); Friday closes everything.
//  * Round-trip cost applied (--cost-bps, default 10).
//
// SAMPLE SETS (always split in-sample / out-of-sample at --split)
//   trades   — every closed trade in trade-history.json (the real entries)
//   extended — TAKEN + AI-SKIPPED + score-floor-rejected plans from the
//              journal, one per symbol+group per 60 min. Their entry quality
//              is indistinguishable from the taken set, so they multiply the
//              evidence behind any EXIT rule roughly tenfold.
//
// USAGE
//   node src/replay-exits.js --data-dir data --candles data/replay-candles \
//     --legacy-candles data/replay-cache --split 2026-08-22 \
//     [--set trades|extended|shadow|both|all] [--variants CURRENT,NO_STALL_LOCK]
//     [--env path/to/server.env] [--json out.json]
//
// READ-ONLY. Places no orders and touches no live state.
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index !== -1 && argv[index + 1] ? argv[index + 1] : fallback;
};
if (argValue("--env", null)) {
  require("dotenv").config({ path: path.resolve(argValue("--env")), override: true });
}
if (!argv.includes("--verbose")) process.env.LOG_LEVEL = "error";

const config = require("./config");
const tradePlanner = require("./strategies/trade-planner");
const riskManager = require("./strategies/risk-manager");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.resolve(argValue("--data-dir", path.join(ROOT, "data")));
const CANDLE_DIR = path.resolve(argValue("--candles", path.join(DATA_DIR, "replay-candles")));
const LEGACY_DIR = path.resolve(argValue("--legacy-candles", path.join(DATA_DIR, "replay-cache")));
const SPLIT = argValue("--split", "2026-08-22");
const SET = argValue("--set", "both");
const COST = Number(argValue("--cost-bps", "10")) / 10000;
const HORIZON_MS = 3 * 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

// ── Variants ─────────────────────────────────────────────────────────────
// `config` entries are applied to the shared config object for the run and
// restored afterwards; the other keys are harness-level rules that do not
// exist in the live engine (yet) and are what is being evaluated.
const VARIANTS = {
  CURRENT: {},
  NO_STALL_LOCK: { config: { profitStallEnabled: false } },
  EARLY_FAIL_45: { earlyFailure: { sessionMinutes: 45, maxMfeR: 0.25 } },
  EARLY_FAIL_75: { earlyFailure: { sessionMinutes: 75, maxMfeR: 0.25 } },
  STOP_075_ATR: { stopAtrMultiple: 0.75, stopMaxPct: 0.04 },
  STOP_100_ATR: { stopAtrMultiple: 1.0, stopMaxPct: 0.05 },
  GIVEBACK_WIDE: { config: { mfeArmAtrFraction: 0.5, mfeGivebackAtrCap: 0.5, mfeRetention: 0.5 } },
  T1_THIRD: { config: { partialExitFraction: 1 / 3 } },
  T1_AT_1_5R: { t1R: 1.5 },
  ADD_AT_1R: { addOn: { atR: 1.0, fraction: 0.5, stopLockR: 0.25, t1R: 2.0 } },
  // Stop-width curve: is 1.0x ATR a plateau or a lucky point?
  STOP_100_CLAMP3: { stopAtrMultiple: 1.0, stopMaxPct: 0.03 },
  STOP_125_ATR: { stopAtrMultiple: 1.25, stopMaxPct: 0.06 },
  STOP_100_NOSTALL: { stopAtrMultiple: 1.0, stopMaxPct: 0.05, config: { profitStallEnabled: false } },
  // Combinations of the individually consistent improvements.
  COMBO_STOP100_T15: { stopAtrMultiple: 1.0, stopMaxPct: 0.05, t1R: 1.5 },
  COMBO_STOP100_T15_NOSTALL: { stopAtrMultiple: 1.0, stopMaxPct: 0.05, t1R: 1.5, config: { profitStallEnabled: false } },
  COMBO_STOP075_T15_NOSTALL: { stopAtrMultiple: 0.75, stopMaxPct: 0.04, t1R: 1.5, config: { profitStallEnabled: false } },
};

// ── Time helpers ─────────────────────────────────────────────────────────
const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23", weekday: "short",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
function easternInfo(ms) {
  const parts = ET_PARTS.formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    date: get("year") + "-" + get("month") + "-" + get("day"),
    weekday: get("weekday"),
    minute: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

// ── Candles ──────────────────────────────────────────────────────────────
const barCache = {};
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
// One non-overlapping series per symbol: hourly history, then 15m from where
// 15m coverage starts, then 5m from where 5m coverage starts.
function loadBars(symbol) {
  if (barCache[symbol] !== undefined) return barCache[symbol];
  const fresh = readJson(path.join(CANDLE_DIR, symbol + ".json"));
  const legacy = readJson(path.join(LEGACY_DIR, symbol + ".json"));
  if (!fresh && !legacy) return (barCache[symbol] = null);
  const hourly = new Map();
  (Array.isArray(legacy) ? legacy : []).forEach((b) => hourly.set(b.t, b));
  ((fresh && fresh.OneHour) || []).forEach((b) => hourly.set(b.t, b));
  const m15 = (fresh && fresh.FifteenMinutes) || [];
  const m5 = (fresh && fresh.FiveMinutes) || [];
  const m15Start = m15.length ? m15[0].t : Infinity;
  const m5Start = m5.length ? m5[0].t : Infinity;
  const merged = [];
  [...hourly.values()].sort((a, b) => a.t - b.t).forEach((b) => {
    if (b.t + HOUR <= m15Start) merged.push({ ...b, dur: HOUR });
  });
  m15.forEach((b) => { if (b.t + 15 * 60000 <= m5Start) merged.push({ ...b, dur: 15 * 60000 }); });
  m5.forEach((b) => merged.push({ ...b, dur: 5 * 60000 }));
  merged.sort((a, b) => a.t - b.t);
  return (barCache[symbol] = merged);
}
function firstBarIndexAtOrAfter(bars, ms) {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].t < ms) lo = mid + 1; else hi = mid; }
  return lo;
}

// ── Samples ──────────────────────────────────────────────────────────────
function readJournal() {
  const dir = path.join(DATA_DIR, "journal");
  const events = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* truncated tail line */ }
    }
  }
  return events;
}

function geometryFromAtr(atrPercent) {
  const raw = atrPercent != null ? (atrPercent / 100) * config.dayAtrStopMultiple : config.stopLossPct;
  const stopFraction = Math.min(config.dayStopClampMaxPct, Math.max(config.dayStopClampMinPct, raw));
  return stopFraction * 100;
}

function tradeSamples(events) {
  const history = readJson(path.join(DATA_DIR, "trade-history.json")) || [];
  const partials = events.filter((e) => e.event === "EXIT_DECISION" && e.action === "PARTIAL");
  return history.filter((t) => t.plan && t.openedAt && t.closedAt).map((t) => {
    const openMs = new Date(t.openedAt).getTime();
    const closeMs = new Date(t.closedAt).getTime();
    const planned = t.plan.positionDollars;
    const isHalved = planned && t.dollarAmount / planned < 0.7;
    const originalAmount = t.pnlAccountingVersion === 2 ? t.dollarAmount : planned || t.dollarAmount;
    let partialPnl = t.pnlAccountingVersion === 2 ? 0 : 0;
    if (t.pnlAccountingVersion !== 2) {
      partials
        .filter((p) => p.symbol === t.symbol && new Date(p.ts).getTime() >= openMs - 60000 && new Date(p.ts).getTime() <= closeMs + 60000)
        .forEach((p) => { partialPnl += (isHalved ? Math.min(planned, t.dollarAmount * 2) : originalAmount) * 0.5 * (p.currentPrice / t.entryPrice - 1); });
    }
    const actualPnl = t.pnlDollars + partialPnl;
    return {
      set: "trades", group: "TAKEN", symbol: t.symbol, entryMs: openMs, entryPrice: t.entryPrice,
      stopPct: t.plan.stopDistancePct, atrPercent: t.plan.atrPercent, sizeDollars: originalAmount,
      score: t.plan.score, rsi: t.plan.rsi, relativeStrength: t.plan.relativeStrength, aboveVwap: t.plan.aboveVwap, priceChangePercent: t.plan.priceChangePercent, regime: t.plan.regime, spyChangePercent: t.plan.spyChangePercent,
      actualPnl, actualR: actualPnl / (originalAmount * t.plan.stopDistancePct / 100),
    };
  });
}

function extendedSamples(events) {
  const aiBySymbol = {};
  events.filter((e) => e.event === "AI_DECISION" && (e.decision === "TAKE" || e.decision === "SKIP"))
    .forEach((e) => (aiBySymbol[e.symbol] = aiBySymbol[e.symbol] || []).push(e));
  const lastKept = {};
  const samples = [];
  for (const e of events) {
    let sample = null;
    if (e.event === "TRADE_OPENED" && e.plan) {
      sample = { group: "TAKEN", symbol: e.plan.symbol, entryPrice: e.plan.entryPrice, stopPct: e.plan.stopDistancePct, atrPercent: e.plan.atrPercent, sizeDollars: e.plan.positionDollars, score: e.plan.score, rsi: e.plan.rsi, relativeStrength: e.plan.relativeStrength, aboveVwap: e.plan.aboveVwap, priceChangePercent: e.plan.priceChangePercent, regime: e.plan.regime, spyChangePercent: e.plan.spyChangePercent };
    } else if (e.event === "PLAN_BUILT" && e.plan) {
      const t = new Date(e.ts).getTime();
      const verdict = (aiBySymbol[e.plan.symbol] || []).find((a) => { const at = new Date(a.ts).getTime(); return at >= t - 5000 && at - t < 180000; });
      if (!verdict || verdict.decision !== "SKIP") continue;
      sample = { group: "AI_SKIP", symbol: e.plan.symbol, entryPrice: e.plan.entryPrice, stopPct: e.plan.stopDistancePct, atrPercent: e.plan.atrPercent, sizeDollars: e.plan.positionDollars, score: e.plan.score, rsi: e.plan.rsi, relativeStrength: e.plan.relativeStrength, aboveVwap: e.plan.aboveVwap, priceChangePercent: e.plan.priceChangePercent, regime: e.plan.regime, spyChangePercent: e.plan.spyChangePercent };
    } else if (e.event === "PLAN_REJECTED" && e.snapshot && e.snapshot.price && /entry floor/.test(e.rejectReason || "")) {
      const stopPct = geometryFromAtr(e.snapshot.atrPercent);
      const volMult = tradePlanner.classifyVolatility(e.snapshot.atrPercent) === "HIGH" ? config.highVolSizeMultiplier : 1;
      sample = { group: "FLOOR_REJECTED", symbol: e.symbol, entryPrice: e.snapshot.price, stopPct, atrPercent: e.snapshot.atrPercent,
        sizeDollars: Math.min((config.dayTradeCapital * config.riskPctDay * volMult) / (stopPct / 100), config.dayTradeCapital * config.maxPositionPctDay),
        score: e.snapshot.score, rsi: e.snapshot.rsi, relativeStrength: e.snapshot.relativeStrength, aboveVwap: e.snapshot.aboveVwap, priceChangePercent: e.snapshot.priceChangePercent, regime: e.snapshot.regime, spyChangePercent: e.snapshot.spyChangePercent };
    }
    if (!sample || !sample.entryPrice || !sample.stopPct) continue;
    const key = sample.symbol + "|" + sample.group;
    const t = new Date(e.ts).getTime();
    if (lastKept[key] && t - lastKept[key] < HOUR) continue;
    lastKept[key] = t;
    samples.push({ ...sample, set: "extended", entryMs: t });
  }
  return samples;
}

// ── Simulation ───────────────────────────────────────────────────────────
// v8.1: SHADOW_SIGNAL records (strategies/shadow-signals.js) carry the
// scan-time price, the planner's stop distance and what the bot finally did,
// so every candidate — taken or not — is a replayable sample, grouped by its
// outcome (SHADOW_OPENED, SHADOW_AI_SKIP, SHADOW_PLAN_REJECTED, ...).
function shadowSamples(events) {
  const lastKept = {};
  const samples = [];
  for (const e of events) {
    if (e.event !== "SHADOW_SIGNAL" || !(e.price > 0) || !(e.stopDistancePct > 0)) continue;
    const group = "SHADOW_" + e.outcome;
    const key = e.symbol + "|" + group;
    const t = new Date(e.ts).getTime();
    if (lastKept[key] && t - lastKept[key] < HOUR) continue;
    lastKept[key] = t;
    const volMult = tradePlanner.classifyVolatility(e.atrPercent) === "HIGH" ? config.highVolSizeMultiplier : 1;
    samples.push({
      set: "shadow", group, symbol: e.symbol, entryMs: t, entryPrice: e.price,
      stopPct: e.stopDistancePct, atrPercent: e.atrPercent,
      sizeDollars: Math.min((config.dayTradeCapital * config.riskPctDay * volMult) / (e.stopDistancePct / 100), config.dayTradeCapital * config.maxPositionPctDay),
      score: e.score, rsi: e.rsi, relativeStrength: e.relativeStrength, aboveVwap: e.aboveVwap,
      priceChangePercent: e.priceChangePercent, regime: e.regime, spyChangePercent: e.spyChangePercent,
      rangePosition: e.rangePosition, belowHighPct: e.belowHighPct, vwapDistancePct: e.vwapDistancePct,
      outcome: e.outcome,
    });
  }
  return samples;
}

function simulate(sample, variant) {
  const bars = loadBars(sample.symbol);
  if (!bars || !bars.length) return null;
  let index = firstBarIndexAtOrAfter(bars, sample.entryMs);
  if (index >= bars.length || bars[index].t - sample.entryMs > 2 * HOUR) return null;

  // Geometry (a stop-width variant rebuilds it and resizes to the same $ risk)
  let stopPct = sample.stopPct;
  let sizeDollars = sample.sizeDollars;
  if (variant.stopAtrMultiple && sample.atrPercent != null) {
    const newStopPct = Math.min(variant.stopMaxPct * 100, Math.max(config.dayStopClampMinPct * 100, sample.atrPercent * variant.stopAtrMultiple));
    sizeDollars = Math.min(sizeDollars * (stopPct / newStopPct), config.dayTradeCapital * config.maxPositionPctDay);
    stopPct = newStopPct;
  }
  const entry = sample.entryPrice;
  const risk = stopPct / 100;
  const t1R = (variant.addOn && variant.addOn.t1R) || variant.t1R || 1.0;
  const meta = {
    tradeType: "DAY", entryPrice: entry, stopPrice: entry * (1 - risk),
    targetT1: entry * (1 + risk * t1R), targetT2: entry * (1 + risk * 2 * t1R),
    lockedFloor: null, peakPrice: entry, peakSetAt: sample.entryMs, recentPrices: [],
    partialDone: false, openedAt: sample.entryMs, dollarAmount: sizeDollars,
    plan: { atrPercent: sample.atrPercent, stopDistancePct: stopPct },
    entryConditions: { atrPercent: sample.atrPercent },
  };

  // Units held per leg, as a fraction of the ORIGINAL size.
  const legs = [{ entry: entry * (1 + COST / 2), units: 1 }];
  let realizedDollars = 0;
  let partials = 0, adds = 0, exitReason = null, exitMs = null;
  let maxHigh = entry;
  const sell = (fraction, price) => {
    for (const leg of legs) {
      const units = leg.units * fraction;
      realizedDollars += units * sizeDollars * ((price * (1 - COST / 2)) / leg.entry - 1);
      leg.units -= units;
    }
  };
  const remainingUnits = () => legs.reduce((s, leg) => s + leg.units, 0);
  const forceCloseMinute = 16 * 60 - config.forceCloseMinutesBeforeClose;

  const realNow = Date.now;
  try {
    for (; index < bars.length; index++) {
      const bar = bars[index];
      const barEnd = bar.t + bar.dur;
      if (bar.t - sample.entryMs > HORIZON_MS) break;
      Date.now = () => barEnd;

      // EOD rules at the force-close minute.
      const startInfo = easternInfo(bar.t);
      const endInfo = easternInfo(barEnd - 1);
      const isWeekday = !["Sat", "Sun"].includes(startInfo.weekday);
      const crossesClose = isWeekday && startInfo.date === endInfo.date &&
        startInfo.minute <= forceCloseMinute && endInfo.minute >= forceCloseMinute && bar.t > sample.entryMs;
      if (crossesClose) {
        const price = startInfo.minute === forceCloseMinute ? bar.o : bar.c;
        if (startInfo.weekday === "Fri") { sell(1, price); exitReason = "FRIDAY_FORCE_CLOSE"; exitMs = barEnd; break; }
        if (price <= entry * (1 + config.overnightHoldMinProfitPct / 100)) { sell(1, price); exitReason = "EOD_FORCE_CLOSE"; exitMs = barEnd; break; }
      }

      // 1. Price-level exits against the bar LOW, with the pre-bar peak.
      const peakBefore = Math.max(meta.peakPrice, entry);
      if (!meta.partialDone && bar.l <= meta.stopPrice) {
        const shallow = bar.l >= meta.stopPrice * (1 - config.stopWickBandPct);
        if (!(shallow && bar.c > meta.stopPrice)) {
          sell(1, Math.min(meta.stopPrice, bar.o)); exitReason = "STOP_LOSS"; exitMs = barEnd; break;
        }
      }
      const protection = riskManager.computeMfeProtection(meta, peakBefore);
      if (protection.floor != null && bar.l <= protection.floor) {
        sell(1, Math.min(protection.floor, bar.o)); exitReason = "MFE_GIVEBACK"; exitMs = barEnd; break;
      }
      if (meta.partialDone) {
        const trail = Math.max(peakBefore * (1 - config.trailingStopPct), entry);
        if (bar.l <= trail) { sell(1, Math.min(trail, bar.o)); exitReason = "TRAILING_STOP"; exitMs = barEnd; break; }
      }

      // 2. Raise the peak, then targets / add-on against the bar HIGH.
      if (bar.h > meta.peakPrice) { meta.peakPrice = bar.h; meta.peakSetAt = barEnd; }
      maxHigh = Math.max(maxHigh, bar.h);
      if (variant.addOn && adds === 0 && bar.h >= entry * (1 + risk * variant.addOn.atR)) {
        const addPrice = Math.max(entry * (1 + risk * variant.addOn.atR), bar.o);
        legs.push({ entry: addPrice * (1 + COST / 2), units: variant.addOn.fraction });
        meta.stopPrice = Math.max(meta.stopPrice, entry * (1 + risk * variant.addOn.stopLockR));
        adds++;
      }
      if (!meta.partialDone && bar.h >= meta.targetT1) {
        sell(config.partialExitFraction, Math.max(meta.targetT1, bar.o));
        meta.partialDone = true; partials++;
      }

      // 3. Close-of-bar rules through the REAL engine.
      meta.recentPrices.push({ price: bar.c, atMs: barEnd });
      if (meta.recentPrices.length > config.recoveryCheckMinSamples + 2) meta.recentPrices.shift();
      if (variant.earlyFailure) {
        const elapsed = riskManager.getDayHoldElapsed(meta).effectiveMinutes;
        const mfeR = (meta.peakPrice / entry - 1) / risk;
        if (elapsed >= variant.earlyFailure.sessionMinutes && mfeR < variant.earlyFailure.maxMfeR && bar.c < entry) {
          sell(1, bar.c); exitReason = "EARLY_FAILURE"; exitMs = barEnd; break;
        }
      }
      const decision = riskManager.decidePositionAction(meta, bar.c);
      if (decision.grantStaleGrace && !meta.staleGraceUsedAt) meta.staleGraceUsedAt = barEnd;
      if (decision.action === "PARTIAL" && !meta.partialDone) {
        sell(decision.fraction || config.partialExitFraction, bar.c);
        meta.partialDone = true; partials++;
      } else if (decision.action === "EXIT") {
        let price = bar.c;
        if (decision.reason === "MFE_GIVEBACK") {
          const floor = riskManager.computeMfeProtection(meta, meta.peakPrice).floor;
          if (floor != null) price = Math.min(floor, bar.h);
        } else if (decision.reason === "TRAILING_STOP") {
          price = Math.min(Math.max(meta.peakPrice * (1 - config.trailingStopPct), entry), bar.h);
        }
        sell(1, price); exitReason = decision.reason; exitMs = barEnd; break;
      }
    }
  } finally {
    Date.now = realNow;
  }
  if (!exitReason) {
    const last = bars[Math.min(index, bars.length - 1)];
    sell(1, last.c); exitReason = "HORIZON"; exitMs = last.t + last.dur;
  }
  if (remainingUnits() > 1e-9) sell(1, bars[Math.min(index, bars.length - 1)].c);
  const riskDollars = sizeDollars * risk;
  return {
    pnl: realizedDollars, r: realizedDollars / riskDollars, mfeR: (maxHigh / entry - 1) / risk,
    partials, adds, exitReason, holdHours: (exitMs - sample.entryMs) / HOUR, exitMs, sizeDollars,
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────
function summarize(results) {
  const n = results.length;
  if (!n) return null;
  const wins = results.filter((x) => x.pnl > 0);
  const losses = results.filter((x) => x.pnl <= 0);
  const grossWin = wins.reduce((s, x) => s + x.pnl, 0);
  const grossLoss = -losses.reduce((s, x) => s + x.pnl, 0);
  let equity = 0, peak = 0, maxDrawdown = 0;
  [...results].sort((a, b) => a.exitMs - b.exitMs).forEach((x) => {
    equity += x.pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
  });
  const avg = (list, key) => (list.length ? list.reduce((s, x) => s + x[key], 0) / list.length : 0);
  return {
    n, winRate: (wins.length / n) * 100, total: grossWin - grossLoss,
    avgWin: wins.length ? grossWin / wins.length : 0, avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity, avgR: avg(results, "r"),
    maxDrawdown, avgMfeR: avg(results, "mfeR"),
    avgGivebackR: wins.length ? wins.reduce((s, x) => s + (x.mfeR - x.r), 0) / wins.length : 0,
    partials: results.reduce((s, x) => s + x.partials, 0), adds: results.reduce((s, x) => s + x.adds, 0),
    avgHoldHours: avg(results, "holdHours"),
    dollarHours: results.reduce((s, x) => s + x.sizeDollars * x.holdHours, 0),
  };
}

function formatRow(label, s) {
  if (!s) return label.padEnd(34) + "  (no samples)";
  const money = (v) => (v >= 0 ? "+$" : "-$") + Math.abs(v).toFixed(0);
  return (
    label.padEnd(34) + String(s.n).padStart(5) + " " + s.winRate.toFixed(0).padStart(3) + "% " +
    money(s.total).padStart(8) + " avgW " + money(s.avgWin).padStart(5) + " avgL " + money(s.avgLoss).padStart(5) +
    " PF " + (s.profitFactor === Infinity ? " inf" : s.profitFactor.toFixed(2)) + " avgR " + s.avgR.toFixed(3).padStart(6) +
    " DD " + money(-s.maxDrawdown).padStart(6) + " MFE " + s.avgMfeR.toFixed(2) + " giveback " + s.avgGivebackR.toFixed(2) +
    " trims " + s.partials + " adds " + s.adds + " hold " + s.avgHoldHours.toFixed(1) + "h"
  );
}

function runVariant(name, variant, samples) {
  const saved = {};
  for (const [key, value] of Object.entries(variant.config || {})) { saved[key] = config[key]; config[key] = value; }
  try {
    return samples.map((sample) => ({ sample, result: simulate(sample, variant) })).filter((x) => x.result);
  } finally {
    for (const [key, value] of Object.entries(saved)) config[key] = value;
  }
}

if (require.main !== module) {
  module.exports = { simulate, summarize, loadBars, VARIANTS };
} else {
  const events = readJournal();
  const samples = [];
  if (["trades", "both", "all"].includes(SET)) samples.push(...tradeSamples(events));
  if (["extended", "both", "all"].includes(SET)) samples.push(...extendedSamples(events));
  if (["shadow", "all"].includes(SET)) samples.push(...shadowSamples(events));
  const splitMs = new Date(SPLIT + "T00:00:00Z").getTime();
  const wanted = argValue("--variants", Object.keys(VARIANTS).join(",")).split(",");
  console.log("samples: " + samples.length + " (split " + SPLIT + ", cost " + (COST * 10000) + " bps round trip)");
  const report = {};
  for (const name of wanted) {
    const variant = VARIANTS[name];
    if (!variant) { console.log("unknown variant " + name); continue; }
    const runs = runVariant(name, variant, samples);
    report[name] = {};
    console.log("\n=== " + name + " ===");
    for (const set of ["trades", "extended", "shadow"]) {
      for (const half of ["IS", "OOS"]) {
        const subset = runs.filter((x) => x.sample.set === set && (half === "IS" ? x.sample.entryMs < splitMs : x.sample.entryMs >= splitMs));
        if (!subset.length) continue;
        const summary = summarize(subset.map((x) => x.result));
        // Capital utilization only means something for the real trades,
        // which actually overlapped in one account.
        if (set === "trades") {
          const firstMs = Math.min(...subset.map((x) => x.sample.entryMs));
          const lastMs = Math.max(...subset.map((x) => x.result.exitMs));
          summary.utilizationPct = (summary.dollarHours / (config.dayTradeCapital * ((lastMs - firstMs) / HOUR))) * 100;
        }
        report[name][set + "_" + half] = summary;
        console.log(
          formatRow("  " + set + " " + half, summary) +
            (summary.utilizationPct != null ? " util " + summary.utilizationPct.toFixed(1) + "%" : ""),
        );
      }
    }
    if (name === "CURRENT") {
      const calibration = runs.filter((x) => x.sample.set === "trades" && Number.isFinite(x.sample.actualR));
      if (calibration.length) {
        const meanSim = calibration.reduce((s, x) => s + x.result.r, 0) / calibration.length;
        const meanActual = calibration.reduce((s, x) => s + x.sample.actualR, 0) / calibration.length;
        const sameSign = calibration.filter((x) => Math.sign(x.result.r) === Math.sign(x.sample.actualR)).length;
        console.log("  calibration vs live (" + calibration.length + " trades): mean sim R " + meanSim.toFixed(3) +
          " · mean actual R " + meanActual.toFixed(3) + " · same sign " + ((sameSign / calibration.length) * 100).toFixed(0) + "%");
      }
      const byReason = {};
      runs.filter((x) => x.sample.set === "trades").forEach((x) => (byReason[x.result.exitReason] = (byReason[x.result.exitReason] || 0) + 1));
      console.log("  sim exit mix (trades): " + JSON.stringify(byReason));
    }
  }
  if (argValue("--json", null)) fs.writeFileSync(argValue("--json"), JSON.stringify(report, null, 2));
  // --dump FILE [--dump-variant NAME]: per-sample results (entry features +
  // outcome) so entry rules can be studied on the same simulated outcomes.
  if (argValue("--dump", null)) {
    const dumpVariant = argValue("--dump-variant", "CURRENT");
    const runs = runVariant(dumpVariant, VARIANTS[dumpVariant], samples);
    fs.writeFileSync(argValue("--dump"), JSON.stringify(runs.map((x) => ({ ...x.sample, ...x.result, half: x.sample.entryMs < splitMs ? "IS" : "OOS" }))));
    console.log("\ndumped " + runs.length + " " + dumpVariant + " results to " + argValue("--dump"));
  }
}
