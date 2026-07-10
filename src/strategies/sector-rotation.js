// src/strategies/sector-rotation.js
//
// v5.5 NEW MODULE — SECTOR ROTATION SIGNAL (the "if oil is up, Chevron
// should follow" idea). Previously the bot scored every stock in
// isolation — no concept of "the sector this stock belongs to is
// currently strong/weak." This was explicitly flagged as a missing
// discovery signal in the original architecture review and never built.
//
// APPROACH: pull a liquid sector-ETF proxy's today's % change (via the
// SAME proven eToro batched-rates + cached-closing-price combo used for
// SPY and the watchlist — one extra batched call, reusing the already-
// cached closing-price map, essentially free). If a candidate's sector
// bucket has a proxy showing real strength, it gets a small SCORE BONUS —
// not a hard gate. This matches the bot's existing philosophy (relative
// strength vs SPY is a scoring tilt, not a binary veto) rather than
// adding another blunt all-or-nothing block.
//
// DELIBERATELY CONSERVATIVE: only sectors with a genuinely clean, liquid,
// well-known proxy ETF are mapped. AI/EV/space/social don't have a single
// uncontroversial proxy, so they're left unmapped rather than forcing a
// shaky, more-likely-wrong-than-helpful correlation.
//
// Fails open everywhere: any failure → {} (no bonuses applied that scan),
// never blocks trading.
require("dotenv").config();
const { logger } = require("../logger");
const config = require("../config");
const etoroMarketData = require("../data-sources/etoro-market-data");
const etoroClient = require("../etoro-client");

// bucket (matches sector-map.js's STATIC_BUCKETS values) → proxy ETF ticker
const SECTOR_PROXY_ETFS = {
  energy: "XLE", // Energy Select Sector SPDR
  semi: "SOXX", // iShares Semiconductor ETF
  financials: "XLF", // Financial Select Sector SPDR
  fintech: "XLF", // no dedicated fintech ETF liquid/clean enough; financials is the closest real proxy
  healthcare: "XLV", // Health Care Select Sector SPDR
  industrials: "XLI", // Industrial Select Sector SPDR
  consumer: "XLY", // Consumer Discretionary Select Sector SPDR
  // Deliberately NOT mapped: ai, ev, space, social, mega_cap, crypto —
  // no single liquid ETF cleanly represents these without real distortion.
};

let cachedProxyChanges = null;
let cachedAtMs = 0;
const CACHE_MS = 10 * 60 * 1000; // refresh roughly once per scan cycle

// Returns { bucket: changePercent } for every mapped sector, best-effort —
// a bucket is simply absent from the result if its proxy couldn't be
// resolved/quoted this scan (caller treats missing = no bonus, not an error).
async function getSectorProxyChanges() {
  const now = Date.now();
  if (cachedProxyChanges && now - cachedAtMs < CACHE_MS) {
    return cachedProxyChanges;
  }

  if (!etoroMarketData.isConfigured()) return {};

  try {
    const proxyTickers = [...new Set(Object.values(SECTOR_PROXY_ETFS))];
    const instrumentIdByTicker = {};
    for (const ticker of proxyTickers) {
      const instrumentId =
        await etoroClient.resolveTickerToInstrumentId(ticker);
      if (instrumentId) instrumentIdByTicker[ticker] = instrumentId;
    }

    const instrumentIds = Object.values(instrumentIdByTicker);
    if (instrumentIds.length === 0) return {};

    const [ratesByInstrumentId, closingPriceByInstrumentId] = await Promise.all(
      [
        etoroMarketData.fetchBatchedRates(instrumentIds),
        etoroMarketData.getClosingPriceMap(),
      ],
    );

    const changeByTicker = {};
    for (const [ticker, instrumentId] of Object.entries(instrumentIdByTicker)) {
      const rate = ratesByInstrumentId[instrumentId];
      const previousClose = closingPriceByInstrumentId[instrumentId]?.daily;
      if (!rate || !previousClose) continue;
      const currentPrice = (rate.ask + rate.bid) / 2;
      changeByTicker[ticker] =
        ((currentPrice - previousClose) / previousClose) * 100;
    }

    const changeByBucket = {};
    for (const [bucket, ticker] of Object.entries(SECTOR_PROXY_ETFS)) {
      if (changeByTicker[ticker] != null) {
        changeByBucket[bucket] = changeByTicker[ticker];
      }
    }

    cachedProxyChanges = changeByBucket;
    cachedAtMs = now;

    const strongBuckets = Object.entries(changeByBucket)
      .filter(
        ([, change]) => Math.abs(change) >= config.sectorRotationMinChangePct,
      )
      .map(
        ([bucket, change]) =>
          bucket + " " + (change >= 0 ? "+" : "") + change.toFixed(2) + "%",
      );
    if (strongBuckets.length > 0) {
      logger.info("🔄 Sector rotation: " + strongBuckets.join(", "));
    }

    return changeByBucket;
  } catch (fetchError) {
    logger.warn(
      "Sector rotation fetch failed (non-fatal): " + fetchError.message,
    );
    return {};
  }
}

module.exports = { getSectorProxyChanges, SECTOR_PROXY_ETFS };
