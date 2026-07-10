// src/market-data-stream.js
//
// v5.3 NEW MODULE — ALPACA WEBSOCKET STREAMING (P2.9 from the review).
//
// THE PROBLEM THIS SOLVES: fetchIntradayQuotes() in market-data.js fetches
// each watchlist symbol SEQUENTIALLY from Twelve Data, spaced 8 seconds
// apart (free-tier rate limit). For a 19-symbol watchlist that's ~2.5
// minutes of a 10-minute scan spent just waiting on quotes, before
// enrichment or discovery even starts — and it's the reason watchlist
// symbols occasionally 429 if anything else touches the same key in the
// same minute.
//
// THE FIX: Alpaca's free "Basic" market data plan (real-time IEX feed, NOT
// metered per-symbol, WebSocket streaming) — https://app.alpaca.markets.
// This module keeps ONE persistent WebSocket connection open, subscribed
// to minute bars for the whole watchlist + SPY + anything discovery adds
// mid-scan. Quotes are read from an in-memory cache that's updated
// continuously in the background — reading it costs ZERO time and ZERO
// API credits, no matter how many symbols are subscribed.
//
// OPTIONAL, FAILS OPEN: if ALPACA_API_KEY_ID / ALPACA_SECRET_KEY aren't
// set, isConfigured() returns false and market-data.js's
// fetchIntradayQuotes() falls straight back to the original sequential
// Twelve Data path — nothing else changes, nothing breaks.
//
// SCOPE: this replaces ONLY the watchlist/discovery QUOTE fetch (price,
// day range, volume, gap %). It does NOT replace enrichCandidate()'s
// VWAP/RSI/recent-intraday-high (Twelve Data, cached 25 min — already
// cheap) or fetchDailyAtrPercent() (cached 20h — already cheap). Those
// weren't the latency bottleneck the review identified; the sequential
// per-symbol quote polling was.
require("dotenv").config();
const WebSocket = require("ws");
const axios = require("axios");
const { logger } = require("./logger");
const alerts = require("./notifications/alerts");

const ALPACA_KEY_ID = process.env.ALPACA_API_KEY_ID || "";
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || "";
const ALPACA_WS_URL = "wss://stream.data.alpaca.markets/v2/iex";
const ALPACA_REST_BASE_URL = "https://data.alpaca.markets/v2";

function isConfigured() {
  return ALPACA_KEY_ID.length > 0 && ALPACA_SECRET_KEY.length > 0;
}

// ── In-memory state ─────────────────────────────────────────────────────────
// { SYMBOL: { currentPrice, dayOpen, dayHigh, dayLow, previousClose,
//             averageVolume, cumulativeVolume, cumulativeTypicalPriceVolume,
//             lastBarAtMs } }
const liveDataBySymbol = {};
let subscribedSymbols = new Set();
let socket = null;
let isAuthenticated = false;
let reconnectAttempt = 0;
let intentionallyClosed = false;
let lastDataReceivedAtMs = 0;

// v5.3: alert if the stream goes quiet for too long WHILE the market is
// open — a silently-dead WebSocket is exactly the kind of failure this
// whole alerting system exists to catch.
const STREAM_STALE_ALERT_MS = 3 * 60 * 1000; // 3 min with zero messages

// ── REST: seed previousClose + averageVolume for newly subscribed symbols ──
// Alpaca's historical bars endpoint DOES support a comma-separated symbol
// list in one call (unlike Twelve Data's free tier) — so backfilling 19
// symbols' prior-day data costs ONE request, not 19.
async function backfillDailyContext(symbolList) {
  if (!symbolList.length) return;
  try {
    const response = await axios.get(ALPACA_REST_BASE_URL + "/stocks/bars", {
      params: {
        symbols: symbolList.join(","),
        timeframe: "1Day",
        limit: 21, // ~1 month of trading days → decent average-volume sample
        feed: "iex",
        adjustment: "raw",
      },
      headers: {
        "APCA-API-KEY-ID": ALPACA_KEY_ID,
        "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
      },
      timeout: 15000,
    });

    const barsBySymbol = response.data?.bars || {};
    for (const symbol of symbolList) {
      const dailyBars = barsBySymbol[symbol];
      if (!Array.isArray(dailyBars) || dailyBars.length < 2) continue;

      // Bars come back oldest-first for this endpoint.
      const priorDayBar = dailyBars[dailyBars.length - 2];
      const volumes = dailyBars.slice(0, -1).map((bar) => bar.v || 0); // exclude in-progress today
      const averageVolume =
        volumes.length > 0
          ? volumes.reduce((sum, v) => sum + v, 0) / volumes.length
          : null;

      liveDataBySymbol[symbol] = {
        ...liveDataBySymbol[symbol],
        previousClose: priorDayBar.c,
        averageVolume,
      };
    }
    logger.info(
      "📶 Alpaca: backfilled prior-close + avg volume for " +
        symbolList.length +
        " symbol(s) in 1 REST call",
    );
  } catch (fetchError) {
    logger.warn(
      "Alpaca daily-context backfill failed: " + fetchError.message,
    );
    // Non-fatal — gap%/volumeRatio just come back null for these symbols
    // until the next backfill cycle; the stream keeps running.
  }
}

// ── WebSocket lifecycle ──────────────────────────────────────────────────────
function handleIncomingMessages(rawMessage) {
  lastDataReceivedAtMs = Date.now();
  let messages;
  try {
    messages = JSON.parse(rawMessage);
  } catch {
    return;
  }
  if (!Array.isArray(messages)) messages = [messages];

  for (const message of messages) {
    if (message.T === "success" && message.msg === "authenticated") {
      isAuthenticated = true;
      logger.info("📶 Alpaca WebSocket authenticated");
      resubscribeAll();
      continue;
    }
    if (message.T === "error") {
      logger.warn("Alpaca WebSocket error message: " + JSON.stringify(message));
      continue;
    }
    if (message.T !== "b") continue; // only minute bars matter here

    const symbol = message.S;
    if (!symbol) continue;
    const existing = liveDataBySymbol[symbol] || {
      previousClose: null,
      averageVolume: null,
      dayOpen: null,
      dayHigh: -Infinity,
      dayLow: Infinity,
      cumulativeVolume: 0,
      cumulativeTypicalPriceVolume: 0,
      sessionDateEt: null,
    };

    const barDateEt = new Date(message.t).toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
    // New session → reset the day's running stats (keep previousClose/avgVol)
    if (existing.sessionDateEt !== barDateEt) {
      existing.dayOpen = message.o;
      existing.dayHigh = message.h;
      existing.dayLow = message.l;
      existing.cumulativeVolume = 0;
      existing.cumulativeTypicalPriceVolume = 0;
      existing.sessionDateEt = barDateEt;
    }

    existing.currentPrice = message.c;
    existing.dayHigh = Math.max(existing.dayHigh, message.h);
    existing.dayLow = Math.min(existing.dayLow, message.l);
    existing.cumulativeVolume += message.v || 0;
    const typicalPrice = (message.h + message.l + message.c) / 3;
    existing.cumulativeTypicalPriceVolume += typicalPrice * (message.v || 0);
    existing.lastBarAtMs = Date.now();

    liveDataBySymbol[symbol] = existing;
  }
}

function resubscribeAll() {
  if (!isAuthenticated || !socket || socket.readyState !== WebSocket.OPEN)
    return;
  if (subscribedSymbols.size === 0) return;
  socket.send(
    JSON.stringify({
      action: "subscribe",
      bars: Array.from(subscribedSymbols),
    }),
  );
  logger.info(
    "📶 Alpaca: (re)subscribed to " + subscribedSymbols.size + " symbol(s)",
  );
}

function connect() {
  if (!isConfigured()) return;
  intentionallyClosed = false;
  socket = new WebSocket(ALPACA_WS_URL);

  socket.on("open", () => {
    reconnectAttempt = 0;
    isAuthenticated = false;
    socket.send(
      JSON.stringify({
        action: "auth",
        key: ALPACA_KEY_ID,
        secret: ALPACA_SECRET_KEY,
      }),
    );
  });

  socket.on("message", handleIncomingMessages);

  socket.on("error", (socketError) => {
    logger.warn("Alpaca WebSocket error: " + socketError.message);
  });

  socket.on("close", () => {
    isAuthenticated = false;
    if (intentionallyClosed) return;
    reconnectAttempt++;
    const backoffMs = Math.min(30000, 2000 * reconnectAttempt);
    logger.warn(
      "Alpaca WebSocket closed — reconnecting in " +
        (backoffMs / 1000).toFixed(0) +
        "s (attempt " +
        reconnectAttempt +
        ")",
    );
    setTimeout(connect, backoffMs);
  });
}

// Call once at bot startup. No-op if not configured.
function start() {
  if (!isConfigured()) {
    logger.warn(
      "Alpaca: NOT configured (ALPACA_API_KEY_ID/ALPACA_SECRET_KEY missing). " +
        "Falling back to sequential Twelve Data polling for watchlist quotes. " +
        "Free key: https://app.alpaca.markets/signup",
    );
    return;
  }
  logger.info("📶 Alpaca WebSocket streaming: CONFIGURED — connecting...");
  connect();
}

// Call once at bot shutdown (not currently wired into a signal handler —
// the process is managed by PM2, which sends SIGTERM; add a handler in
// index.js if you want a clean disconnect on `pm2 stop`).
function stop() {
  intentionallyClosed = true;
  if (socket) socket.close();
}

// Ensure a given list of symbols is subscribed. Call this every scan with
// the CURRENT watchlist + discovery candidates + SPY — cheap no-op for
// symbols already subscribed; backfills daily context for any new ones.
async function ensureSubscribed(symbolList) {
  if (!isConfigured()) return;

  const upperSymbols = symbolList.map((s) => s.toUpperCase());
  const newSymbols = upperSymbols.filter((s) => !subscribedSymbols.has(s));
  if (newSymbols.length === 0) return;

  newSymbols.forEach((s) => subscribedSymbols.add(s));
  resubscribeAll();
  await backfillDailyContext(newSymbols);
}

// v5.3: called from the scan cycle to detect a silently-dead stream while
// the market is open — mirrors the alerting pattern used for every other
// data source in this bot.
function checkStreamHealth() {
  if (!isConfigured()) return;
  if (lastDataReceivedAtMs === 0) return; // hasn't had a chance to receive yet
  const staleDurationMs = Date.now() - lastDataReceivedAtMs;
  if (staleDurationMs > STREAM_STALE_ALERT_MS) {
    alerts.systemAlert(
      "ALPACA_STREAM",
      "The Alpaca WebSocket has received NO data for " +
        Math.round(staleDurationMs / 60000) +
        " min while the market should be open. Quotes are falling back to " +
        "Twelve Data automatically, but check the connection " +
        "(pm2 logs) — the stream may need a manual restart.",
    );
  }
}

// Build a quote object in the SAME SHAPE as market-data.js's Twelve-Data
// quotes, so callers (momentum-scanner, trade-planner, etc.) don't need to
// know which source they came from. Returns {} for any symbol with no bar
// data yet (e.g. just subscribed, first bar hasn't arrived) — caller
// should fall back to Twelve Data for those specific symbols if needed.
function getSnapshotQuotes(symbolList) {
  const quotesBySymbol = {};
  for (const rawSymbol of symbolList) {
    const symbol = rawSymbol.toUpperCase();
    const live = liveDataBySymbol[symbol];
    if (!live || live.currentPrice == null) continue;

    const previousClose = live.previousClose;
    const priceChangePercent = previousClose
      ? ((live.currentPrice - previousClose) / previousClose) * 100
      : 0;
    const gapPercent =
      live.dayOpen && previousClose
        ? ((live.dayOpen - previousClose) / previousClose) * 100
        : 0;
    const volumeRatio =
      live.averageVolume > 0
        ? live.cumulativeVolume / live.averageVolume
        : null;

    quotesBySymbol[symbol] = {
      symbol,
      currentPrice: live.currentPrice,
      previousClose: previousClose || null,
      dayOpen: live.dayOpen || null,
      dayHigh: live.dayHigh === -Infinity ? null : live.dayHigh,
      dayLow: live.dayLow === Infinity ? null : live.dayLow,
      volumeRatio,
      averageVolume: live.averageVolume || null,
      priceChangePercent,
      gapPercent,
      recentIntradayHigh: null, // still comes from enrichCandidate (Twelve Data)
      recentIntradayLow: null,
      vwap: null, // still comes from enrichCandidate (Twelve Data)
      rsi: null, // still comes from enrichCandidate (Twelve Data)
      source: "WATCHLIST",
      dataSource: "ALPACA_STREAM",
    };
  }
  return quotesBySymbol;
}

// Convenience: SPY in the same shape fetchSpyQuote() returns.
function getSpySnapshot() {
  const live = liveDataBySymbol["SPY"];
  if (!live || live.currentPrice == null) return null;
  const previousClose = live.previousClose;
  if (!previousClose) return null;
  return {
    changePercent: ((live.currentPrice - previousClose) / previousClose) * 100,
    high: live.dayHigh === -Infinity ? null : live.dayHigh,
    low: live.dayLow === Infinity ? null : live.dayLow,
    currentPrice: live.currentPrice,
  };
}

module.exports = {
  isConfigured,
  start,
  stop,
  ensureSubscribed,
  getSnapshotQuotes,
  getSpySnapshot,
  checkStreamHealth,
};
