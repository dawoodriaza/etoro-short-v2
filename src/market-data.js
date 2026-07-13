// src/market-data.js — INTRADAY focused (day-trade + swing bot)
//
// v5 (2026-07-04): FAILURE ALERTING.
//   - fetchSpyQuote(): SPY is fail-closed (null blocks ALL new entries) —
//     which is safe but silent. Now a null SPY fires a throttled Telegram
//     alert, and a successful fetch after a failure sends a recovery notice.
//   - fetchIntradayQuotes(): if a non-empty watchlist returns ZERO quotes,
//     Twelve Data is effectively down (or the key is dead) — alert.
//
// v4 features retained:
//   A. fetchDailyAtrPercent(symbol) — daily ATR(14) % of price, cached ~20h.
//   B. Change-based enrichment cache — skips re-enrichment when fresh and
//      price has barely moved.
// v3 fixes retained: sequential quotes (batch calls 429 on free tier),
// session-anchored VWAP, fail-closed SPY.
require("dotenv").config();
const axios = require("axios");
const { logger } = require("./logger");
const config = require("./config");
const alerts = require("./notifications/alerts");
const marketDataStream = require("./market-data-stream"); // v5.3: optional Alpaca stream
const etoroMarketData = require("./data-sources/etoro-market-data"); // v5.4: primary source
const etoroClient = require("./etoro-client"); // v5.4: for instrumentId resolution

const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY;

// Twelve Data free tier: 800 credits/day AND 8 credits/minute.
const PER_CALL_SPACING_MS = 8000;

// Daily quota tracking
let dailyCallCount = 0;
let quotaResetDate = new Date().toDateString();
function trackApiCall(label) {
  const today = new Date().toDateString();
  if (today !== quotaResetDate) {
    dailyCallCount = 0;
    quotaResetDate = today;
  }
  dailyCallCount++;
  if (dailyCallCount === 600 || dailyCallCount === 750) {
    logger.warn(
      "⚠️ Twelve Data usage: " + dailyCallCount + "/800 today (" + label + ")",
    );
  }
  return dailyCallCount;
}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function getTodayEasternDateString() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

// ── Single-symbol quote ─────────────────────────────────────────────────────
async function fetchSingleQuote(symbol) {
  trackApiCall("quote:" + symbol);
  try {
    const response = await axios.get("https://api.twelvedata.com/quote", {
      params: { symbol, apikey: TWELVE_DATA_KEY },
      timeout: 12000,
    });
    const quoteData = response.data;
    if (!quoteData) return null;
    if (quoteData.code === 429) {
      logger.warn("Twelve Data 429 on quote for " + symbol);
      return null;
    }
    if (quoteData.status === "error" || !quoteData.close) return null;

    const currentPrice = parseFloat(quoteData.close);
    const previousClose = parseFloat(quoteData.previous_close);
    const dayOpen = parseFloat(quoteData.open);
    const dayHigh = parseFloat(quoteData.high);
    const dayLow = parseFloat(quoteData.low);
    const volume = parseFloat(quoteData.volume);
    const averageVolume = parseFloat(quoteData.average_volume);

    return {
      symbol,
      currentPrice,
      previousClose: isNaN(previousClose) ? null : previousClose,
      dayOpen: isNaN(dayOpen) ? null : dayOpen,
      dayHigh: isNaN(dayHigh) ? null : dayHigh,
      dayLow: isNaN(dayLow) ? null : dayLow,
      volumeRatio:
        averageVolume > 0 && !isNaN(volume) ? volume / averageVolume : null,
      averageVolume: isNaN(averageVolume) ? null : averageVolume, // v5.1: for the liquidity/spread check
      priceChangePercent:
        previousClose && !isNaN(previousClose)
          ? ((currentPrice - previousClose) / previousClose) * 100
          : 0,
      recentIntradayHigh: null,
      recentIntradayLow: null,
      vwap: null,
      rsi: null,
      source: "WATCHLIST",
    };
  } catch (fetchError) {
    logger.warn("Quote fetch failed for " + symbol + ": " + fetchError.message);
    return null;
  }
}

// ── Sequential watchlist quotes (v5.3: Alpaca fast-path / v5.4: eToro primary) ─
// v5.4: eToro is now the PRIMARY source — proven via manual testing to give
// genuine batched rates (up to 100 instrumentIds, ONE call) plus a cached
// all-instruments closing-price lookup for gap%, all on credentials this
// bot already has for trading. No new signup, no separate rate budget.
// Falls back to Alpaca stream (if configured), then Twelve Data sequential,
// on ANY failure — this function never throws, it degrades.
async function fetchIntradayQuotesFromEtoro(symbolList) {
  const instrumentIdBySymbol = {};
  for (const rawSymbol of symbolList) {
    const symbol = rawSymbol.toUpperCase();
    const instrumentId = await etoroClient.resolveTickerToInstrumentId(symbol);
    if (instrumentId) instrumentIdBySymbol[symbol] = instrumentId;
  }
  const resolvedSymbols = Object.keys(instrumentIdBySymbol);
  if (resolvedSymbols.length === 0) return {};

  const instrumentIds = Object.values(instrumentIdBySymbol);
  const [ratesByInstrumentId, closingPriceByInstrumentId] = await Promise.all([
    etoroMarketData.fetchBatchedRates(instrumentIds),
    etoroMarketData.getClosingPriceMap(),
  ]);

  const quotesBySymbol = {};
  for (const symbol of resolvedSymbols) {
    const instrumentId = instrumentIdBySymbol[symbol];
    const rate = ratesByInstrumentId[instrumentId];
    if (!rate) continue;

    const previousClose = closingPriceByInstrumentId[instrumentId]?.daily ?? null;
    const currentPrice = (rate.ask + rate.bid) / 2; // mid price
    const priceChangePercent = previousClose
      ? ((currentPrice - previousClose) / previousClose) * 100
      : 0;

    quotesBySymbol[symbol] = {
      symbol,
      currentPrice,
      previousClose,
      dayOpen: null, // not available from rates/closing-price; candles cover this in enrichCandidate
      dayHigh: null,
      dayLow: null,
      volumeRatio: null, // v5.4: NOT available cheaply here — filled in by enrichCandidate via candles
      averageVolume: null,
      priceChangePercent,
      gapPercent: priceChangePercent, // no separate dayOpen yet, so gap ≈ change until enriched
      recentIntradayHigh: null,
      recentIntradayLow: null,
      vwap: null,
      rsi: null,
      source: "WATCHLIST",
      dataSource: "ETORO",
      instrumentId,
    };
  }
  return quotesBySymbol;
}

async function fetchIntradayQuotes(symbolList) {
  // v5.4: eToro first — proven, zero new signup, uses existing credentials.
  if (etoroMarketData.isConfigured()) {
    try {
      const etoroQuotes = await fetchIntradayQuotesFromEtoro(symbolList);
      const missingSymbols = symbolList.filter(
        (symbol) => !etoroQuotes[symbol.toUpperCase()] && !etoroQuotes[symbol],
      );
      if (missingSymbols.length === 0) {
        logger.info(
          "📶 Quotes: " +
            symbolList.length +
            "/" +
            symbolList.length +
            " from eToro (1 batched rates call + cached closing-price)",
        );
        await alerts.clearAlert(
          "ETORO_MARKET_DATA",
          "eToro market-data quotes are working again.",
        );
        return etoroQuotes;
      }
      logger.info(
        "📶 Quotes: " +
          (symbolList.length - missingSymbols.length) +
          "/" +
          symbolList.length +
          " from eToro · " +
          missingSymbols.length +
          " unresolved on eToro — falling back for just those",
      );
      const fallbackQuotes = await fetchIntradayQuotesFallback(missingSymbols);
      return { ...etoroQuotes, ...fallbackQuotes };
    } catch (etoroError) {
      logger.warn(
        "eToro market-data quote fetch failed, falling back: " +
          etoroError.message,
      );
      await alerts.systemAlert(
        "ETORO_MARKET_DATA",
        "eToro market-data (quotes) failed: " +
          etoroError.message +
          ". Falling back to " +
          (marketDataStream.isConfigured() ? "Alpaca stream" : "Twelve Data") +
          " for this scan.",
      );
      return fetchIntradayQuotesFallback(symbolList);
    }
  }
  return fetchIntradayQuotesFallback(symbolList);
}

// v5.3/v5.4: the OLD primary path (Alpaca stream, else Twelve Data
// sequential) — now the FALLBACK chain, used only if eToro isn't
// configured or a call to it fails.
async function fetchIntradayQuotesFallback(symbolList) {
  if (marketDataStream.isConfigured()) {
    await marketDataStream.ensureSubscribed(symbolList);
    const streamedQuotes = marketDataStream.getSnapshotQuotes(symbolList);
    const missingSymbols = symbolList.filter(
      (symbol) => !streamedQuotes[symbol.toUpperCase()],
    );

    if (missingSymbols.length === 0) {
      logger.info(
        "📶 Quotes: " +
          symbolList.length +
          "/" +
          symbolList.length +
          " from Alpaca stream (instant, 0 API credits)",
      );
      return streamedQuotes;
    }

    logger.info(
      "📶 Quotes: " +
        (symbolList.length - missingSymbols.length) +
        "/" +
        symbolList.length +
        " from Alpaca stream instantly · " +
        missingSymbols.length +
        " not yet streamed (new subscription warming up) — falling back to " +
        "Twelve Data for just those",
    );
    const fallbackQuotes = await fetchIntradayQuotesSequential(
      missingSymbols,
    );
    return { ...streamedQuotes, ...fallbackQuotes };
  }

  return fetchIntradayQuotesSequential(symbolList);
}

async function fetchIntradayQuotesSequential(symbolList) {
  if (!TWELVE_DATA_KEY) {
    logger.error("TWELVE_DATA_API_KEY not set — cannot fetch quotes");
    await alerts.systemAlert(
      "TWELVE_DATA",
      "TWELVE_DATA_API_KEY is not set — the bot cannot fetch any quotes and " +
        "cannot trade. Fix .env and restart.",
    );
    return {};
  }

  const quotesBySymbol = {};
  logger.info(
    "Fetching " +
      symbolList.length +
      " quotes sequentially (~" +
      Math.ceil((symbolList.length * PER_CALL_SPACING_MS) / 60000) +
      " min — free tier meters batch calls per symbol, so batching just 429s)",
  );

  for (let symbolIndex = 0; symbolIndex < symbolList.length; symbolIndex++) {
    const symbol = symbolList[symbolIndex];
    const quote = await fetchSingleQuote(symbol);
    if (quote) quotesBySymbol[symbol] = quote;
    if (symbolIndex < symbolList.length - 1) {
      await sleep(PER_CALL_SPACING_MS);
    }
  }

  const returnedCount = Object.keys(quotesBySymbol).length;
  logger.info(
    "Sequential quotes: " +
      returnedCount +
      "/" +
      symbolList.length +
      " stocks returned",
  );

  // v5: whole batch empty on a non-empty watchlist = provider is down/dead key
  if (symbolList.length > 0 && returnedCount === 0) {
    await alerts.systemAlert(
      "TWELVE_DATA",
      "Twelve Data returned ZERO quotes for all " +
        symbolList.length +
        " watchlist symbols — quota exhausted, key invalid, or provider down. " +
        "No watchlist entries possible until this recovers (exits still run " +
        "off eToro's own P&L data).",
    );
  } else if (returnedCount > 0) {
    await alerts.clearAlert(
      "TWELVE_DATA",
      "Twelve Data quotes are flowing again (" +
        returnedCount +
        "/" +
        symbolList.length +
        " returned).",
    );
  }

  return quotesBySymbol;
}

// ── Change-based enrichment cache ───────────────────────────────────────────
const enrichmentCache = {};

function getCachedEnrichment(symbol, currentPrice) {
  const cached = enrichmentCache[symbol];
  if (!cached) return null;
  const ageMs = Date.now() - cached.atMs;
  if (ageMs > config.enrichCacheMinutes * 60 * 1000) return null;
  if (currentPrice && cached.priceAtEnrich) {
    const movePct =
      Math.abs(currentPrice - cached.priceAtEnrich) / cached.priceAtEnrich;
    if (movePct * 100 > config.enrichCacheMaxPriceMovePct) return null;
  }
  return cached.data;
}

// ── Enrichment: today's real intraday high/low, session VWAP, RSI ──────────
// v5.4: eToro-based enrichment — uses REAL candle data (proven working:
// genuine non-zero volume at FiveMinutes granularity) to compute VWAP,
// session high/low, RSI(14), and volumeRatio, all from 2 candle calls
// (today's FiveMinutes bars + a 20-day OneDay history for average volume).
// This is what actually closes the volume gap that Alpaca/the WebSocket
// couldn't — eToro's candles endpoint has real volume, they don't.
const dailyCandleCacheByInstrumentId = {}; // { id: { atMs, candles } } — 20h cache, same as Twelve Data's ATR cache
const DAILY_CANDLE_CACHE_MS = 20 * 60 * 60 * 1000;

async function enrichCandidateFromEtoro(symbol, instrumentId) {
  const todaysFiveMinuteBars = await etoroMarketData.fetchCandles(
    instrumentId,
    "FiveMinutes",
    100, // ~8h of 5-min bars — comfortably covers a full US session
  );
  // ET date, NOT UTC (toISOString). From 8 PM ET onward UTC is already
  // "tomorrow", so the UTC filter matched zero bars — cumulative volume
  // read as 0 and every overnight candidate was hard-rejected on volume.
  const todayDateString = getTodayEasternDateString();
  const todaysBarsOnly = todaysFiveMinuteBars.filter((bar) =>
    (bar.fromDate || "").startsWith(todayDateString),
  );

  const { vwap, high, low } = etoroMarketData.computeVwapAndRange(
    todaysBarsOnly.length ? todaysBarsOnly : todaysFiveMinuteBars,
  );

  // RSI needs a longer chronological series than just today — use the same
  // FiveMinutes pull (100 bars ≈ several sessions), oldest→newest.
  const chronologicalCloses = [...todaysFiveMinuteBars]
    .reverse()
    .map((bar) => bar.close);
  const rsi = etoroMarketData.computeRsi(chronologicalCloses, 14);

  // Daily candles for average volume (20h cache — volume history barely
  // changes intraday, no need to refetch every scan).
  let dailyCandles;
  const cachedDaily = dailyCandleCacheByInstrumentId[instrumentId];
  if (cachedDaily && Date.now() - cachedDaily.atMs < DAILY_CANDLE_CACHE_MS) {
    dailyCandles = cachedDaily.candles;
  } else {
    dailyCandles = await etoroMarketData.fetchCandles(instrumentId, "OneDay", 21);
    dailyCandleCacheByInstrumentId[instrumentId] = {
      atMs: Date.now(),
      candles: dailyCandles,
    };
  }
 const averageVolume = etoroMarketData.computeAverageDailyVolume(dailyCandles);
 const todaysCumulativeVolume = todaysBarsOnly.reduce(
   (sum, bar) => sum + (bar.volume || 0),
   0,
 );

 // v5.4.1 FIX: volumeRatio must compare today's volume-so-far against a
 // TIME-OF-DAY-ADJUSTED expected volume ("relative volume" / RVOL), NOT
 // a full day's average — comparing partial-session volume to a whole
 // day's typical volume structurally fails almost all day.
 const REGULAR_SESSION_MINUTES = 390; // 9:30 AM - 4:00 PM ET
 const nowEasternString = new Date().toLocaleString("en-US", {
   timeZone: "America/New_York",
   hour12: false,
   hour: "2-digit",
   minute: "2-digit",
 });
 const [etHourString, etMinuteString] = nowEasternString.split(":");
 const etHour = parseInt(etHourString);
 const etMinute = parseInt(etMinuteString);
 const rawMinutesSinceOpen = (etHour - 9) * 60 + (etMinute - 30);

 // RVOL is only meaningful DURING/AFTER a regular session with real volume.
 // Pre-market and overnight (24/5 mode) there is no session volume yet —
 // the old clamp-to-5-minutes math produced a ratio of ~0 there, which the
 // scorer read as "confirmed dead volume" and hard-rejected EVERY overnight
 // candidate. Unknown must be null (scorer treats null as "no data"), not 0.
 let volumeRatio = null;
 if (rawMinutesSinceOpen > 0 && todaysCumulativeVolume > 0) {
   const minutesSinceOpen = Math.max(
     5,
     Math.min(REGULAR_SESSION_MINUTES, rawMinutesSinceOpen),
   );
   const expectedVolumeByNow =
     averageVolume != null
       ? averageVolume * (minutesSinceOpen / REGULAR_SESSION_MINUTES)
       : null;
   volumeRatio =
     expectedVolumeByNow > 0
       ? todaysCumulativeVolume / expectedVolumeByNow
       : null;
 }

 return {
   recentIntradayHigh: high,
   recentIntradayLow: low,
   vwap,
   rsi,
   volumeRatio,
   averageVolume,
 };
}

async function enrichCandidate(symbol, currentPrice, knownInstrumentId) {
  if (etoroMarketData.isConfigured()) {
    try {
      const instrumentId =
        knownInstrumentId ||
        (await etoroClient.resolveTickerToInstrumentId(symbol));
      if (instrumentId) {
        const enrichment = await enrichCandidateFromEtoro(symbol, instrumentId);
        await alerts.clearAlert(
          "ETORO_MARKET_DATA_ENRICH",
          "eToro candle enrichment is working again.",
        );
        return enrichment;
      }
    } catch (etoroError) {
      logger.warn(
        symbol +
          ": eToro enrichment failed (" +
          etoroError.message +
          "), falling back to Twelve Data",
      );
      await alerts.systemAlert(
        "ETORO_MARKET_DATA_ENRICH",
        "eToro candle enrichment failed for " +
          symbol +
          ": " +
          etoroError.message +
          ". Falling back to Twelve Data for this symbol.",
      );
    }
  }
  return enrichCandidateFallback(symbol, currentPrice);
}

async function enrichCandidateFallback(symbol, currentPrice) {
  if (!TWELVE_DATA_KEY) return null;

  const cachedEnrichment = getCachedEnrichment(symbol, currentPrice);
  if (cachedEnrichment) {
    logger.info(
      symbol +
        ": enrichment cache hit (fresh + price unchanged) — 2 credits saved",
    );
    return cachedEnrichment;
  }

  const enrichment = {
    recentIntradayHigh: null,
    recentIntradayLow: null,
    vwap: null,
    rsi: null,
  };

  const todayEasternDate = getTodayEasternDateString();

  try {
    trackApiCall("enrich-bars:" + symbol);
    const barsResponse = await axios.get(
      "https://api.twelvedata.com/time_series",
      {
        params: {
          symbol,
          interval: "5min",
          outputsize: 78,
          apikey: TWELVE_DATA_KEY,
        },
        timeout: 12000,
      },
    );
    const allBars = barsResponse.data?.values;
    if (Array.isArray(allBars) && allBars.length > 0) {
      // Session-anchored: keep ONLY today's ET bars.
      const todaysBars = allBars.filter((bar) =>
        String(bar.datetime || "").startsWith(todayEasternDate),
      );

      if (todaysBars.length >= 2) {
        let highestPrice = -Infinity;
        let lowestPrice = Infinity;
        let cumulativeTypicalPriceVolume = 0;
        let cumulativeVolume = 0;

        todaysBars.forEach((bar, barIndex) => {
          const barHigh = parseFloat(bar.high);
          const barLow = parseFloat(bar.low);
          const barClose = parseFloat(bar.close);
          const barVolume = parseFloat(bar.volume) || 0;

          // Bars are newest-first: index 0 = current forming bar; exclude
          // from prior-high/low so breakouts compare against the high
          // BEFORE this bar.
          if (barIndex > 0) {
            if (barHigh > highestPrice) highestPrice = barHigh;
            if (barLow < lowestPrice) lowestPrice = barLow;
          }

          const typicalPrice = (barHigh + barLow + barClose) / 3;
          cumulativeTypicalPriceVolume += typicalPrice * barVolume;
          cumulativeVolume += barVolume;
        });

        enrichment.recentIntradayHigh =
          highestPrice === -Infinity ? null : highestPrice;
        enrichment.recentIntradayLow =
          lowestPrice === Infinity ? null : lowestPrice;
        enrichment.vwap =
          cumulativeVolume > 0
            ? cumulativeTypicalPriceVolume / cumulativeVolume
            : null;
      } else {
        logger.info(
          symbol +
            ": only " +
            todaysBars.length +
            " bar(s) from today's session yet — VWAP/high skipped this scan",
        );
      }
    }
  } catch (barError) {
    logger.warn("Intraday bars failed for " + symbol + ": " + barError.message);
  }

  await sleep(PER_CALL_SPACING_MS);

  try {
    trackApiCall("enrich-rsi:" + symbol);
    const rsiResponse = await axios.get("https://api.twelvedata.com/rsi", {
      params: {
        symbol,
        interval: "15min",
        apikey: TWELVE_DATA_KEY,
        outputsize: 1,
      },
      timeout: 10000,
    });
    const rsiValues = rsiResponse.data?.values;
    if (Array.isArray(rsiValues) && rsiValues.length > 0) {
      enrichment.rsi = parseFloat(rsiValues[0].rsi);
    }
  } catch {
    // RSI optional
  }

  enrichmentCache[symbol] = {
    atMs: Date.now(),
    priceAtEnrich: currentPrice || null,
    data: enrichment,
  };

  return enrichment;
}

// ── Daily ATR(14) as % of price ─────────────────────────────────────────────
const dailyAtrCache = {}; // { SYMBOL: { atMs, atrPercent } }

// v5.4: eToro-first ATR — reuses the SAME 21-day OneDay candles already
// cached by enrichCandidate's average-volume calc when possible (avoids a
// duplicate call for symbols already enriched this scan).
async function fetchDailyAtrPercent(symbol, knownInstrumentId) {
  if (etoroMarketData.isConfigured()) {
    try {
      const instrumentId =
        knownInstrumentId ||
        (await etoroClient.resolveTickerToInstrumentId(symbol));
      if (instrumentId) {
        let dailyCandles;
        const cachedDaily = dailyCandleCacheByInstrumentId[instrumentId];
        if (
          cachedDaily &&
          Date.now() - cachedDaily.atMs < DAILY_CANDLE_CACHE_MS
        ) {
          dailyCandles = cachedDaily.candles;
        } else {
          dailyCandles = await etoroMarketData.fetchCandles(
            instrumentId,
            "OneDay",
            21,
          );
          dailyCandleCacheByInstrumentId[instrumentId] = {
            atMs: Date.now(),
            candles: dailyCandles,
          };
        }
        const atrPercent = etoroMarketData.computeDailyAtrPercent(dailyCandles);
        if (atrPercent != null) return atrPercent;
      }
    } catch (etoroError) {
      logger.warn(
        symbol + ": eToro ATR failed (" + etoroError.message + "), falling back",
      );
    }
  }
  return fetchDailyAtrPercentFallback(symbol);
}

async function fetchDailyAtrPercentFallback(symbol) {
  if (!TWELVE_DATA_KEY) return null;

  const cached = dailyAtrCache[symbol];
  if (
    cached &&
    Date.now() - cached.atMs < config.dailyAtrCacheHours * 60 * 60 * 1000
  ) {
    return cached.atrPercent;
  }

  try {
    trackApiCall("daily-atr:" + symbol);
    const response = await axios.get("https://api.twelvedata.com/time_series", {
      params: {
        symbol,
        interval: "1day",
        outputsize: 16, // 14 ATR periods need 15 bars; +1 margin
        apikey: TWELVE_DATA_KEY,
      },
      timeout: 12000,
    });
    const bars = response.data?.values;
    if (!Array.isArray(bars) || bars.length < 15) {
      logger.warn(symbol + ": not enough daily bars for ATR");
      return null;
    }

    // Bars are newest-first; walk oldest→newest for true-range calc.
    const chronological = [...bars].reverse();
    const trueRanges = [];
    for (let index = 1; index < chronological.length; index++) {
      const bar = chronological[index];
      const previousBar = chronological[index - 1];
      const high = parseFloat(bar.high);
      const low = parseFloat(bar.low);
      const previousClose = parseFloat(previousBar.close);
      if (isNaN(high) || isNaN(low) || isNaN(previousClose)) continue;
      const trueRange = Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose),
      );
      trueRanges.push(trueRange);
    }
    if (trueRanges.length < 14) return null;

    const lastFourteen = trueRanges.slice(-14);
    const averageTrueRange =
      lastFourteen.reduce((sum, value) => sum + value, 0) / lastFourteen.length;
    const latestClose = parseFloat(
      chronological[chronological.length - 1].close,
    );
    if (isNaN(latestClose) || latestClose <= 0) return null;

    const atrPercent = Number(
      ((averageTrueRange / latestClose) * 100).toFixed(2),
    );
    dailyAtrCache[symbol] = { atMs: Date.now(), atrPercent };
    logger.info(symbol + ": daily ATR " + atrPercent + "% of price (cached)");
    return atrPercent;
  } catch (atrError) {
    logger.warn(symbol + ": daily ATR fetch failed — " + atrError.message);
    return null;
  }
}

// ── SPY quote (FAIL-CLOSED — null on any failure, now with ALERT) ──────────
// v5.3: prefers the Alpaca stream snapshot (instant) when configured and
// SPY has streamed data yet; falls back to the original Twelve Data REST
// call otherwise — same fail-closed behavior either way.
async function fetchSpyQuote() {
  // v5.4: eToro first — same proven rates+closing-price combo used for
  // the watchlist. Also fetch a recent daily candle for real high/low
  // (rates alone doesn't have day range; the regime classifier needs it).
  if (etoroMarketData.isConfigured()) {
    try {
      const spyInstrumentId = await etoroClient.resolveTickerToInstrumentId(
        "SPY",
      );
      if (spyInstrumentId) {
        const [ratesByInstrumentId, closingPriceByInstrumentId, dailyCandles] =
          await Promise.all([
            etoroMarketData.fetchBatchedRates([spyInstrumentId]),
            etoroMarketData.getClosingPriceMap(),
            etoroMarketData.fetchCandles(spyInstrumentId, "OneDay", 1),
          ]);
        const rate = ratesByInstrumentId[spyInstrumentId];
        const previousClose =
          closingPriceByInstrumentId[spyInstrumentId]?.daily ?? null;
        const todaysCandle = dailyCandles[0];
        if (rate && previousClose) {
          const currentPrice = (rate.ask + rate.bid) / 2;
          await alerts.clearAlert(
            "ETORO_MARKET_DATA_SPY",
            "eToro SPY quote is working again.",
          );
          return {
            changePercent: ((currentPrice - previousClose) / previousClose) * 100,
            high: todaysCandle?.high ?? currentPrice,
            low: todaysCandle?.low ?? currentPrice,
            currentPrice,
          };
        }
      }
    } catch (etoroError) {
      logger.warn("eToro SPY quote failed: " + etoroError.message);
      await alerts.systemAlert(
        "ETORO_MARKET_DATA_SPY",
        "eToro SPY quote failed: " +
          etoroError.message +
          ". Falling back to " +
          (marketDataStream.isConfigured() ? "Alpaca stream" : "Twelve Data") +
          ".",
      );
    }
  }

  if (marketDataStream.isConfigured()) {
    await marketDataStream.ensureSubscribed(["SPY"]);
    const streamedSpy = marketDataStream.getSpySnapshot();
    if (streamedSpy) return streamedSpy;
    // Stream configured but SPY hasn't produced a bar yet (e.g. just
    // started) — fall back to Twelve Data for this one call only.
  }
  return fetchSpyQuoteFromTwelveData();
}

async function fetchSpyQuoteFromTwelveData() {
  if (!TWELVE_DATA_KEY) {
    logger.error("TWELVE_DATA_API_KEY not set — SPY filter cannot run");
    return null;
  }
  trackApiCall("SPY quote");
  try {
    const response = await axios.get("https://api.twelvedata.com/quote", {
      params: { symbol: "SPY", apikey: TWELVE_DATA_KEY },
      timeout: 10000,
    });
    const data = response.data;
    if (!data || data.code === 429 || data.status === "error") {
      logger.warn("SPY quote unavailable (rate limit or API error)");
      await alerts.systemAlert(
        "SPY_QUOTE",
        "SPY quote is not responding (rate limit or API error). The SPY gate " +
          "is FAIL-CLOSED, so ALL new entries are blocked until SPY data " +
          "returns. Exits are unaffected.",
      );
      return null;
    }
    if (!data.close || !data.previous_close) {
      logger.warn("SPY quote missing close/previous_close fields");
      await alerts.systemAlert(
        "SPY_QUOTE",
        "SPY quote response is malformed (missing close/previous_close). " +
          "New entries are blocked (fail-closed) until this recovers.",
      );
      return null;
    }
    const currentPrice = parseFloat(data.close);
    const previousClose = parseFloat(data.previous_close);
    if (isNaN(currentPrice) || isNaN(previousClose) || previousClose === 0) {
      return null;
    }

    // Working again → clear any prior SPY alert
    await alerts.clearAlert("SPY_QUOTE", "SPY quote is responding again.");

    return {
      changePercent: ((currentPrice - previousClose) / previousClose) * 100,
      high: parseFloat(data.high) || null,
      low: parseFloat(data.low) || null,
      currentPrice,
    };
  } catch (fetchError) {
    logger.warn("SPY quote fetch failed: " + fetchError.message);
    await alerts.systemAlert(
      "SPY_QUOTE",
      "SPY quote fetch threw: " +
        fetchError.message +
        ". New entries are blocked (fail-closed) until this recovers.",
    );
    return null;
  }
}

async function fetchSpyChangePercent() {
  const spyQuote = await fetchSpyQuote();
  return spyQuote ? spyQuote.changePercent : null;
}

async function fetchCurrentPrice(symbol) {
  if (!TWELVE_DATA_KEY) return null;
  trackApiCall("price:" + symbol);
  try {
    const response = await axios.get("https://api.twelvedata.com/price", {
      params: { symbol, apikey: TWELVE_DATA_KEY },
      timeout: 8000,
    });
    const price = parseFloat(response.data?.price);
    return isNaN(price) ? null : price;
  } catch {
    return null;
  }
}

module.exports = {
  fetchIntradayQuotes,
  fetchSingleQuote, // v5.1: exported so discovery can quote FMP/SEC-sourced symbols
  enrichCandidate,
  fetchDailyAtrPercent,
  fetchSpyChangePercent,
  fetchSpyQuote,
  fetchCurrentPrice,
  sleep,
};
