// src/shadow-strategies.js
//
// v10 (2026-10-22) — FOUR SHADOW STRATEGIES, EACH WITH ITS OWN PAPER BOOK.
//
// The live bot trades one idea: intraday momentum ("up today, will keep going
// for a few hours"). After 276 live trades and ~300 paper trades, every
// variant of that idea loses $1-6 per trade. This file runs four DIFFERENT
// ideas side by side, on paper, so they can be judged on live data without
// risking money or disturbing the live bot:
//
//   SWING_BREAKOUT  multi-day trend: close breaks above the 20-day high while
//                   the 50-day average is rising. Hold days to weeks.
//   DIP_IN_UPTREND  mean reversion: a stock above its 100-day average falls
//                   hard for 2-3 days (2-day RSI under 10). Hold 1-5 days.
//   EARNINGS_DRIFT  catalyst: the first session after an earnings report
//                   closes 3%+ higher, near its high, with EPS at or above
//                   estimate. Hold up to 20 days.
//   ROTATION        relative strength: hold the 5 strongest watchlist stocks
//                   over the last ~3 months (skipping the last week), checked
//                   weekly.
//
// ISOLATION — this is the point of the design:
//   - A SEPARATE PROCESS, run once a day by cron after the nightly candle
//     capture. A crash here cannot touch the live bot's process.
//   - READS ONLY data/replay-candles/ and watchlist-daytrade.json, plus the
//     Finnhub earnings calendar over the network.
//   - WRITES ONLY data/shadow-strategies/. Never position-meta.json, the
//     capital ledger, the decision journal, cooldowns or the v9.1 paper book.
//   - Places no orders and has no eToro trading code path at all.
// data/ is synced to GitHub (server-backup/) by the nightly server push.
//
// PRICES — two traps found while building it (2026-10-22):
//   1. The newest eToro OneDay bar is INCOMPLETE at capture time (AAPL's
//      showed volume 30,522), because eToro's "day" is a UTC day that starts
//      with overnight 24/5 trading. Signals use COMPLETED days only.
//   2. A OneDay bar's open is the 20:00 ET overnight price, the same thin
//      prices that flattered the v9.1 paper book by +$206. So every fill,
//      stop and exit uses REGULAR-SESSION prices (09:30-16:00 ET) rebuilt from
//      5-minute bars (from 2026-09-08), 15-minute bars, or hourly bars (from
//      2026-07-13; the 09:00 ET hourly bar is included, so a backtest before
//      September carries 30 minutes of pre-market in its open/high/low).
//
// TIMING, no look-ahead: a signal is computed from data up to and including
// session E, and is filled at the OPEN of the next session. Stops are checked
// against each session's low (a gap through the stop fills at the open, not
// at the stop); trailing levels use only bars from BEFORE the session being
// checked. Costs: 10 bps round trip.
//
// SIZING, comparable with the live bot: each book is a fixed $10,000; a
// stop-based trade risks 0.5% ($50) to its stop, capped at 35% of the book;
// at most 7 open positions. ROTATION has no stop and holds 5 x $2,000.
//
//   node src/shadow-strategies.js                    forward run (cron)
//   node src/shadow-strategies.js --backtest 2026-07-14 [2026-10-21]
//        historical run into data/shadow-strategies/_backtest/, for a first
//        read only — it never touches the forward books.
"use strict";
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CANDLE_DIR = path.join(ROOT, "data", "replay-candles");
const WATCHLIST_FILE = path.join(ROOT, "watchlist-daytrade.json");
const LIVE_OUT_DIR = path.join(ROOT, "data", "shadow-strategies");

const BOOK_CAPITAL = 10000;
const RISK_PCT = 0.005;
const MAX_POSITION_PCT = 0.35;
const MAX_POSITIONS = 7;
const COST_PCT = 0.001; // round trip
const ROTATION_SLOTS = 5;
const ROTATION_SIZE = 2000;

// ── small maths ───────────────────────────────────────────────────────────
const sma = (values, n) => {
  if (values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
};
function rsi(values, n) {
  if (values.length < n + 1) return null;
  // Wilder smoothing over the whole series so the value is stable.
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}
function atr(bars, n) {
  if (bars.length < n + 1) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i];
    const prevC = bars[i - 1].c;
    sum += Math.max(b.h - b.l, Math.abs(b.h - prevC), Math.abs(b.l - prevC));
  }
  return sum / n;
}
const round = (v, d = 2) => Number(Number(v).toFixed(d));

// ── time ─────────────────────────────────────────────────────────────────
const ET = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const etHourCache = new Map();
function etParts(ms) {
  // ET offsets are whole hours, so one Intl call per UTC hour is enough.
  const hourKey = Math.floor(ms / 3600000);
  let base = etHourCache.get(hourKey);
  if (!base) {
    const p = ET.formatToParts(new Date(hourKey * 3600000));
    const g = (t) => p.find((x) => x.type === t).value;
    base = { date: g("year") + "-" + g("month") + "-" + g("day"), minute: (Number(g("hour")) % 24) * 60 };
    etHourCache.set(hourKey, base);
  }
  return { date: base.date, minute: base.minute + Math.floor((ms % 3600000) / 60000) };
}
const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
function isoWeek(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return d.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

// ── data ─────────────────────────────────────────────────────────────────
// Regular-session OHLC for one ET date from the finest bars available.
function buildSessions(file) {
  const out = new Map();
  const add = (bars, startMin, endMin, label) => {
    const byDate = new Map();
    for (const b of bars || []) {
      const { date, minute } = etParts(b.t);
      if (minute < startMin || minute >= endMin) continue;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(b);
    }
    for (const [date, list] of byDate) {
      if (out.has(date) || list.length < 3) continue;
      list.sort((a, b) => a.t - b.t);
      out.set(date, {
        o: list[0].o,
        h: Math.max(...list.map((b) => b.h)),
        l: Math.min(...list.map((b) => b.l)),
        c: list[list.length - 1].c,
        source: label,
      });
    }
  };
  add(file.FiveMinutes, 570, 960, "5m");
  add(file.FifteenMinutes, 570, 960, "15m");
  add(file.OneHour, 540, 960, "1h");
  return out;
}

function loadUniverse() {
  const symbols = JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf8")).stocks.map((s) => String(s.symbol).toUpperCase());
  const data = {};
  for (const symbol of symbols) {
    const f = path.join(CANDLE_DIR, symbol + ".json");
    if (!fs.existsSync(f)) continue;
    let file;
    try { file = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    const daily = (file.OneDay || [])
      .map((b) => ({ date: utcDate(b.t), t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))
      .sort((a, b) => a.t - b.t);
    data[symbol] = { daily, sessions: buildSessions(file) };
  }
  return data;
}

// Session dates that most of the universe traded (drops half-loaded days).
function sessionCalendar(universe) {
  const count = new Map();
  for (const s of Object.values(universe)) for (const d of s.sessions.keys()) count.set(d, (count.get(d) || 0) + 1);
  const need = Math.max(10, Math.floor(Object.keys(universe).length * 0.5));
  return [...count.entries()].filter(([, n]) => n >= need).map(([d]) => d).sort();
}

// Daily bars COMPLETED by the end of session `date` (date <= session date),
// with the last close replaced by the regular-session close of `date` so
// signals are judged on the 16:00 ET close, not the 20:00 ET after-hours one.
function view(universe, symbol, date) {
  const s = universe[symbol];
  if (!s) return null;
  const bars = s.daily.filter((b) => b.date <= date);
  if (!bars.length) return null;
  const sess = s.sessions.get(date);
  const last = bars[bars.length - 1];
  if (sess && last.date === date) {
    bars[bars.length - 1] = { ...last, c: sess.c, h: Math.max(last.h, sess.h), l: Math.min(last.l, sess.l) };
  }
  return { bars, closes: bars.map((b) => b.c), session: sess || null, dayIsComplete: last.date === date };
}

// ── earnings (Finnhub, forward only: the free tier keeps ~1 month of history)
async function fetchEarnings(fromDate, toDate, symbols) {
  if (!process.env.FINNHUB_API_KEY) return { ok: false, rows: [] };
  try {
    const axios = require("axios");
    const r = await axios.get("https://finnhub.io/api/v1/calendar/earnings", {
      params: { from: fromDate, to: toDate, token: process.env.FINNHUB_API_KEY },
      timeout: 20000,
    });
    const set = new Set(symbols);
    return { ok: true, rows: (r.data.earningsCalendar || []).filter((e) => set.has(String(e.symbol).toUpperCase())) };
  } catch (e) {
    return { ok: false, rows: [], error: e.message };
  }
}

// ── the four strategies ──────────────────────────────────────────────────
// scan(date, ctx) -> [{symbol, rank, reason, atr, stopAtr, stopAbove?}]
// The stop is set at the fill: min(stopAbove, entry - stopAtr x ATR). Kept as
// plain numbers so a waiting entry survives being saved overnight.
// manage(pos, date, ctx) -> {exit, price, reason} | {stop} | null
const STRATEGIES = {
  SWING_BREAKOUT: {
    label: "Swing breakout",
    emoji: "📈",
    idea: "close above the 20-day high, 50-day average rising; hold days to weeks",
    maxPositions: MAX_POSITIONS,
    maxHoldSessions: 20,
    scan(date, ctx) {
      const out = [];
      for (const symbol of ctx.symbols) {
        const v = view(ctx.universe, symbol, date);
        if (!v || !v.session || !v.dayIsComplete || v.bars.length < 61) continue;
        const c = v.closes[v.closes.length - 1];
        const prior = v.bars.slice(-21, -1);
        const high20 = Math.max(...prior.map((b) => b.h));
        const sma50 = sma(v.closes, 50);
        const sma50Before = sma(v.closes.slice(0, -10), 50);
        const a = atr(v.bars, 14);
        if (!(c > high20 && c > sma50 && sma50 > sma50Before && a > 0)) continue;
        out.push({
          symbol,
          rank: (c / high20 - 1) / (a / c),
          reason: "closed $" + round(c) + " above the 20-day high $" + round(high20) + "; 50-day average rising",
          atr: a,
          stopAtr: 2,
        });
      }
      return out;
    },
    manage(pos, date, ctx) {
      // Trail to the lowest low of the 10 completed days BEFORE this session.
      const v = view(ctx.universe, pos.symbol, ctx.prevSession(date));
      if (v && v.bars.length >= 10) {
        const low10 = Math.min(...v.bars.slice(-10).map((b) => b.l));
        if (low10 > pos.stop) return { stop: low10, stopKind: "10-day low" };
      }
      return null;
    },
  },

  DIP_IN_UPTREND: {
    label: "Dip in uptrend",
    emoji: "🔁",
    idea: "above the 100-day average, 2-day RSI under 10; sell on the first close above the 5-day average",
    maxPositions: MAX_POSITIONS,
    maxHoldSessions: 5,
    scan(date, ctx) {
      const out = [];
      for (const symbol of ctx.symbols) {
        const v = view(ctx.universe, symbol, date);
        if (!v || !v.session || !v.dayIsComplete || v.bars.length < 101) continue;
        const c = v.closes[v.closes.length - 1];
        const sma100 = sma(v.closes, 100);
        const r2 = rsi(v.closes.slice(-30), 2);
        const a = atr(v.bars, 14);
        if (!(c > sma100 && r2 != null && r2 < 10 && a > 0)) continue;
        out.push({
          symbol,
          rank: 10 - r2,
          reason: "2-day RSI " + round(r2, 1) + " while above the 100-day average $" + round(sma100),
          atr: a,
          // a wide safety stop; the strategy's normal exit is the close rule
          stopAtr: 3,
        });
      }
      return out;
    },
    manage(pos, date, ctx) {
      const s = ctx.universe[pos.symbol].sessions.get(date);
      const v = view(ctx.universe, pos.symbol, ctx.prevSession(date));
      if (!s || !v || v.closes.length < 4) return null;
      const sma5 = (v.closes.slice(-4).reduce((a, b) => a + b, 0) + s.c) / 5;
      if (s.c > sma5) return { exit: true, price: s.c, reason: "CLOSE_ABOVE_5DAY_AVG" };
      return null;
    },
  },

  EARNINGS_DRIFT: {
    label: "Earnings drift",
    emoji: "📰",
    idea: "first session after earnings closes 3%+ up, near its high, EPS at or above estimate; hold up to 20 days",
    maxPositions: MAX_POSITIONS,
    maxHoldSessions: 20,
    scan(date, ctx) {
      const out = [];
      if (!ctx.earnings) return out;
      for (const e of ctx.earnings) {
        const symbol = String(e.symbol).toUpperCase();
        const s = ctx.universe[symbol];
        if (!s) continue;
        // Reaction session: the report's own day if before the open,
        // otherwise (after the close, or time unknown) the next session.
        const reaction = e.hour === "bmo" ? (s.sessions.has(e.date) ? e.date : ctx.nextSessionOnOrAfter(e.date)) : ctx.nextSessionAfter(e.date);
        if (reaction !== date) continue;
        const sess = s.sessions.get(date);
        const prev = s.sessions.get(ctx.prevSession(date));
        const v = view(ctx.universe, symbol, date);
        if (!sess || !prev || !v) continue;
        const move = sess.c / prev.c - 1;
        const location = sess.h > sess.l ? (sess.c - sess.l) / (sess.h - sess.l) : 0;
        const beat = e.epsActual == null || e.epsEstimate == null || e.epsActual >= e.epsEstimate;
        const a = atr(v.bars, 14);
        if (!(move >= 0.03 && location >= 0.5 && beat && a > 0)) continue;
        out.push({
          symbol,
          rank: move,
          reason: "earnings " + e.date + " (" + (e.hour || "time n/a") + "): +" + round(move * 100) + "% on the reaction day" +
            (e.epsActual != null ? ", EPS " + e.epsActual + " vs " + e.epsEstimate : ""),
          atr: a,
          // gap failure = below the reaction day's low, but never tighter than 1 ATR
          stopAtr: 1,
          stopAbove: sess.l,
        });
      }
      return out;
    },
    manage() {
      return null;
    },
  },

  ROTATION: {
    label: "Rotation (top 5)",
    emoji: "🏆",
    idea: "hold the 5 strongest stocks of the last ~3 months (skip the last week); re-ranked weekly",
    maxPositions: ROTATION_SLOTS,
    maxHoldSessions: null,
    // Rotation does not use scan/manage; see rebalanceRotation().
    scan() { return []; },
    manage() { return null; },
  },
};

function rotationRanking(date, ctx) {
  const ranked = [];
  for (const symbol of ctx.symbols) {
    const v = view(ctx.universe, symbol, date);
    if (!v || !v.session || !v.dayIsComplete || v.closes.length < 69) continue;
    const n = v.closes.length;
    const c = v.closes[n - 1];
    const ret = v.closes[n - 1 - 5] / v.closes[n - 1 - 68] - 1;
    if (!(c > sma(v.closes, 50))) continue;
    ranked.push({ symbol, ret });
  }
  return ranked.sort((a, b) => b.ret - a.ret);
}

// ── the book ─────────────────────────────────────────────────────────────
function emptyState(name) {
  return {
    book: name, createdAt: new Date().toISOString(), lastProcessedSession: null, lastRebalanceWeek: null,
    open: {}, pending: [], pendingExits: {}, closed: [], marks: [],
  };
}

function sizeFor(entry, stop) {
  if (!(stop > 0) || stop >= entry) return null;
  const stopPct = (entry - stop) / entry;
  return round(Math.min((BOOK_CAPITAL * RISK_PCT) / stopPct, BOOK_CAPITAL * MAX_POSITION_PCT));
}

function closePosition(state, pos, date, price, reason, log) {
  const grossPct = price / pos.entry - 1;
  const pnl = round(grossPct * pos.size - pos.size * COST_PCT);
  const trade = {
    symbol: pos.symbol, entryDate: pos.entryDate, entry: pos.entry, exitDate: date, exit: round(price, 4),
    reason, size: pos.size, pnl, pnlPct: round(grossPct * 100), heldSessions: pos.heldSessions,
    peakPct: round((pos.peak / pos.entry - 1) * 100), troughPct: round((pos.trough / pos.entry - 1) * 100),
    riskDollars: pos.riskDollars || null, r: pos.riskDollars ? round(pnl / pos.riskDollars) : null, signal: pos.signal,
  };
  state.closed.push(trade);
  delete state.open[pos.symbol];
  log({ event: "EXIT", ...trade });
}

// Process one session for one book. Order inside a session: queued exits at
// the open -> queued entries at the open -> stops against the session low ->
// strategy close rules and time stops at the close -> mark -> new signals.
function processSession(name, state, date, ctx, log) {
  const strat = STRATEGIES[name];
  const sess = (symbol) => ctx.universe[symbol] && ctx.universe[symbol].sessions.get(date);

  // 1. exits queued at the last rebalance (rotation) fill at this open
  for (const [symbol, reason] of Object.entries(state.pendingExits || {})) {
    const pos = state.open[symbol];
    const s = sess(symbol);
    if (pos && s) closePosition(state, pos, date, s.o, reason, log);
    if (!pos || s) delete state.pendingExits[symbol];
  }

  // 2. entries queued by the last session's signals fill at this open
  const queued = state.pending || [];
  state.pending = [];
  for (const p of queued) {
    const s = sess(p.symbol);
    if (!s) { log({ event: "ENTRY_SKIPPED", symbol: p.symbol, date, why: "no session prices" }); continue; }
    if (state.open[p.symbol]) continue;
    const entry = s.o;
    let stop = null;
    let size;
    if (name === "ROTATION") {
      size = ROTATION_SIZE;
    } else {
      stop = Math.min(p.stopAbove != null ? p.stopAbove : Infinity, entry - (p.stopAtr || 2) * p.atr);
      size = sizeFor(entry, stop);
      if (!size) { log({ event: "ENTRY_SKIPPED", symbol: p.symbol, date, why: "opened at or below its stop", entry, stop }); continue; }
    }
    state.open[p.symbol] = {
      symbol: p.symbol, entryDate: date, entry, stop: stop != null ? round(stop, 4) : null, stopKind: stop != null ? "initial" : null,
      size, riskDollars: stop != null ? round(size * (entry - stop) / entry) : null,
      peak: entry, trough: entry, heldSessions: 0, signal: p.reason, signalDate: p.signalDate,
    };
    log({ event: "ENTRY", book: name, symbol: p.symbol, date, entry, stop, size, signal: p.reason });
  }

  // 3. manage open positions through this session
  for (const pos of Object.values(state.open)) {
    const s = sess(pos.symbol);
    if (!s) continue;
    pos.heldSessions += 1;
    if (pos.entryDate !== date) {
      const m = name === "SWING_BREAKOUT" ? strat.manage(pos, date, ctx) : null;
      if (m && m.stop) { pos.stop = round(m.stop, 4); pos.stopKind = m.stopKind; }
    }
    pos.peak = Math.max(pos.peak, s.h);
    pos.trough = Math.min(pos.trough, s.l);
    if (pos.stop != null && s.l <= pos.stop) {
      // a gap through the stop fills at the open, not at the stop
      closePosition(state, pos, date, s.o <= pos.stop ? s.o : pos.stop, pos.stopKind === "initial" ? "STOP" : "TRAIL_STOP", log);
      continue;
    }
    if (name === "DIP_IN_UPTREND") {
      const m = strat.manage(pos, date, ctx);
      if (m && m.exit) { closePosition(state, pos, date, m.price, m.reason, log); continue; }
    }
    if (strat.maxHoldSessions && pos.heldSessions >= strat.maxHoldSessions) {
      closePosition(state, pos, date, s.c, "TIME_STOP", log);
      continue;
    }
    pos.lastClose = s.c;
    pos.lastDate = date;
  }

  // 4. mark the book at this close
  const unrealized = Object.values(state.open).reduce((sum, p) => {
    const s = sess(p.symbol);
    const c = s ? s.c : p.lastClose || p.entry;
    return sum + (c / p.entry - 1) * p.size;
  }, 0);
  const realized = state.closed.reduce((sum, t) => sum + t.pnl, 0);
  state.marks.push({ date, realized: round(realized), unrealized: round(unrealized), open: Object.keys(state.open).length });
  if (state.marks.length > 400) state.marks = state.marks.slice(-400);

  // 5. new signals from this session -> filled at the next session's open
  if (name === "ROTATION") {
    const week = isoWeek(date);
    if (week !== state.lastRebalanceWeek) {
      state.lastRebalanceWeek = week;
      const ranked = rotationRanking(date, ctx);
      const rankOf = new Map(ranked.map((r, i) => [r.symbol, i + 1]));
      let keep = 0;
      for (const symbol of Object.keys(state.open)) {
        const rk = rankOf.get(symbol);
        if (!rk || rk > 10) {
          state.pendingExits[symbol] = rk ? "ROTATED_OUT (rank " + rk + ")" : "ROTATED_OUT (lost its trend)";
        } else keep++;
      }
      for (const r of ranked.slice(0, ROTATION_SLOTS)) {
        if (keep >= ROTATION_SLOTS) break;
        if (state.open[r.symbol] && !state.pendingExits[r.symbol]) continue;
        state.pending.push({ symbol: r.symbol, reason: "rank " + rankOf.get(r.symbol) + ", 3-month return +" + round(r.ret * 100) + "%", signalDate: date });
        keep++;
      }
      log({ event: "REBALANCE", date, week, top10: ranked.slice(0, 10).map((r) => r.symbol + " " + round(r.ret * 100) + "%") });
    }
    return;
  }
  const busy = new Set([...Object.keys(state.open), ...state.pending.map((p) => p.symbol)]);
  const free = strat.maxPositions - busy.size;
  const signals = strat.scan(date, ctx).filter((s) => !busy.has(s.symbol)).sort((a, b) => b.rank - a.rank);
  signals.forEach((sig, i) => {
    const take = i < free;
    log({ event: take ? "SIGNAL" : "SIGNAL_NO_SLOT", book: name, date, symbol: sig.symbol, reason: sig.reason, rank: round(sig.rank, 3) });
    if (take) state.pending.push({ symbol: sig.symbol, reason: sig.reason, atr: sig.atr, stopAtr: sig.stopAtr, stopAbove: sig.stopAbove != null ? sig.stopAbove : null, signalDate: date });
  });
}


function summarise(state) {
  const closed = state.closed;
  const n = closed.length;
  const pnl = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter((t) => t.pnl > 0).length;
  const last = state.marks[state.marks.length - 1];
  return {
    closed: n, wins, winRate: n ? Math.round((100 * wins) / n) : null, realized: round(pnl),
    perTrade: n ? round(pnl / n) : null, open: Object.keys(state.open).length,
    openSymbols: Object.keys(state.open), unrealized: last ? last.unrealized : 0,
    lastSession: state.lastProcessedSession,
  };
}

// ── runner ───────────────────────────────────────────────────────────────
async function run({ outDir, from = null, to = null, backtest = false }) {
  fs.mkdirSync(outDir, { recursive: true });
  const universe = loadUniverse();
  const symbols = Object.keys(universe);
  const calendar = sessionCalendar(universe);
  const todayUtc = utcDate(Date.now());
  // A session is COMPLETE once its UTC day has ended (its OneDay bar too).
  const complete = calendar.filter((d) => d < todayUtc && (!to || d <= to));
  const idx = new Map(calendar.map((d, i) => [d, i]));
  const ctx = {
    universe, symbols,
    prevSession: (d) => calendar[Math.max(0, (idx.get(d) ?? calendar.findIndex((x) => x >= d)) - 1)],
    nextSessionAfter: (d) => calendar.find((x) => x > d) || null,
    nextSessionOnOrAfter: (d) => calendar.find((x) => x >= d) || null,
    earnings: null,
  };

  // Earnings: forward runs look back far enough to cover any missed days.
  let earningsNote = "not used in backtests (Finnhub keeps ~1 month of history)";
  if (!backtest) {
    const fromE = new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10);
    const res = await fetchEarnings(fromE, todayUtc, symbols);
    ctx.earnings = res.ok ? res.rows : null;
    earningsNote = res.ok ? res.rows.length + " watchlist reports since " + fromE : "Finnhub unavailable: " + (res.error || "no key");
    fs.writeFileSync(path.join(outDir, "earnings-cache.json"), JSON.stringify({ at: new Date().toISOString(), note: earningsNote, rows: res.rows }, null, 1));
  }

  const summary = {};
  for (const name of Object.keys(STRATEGIES)) {
    const dir = path.join(outDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const statePath = path.join(dir, "state.json");
    let state = !backtest && fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : emptyState(name);
    state.pending = state.pending || [];
    state.pendingExits = state.pendingExits || {};

    let todo;
    if (backtest) todo = complete.filter((d) => d >= from);
    else if (!state.lastProcessedSession) todo = complete.slice(-1); // first run: signals only
    else todo = complete.filter((d) => d > state.lastProcessedSession);

    const events = [];
    const log = (e) => events.push({ ts: new Date().toISOString(), book: name, ...e });
    for (const date of todo) {
      processSession(name, state, date, ctx, log);
      state.lastProcessedSession = date;
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
    if (events.length) {
      const month = (todo[todo.length - 1] || todayUtc).slice(0, 7);
      fs.appendFileSync(path.join(dir, "events-" + month + ".jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
    summary[name] = { ...summarise(state), sessionsProcessed: todo.length, signalsToday: events.filter((e) => e.event === "SIGNAL").length };
  }

  const status = {
    at: new Date().toISOString(), mode: backtest ? "backtest" : "forward", from, to,
    latestCompleteSession: complete[complete.length - 1] || null, universe: symbols.length, earnings: earningsNote, books: summary,
  };
  fs.writeFileSync(path.join(outDir, "last-run.json"), JSON.stringify(status, null, 1));
  return status;
}

module.exports = {
  STRATEGIES, run, sma, rsi, atr, isoWeek, buildSessions, view, sizeFor, processSession, emptyState, etParts, sessionCalendar,
  LIVE_OUT_DIR,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const bi = args.indexOf("--backtest");
  const backtest = bi !== -1;
  const from = backtest ? args[bi + 1] : null;
  const to = backtest ? args[bi + 2] || null : null;
  const outDir = backtest ? path.join(LIVE_OUT_DIR, "_backtest") : LIVE_OUT_DIR;
  run({ outDir, from, to, backtest })
    .then((s) => {
      console.log("[" + s.at + "] shadow strategies " + s.mode + " · latest session " + s.latestCompleteSession + " · earnings: " + s.earnings);
      for (const [name, b] of Object.entries(s.books)) {
        console.log("  " + name.padEnd(15) + " sessions " + b.sessionsProcessed + " · closed " + b.closed + " (" + (b.winRate ?? "-") + "% win) · realized " +
          b.realized + " · per trade " + (b.perTrade ?? "-") + " · open " + b.open + " (" + b.openSymbols.join(",") + ") unrealized " + b.unrealized);
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error("shadow strategies failed: " + (e && e.stack ? e.stack : e));
      process.exit(1);
    });
}
