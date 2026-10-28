// src/data-sources/etoro-market-data.js
//
// v5.4 NEW MODULE — REAL ETORO MARKET DATA, PROVEN EMPIRICALLY.
//
// Everything in this file was verified against the live eToro API with
// real credentials before being built — not assumed from docs. Confirmed:
//   1. GET /market-data/instruments/rates — GENUINE batching (up to 100
//      instrumentIds, comma-separated, ONE call, confirmed 3-for-3 in
//      testing). Gives ask/bid/date — NOT gap or volume.
//   2. GET /market-data/instruments/{id}/history/candles/{dir}/{interval}/{count}
//      — real OHLCV including genuine, non-zero VOLUME, confirmed at
//      OneMinute/FiveMinutes/FifteenMinutes/OneHour/OneDay. Per-instrument
//      (not batchable — instrumentId is in the URL path).
//   3. GET /market-data/instruments/history/closing-price — confirmed
//      working, but its `instrumentIds` filter is UNDOCUMENTED and
//      appears to be ignored: it returns EVERY instrument on eToro
//      unfiltered. That's fine — fetch once, cache, look up locally.
//   4. Rate limit: 120 requests/60s, SHARED across 7 market-data endpoints
//      (this module, search, instruments, exchanges, instrument-types,
//      stocks-industries). We cap ourselves at 90/60s to leave headroom
//      for etoro-client.js's own resolveTickerToInstrumentId calls, which
//      share the same budget.
//
// WHY THIS REPLACES TWELVE DATA (not just supplements it): this gives us
// price, gap%, AND real volume — the one thing Alpaca/the WebSocket
// couldn't supply — all on your EXISTING eToro credentials. No new
// signup, no new KYC, no separate rate-limit budget to manage.
//
// FAILS OPEN: every function here can throw; market-data.js catches and
// falls back to Twelve Data automatically. This module never blocks
// trading on its own.
require("dotenv").config();
const axios = require("axios");
const { randomUUID } = require("crypto");
const { logger } = require("../logger");
const alerts = require("../notifications/alerts");

const ETORO_BASE_URL = "https://public-api.etoro.com/api/v1";

function headers() {
  return {
    "x-api-key": process.env.ETORO_PUBLIC_API_KEY,
    "x-user-key": process.env.ETORO_AGENT_USER_KEY,
    "x-request-id": randomUUID(),
    Accept: "application/json",
  };
}

function isConfigured() {
  return Boolean(
    process.env.ETORO_PUBLIC_API_KEY && process.env.ETORO_AGENT_USER_KEY,
  );
}

// ── Shared rate limiter (120/60s shared across 7 market-data endpoints —
// we self-limit to 90/60s to leave headroom for etoro-client.js's own
// instrument-search calls, which draw from the same pool) ─────────────────
const callTimestampsMs = [];
const SELF_IMPOSED_LIMIT = 90;
const WINDOW_MS = 60 * 1000;

async function waitForRateLimitSlot() {
  const now = Date.now();
  while (callTimestampsMs.length && now - callTimestampsMs[0] > WINDOW_MS) {
    callTimestampsMs.shift();
  }
  if (callTimestampsMs.length >= SELF_IMPOSED_LIMIT) {
    const oldestCallMs = callTimestampsMs[0];
    const waitMs = WINDOW_MS - (now - oldestCallMs) + 250;
    logger.warn(
      "eToro market-data: self-imposed rate limit reached, waiting " +
        (waitMs / 1000).toFixed(1) +
        "s",
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  callTimestampsMs.push(Date.now());
}

// ── 1. Batched rates (price only — NOT gap, NOT volume) ─────────────────────
// instrumentIds: array of numbers, max 100 per call (eToro's own limit).
// Returns { [instrumentId]: { ask, bid, date } }
async function fetchBatchedRates(instrumentIds) {
  if (!instrumentIds.length) return {};
  await waitForRateLimitSlot();

  const url =
    ETORO_BASE_URL +
    "/market-data/instruments/rates?instrumentIds=" +
    instrumentIds.join(",");
  // v10.2: one quick retry on a TIMEOUT only. Measured to 2026-10-26: 25
  // paper-book marks and 4 dip-entry checks were lost to a single 12s
  // timeout here, each costing a whole minute of dip coverage. A timeout
  // returned no data, so repeating the read is safe; any other error
  // (4xx, 429) is thrown as before.
  let response;
  try {
    response = await axios.get(url, { headers: headers(), timeout: 12000 });
  } catch (error) {
    const timedOut =
      error.code === "ECONNABORTED" || /timeout/i.test(error.message || "");
    if (!timedOut) throw error;
    logger.warn("eToro rates timed out — retrying once");
    await waitForRateLimitSlot();
    response = await axios.get(url, { headers: headers(), timeout: 12000 });
  }

  const ratesByInstrumentId = {};
  for (const rate of response.data?.rates || []) {
    ratesByInstrumentId[rate.instrumentID] = {
      ask: rate.ask,
      bid: rate.bid,
      date: rate.date,
    };
  }
  return ratesByInstrumentId;
}

// ── 2. Closing prices — ALL instruments, unfiltered, cached ────────────────
// The instrumentIds query param is undocumented and appears to be ignored
// by eToro's own API — every call returns the full instrument universe
// regardless of what's requested. So we fetch it ONCE per cache window and
// look symbols up locally afterward; this is still just 1 API call no
// matter how large your watchlist grows.
let closingPriceCacheByInstrumentId = null;
let closingPriceCacheAtMs = 0;
const CLOSING_PRICE_CACHE_MS = 6 * 60 * 60 * 1000; // 6h — previous close doesn't change intraday

async function getClosingPriceMap() {
  const now = Date.now();
  if (
    closingPriceCacheByInstrumentId &&
    now - closingPriceCacheAtMs < CLOSING_PRICE_CACHE_MS
  ) {
    return closingPriceCacheByInstrumentId;
  }

  await waitForRateLimitSlot();
  const url = ETORO_BASE_URL + "/market-data/instruments/history/closing-price";
  const response = await axios.get(url, { headers: headers(), timeout: 15000 });

  const entries = Array.isArray(response.data) ? response.data : [];
  const mapByInstrumentId = {};
  for (const entry of entries) {
    mapByInstrumentId[entry.instrumentId] = {
      officialClosingPrice: entry.officialClosingPrice,
      daily: entry.closingPrices?.daily?.price ?? null,
      weekly: entry.closingPrices?.weekly?.price ?? null,
      monthly: entry.closingPrices?.monthly?.price ?? null,
    };
  }

  closingPriceCacheByInstrumentId = mapByInstrumentId;
  closingPriceCacheAtMs = now;
  logger.info(
    "eToro closing-price cache refreshed: " +
      entries.length +
      " instruments (next refresh in 6h)",
  );
  return mapByInstrumentId;
}

// ── 3. Candles (real OHLCV, per-instrument) ─────────────────────────────────
// interval must be one of: OneMinute, FiveMinutes, TenMinutes,
// FifteenMinutes, ThirtyMinutes, OneHour, FourHours, OneDay, OneWeek
// Returns an array of { fromDate, open, high, low, close, volume },
// NEWEST FIRST (matches "desc" direction).
async function fetchCandles(instrumentId, interval, count) {
  await waitForRateLimitSlot();
  const url =
    ETORO_BASE_URL +
    "/market-data/instruments/" +
    instrumentId +
    "/history/candles/desc/" +
    interval +
    "/" +
    count;
  const response = await axios.get(url, { headers: headers(), timeout: 15000 });
  return response.data?.candles?.[0]?.candles || [];
}

// ── Derived calculations (pure JS — no extra API calls) ─────────────────────

// RSI(14) from a CHRONOLOGICAL (oldest→newest) array of closes.
function computeRsi(chronologicalCloses, period) {
  const rsiPeriod = period || 14;
  if (chronologicalCloses.length < rsiPeriod + 1) return null;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= rsiPeriod; i++) {
    const change = chronologicalCloses[i] - chronologicalCloses[i - 1];
    if (change >= 0) gainSum += change;
    else lossSum += Math.abs(change);
  }
  let averageGain = gainSum / rsiPeriod;
  let averageLoss = lossSum / rsiPeriod;

  for (let i = rsiPeriod + 1; i < chronologicalCloses.length; i++) {
    const change = chronologicalCloses[i] - chronologicalCloses[i - 1];
    const gain = change >= 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    averageGain = (averageGain * (rsiPeriod - 1) + gain) / rsiPeriod;
    averageLoss = (averageLoss * (rsiPeriod - 1) + loss) / rsiPeriod;
  }

  if (averageLoss === 0) return 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

// VWAP + session high/low from a batch of same-session intraday candles
// (candles arrive newest-first from fetchCandles — this handles that).
function computeVwapAndRange(candlesNewestFirst) {
  if (!candlesNewestFirst.length) {
    return { vwap: null, high: null, low: null };
  }
  let cumulativeTypicalPriceVolume = 0;
  let cumulativeVolume = 0;
  let high = -Infinity;
  let low = Infinity;

  for (const candle of candlesNewestFirst) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativeTypicalPriceVolume += typicalPrice * (candle.volume || 0);
    cumulativeVolume += candle.volume || 0;
    if (candle.high > high) high = candle.high;
    if (candle.low < low) low = candle.low;
  }

  return {
    vwap:
      cumulativeVolume > 0
        ? cumulativeTypicalPriceVolume / cumulativeVolume
        : null,
    high: high === -Infinity ? null : high,
    low: low === Infinity ? null : low,
  };
}

// Daily ATR(14) as % of price, from DAILY candles (newest-first, need 15+).
function computeDailyAtrPercent(dailyCandlesNewestFirst) {
  if (dailyCandlesNewestFirst.length < 15) return null;
  const chronological = [...dailyCandlesNewestFirst].reverse();

  const trueRanges = [];
  for (let i = 1; i < chronological.length; i++) {
    const bar = chronological[i];
    const previousBar = chronological[i - 1];
    const trueRange = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousBar.close),
      Math.abs(bar.low - previousBar.close),
    );
    trueRanges.push(trueRange);
  }
  if (trueRanges.length < 14) return null;

  const lastFourteen = trueRanges.slice(-14);
  const averageTrueRange =
    lastFourteen.reduce((sum, value) => sum + value, 0) / lastFourteen.length;
  const latestClose = chronological[chronological.length - 1].close;
  if (!latestClose) return null;

  return Number(((averageTrueRange / latestClose) * 100).toFixed(2));
}

// Average daily volume from DAILY candles (excludes today's in-progress bar).
function computeAverageDailyVolume(dailyCandlesNewestFirst) {
  const excludingToday = dailyCandlesNewestFirst.slice(1); // index 0 = today
  if (!excludingToday.length) return null;
  const totalVolume = excludingToday.reduce(
    (sum, candle) => sum + (candle.volume || 0),
    0,
  );
  return totalVolume / excludingToday.length;
}

module.exports = {
  isConfigured,
  fetchBatchedRates,
  getClosingPriceMap,
  fetchCandles,
  computeRsi,
  computeVwapAndRange,
  computeDailyAtrPercent,
  computeAverageDailyVolume,
};
