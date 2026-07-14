// src/discovery/market-discovery.js
//
// v5 (2026-07-04): "SILENTLY DARK" FIX. Discovery is fail-open by design
// (Yahoo down → return [] → bot trades its watchlist). Correct — but it
// meant discovery could be broken for DAYS with nothing but warn-level log
// lines. Now consecutive failures are counted; at
// config.discoveryFailureAlertThreshold in a row (default 3) a throttled
// Telegram alert fires, and the first success afterwards sends a recovery
// notice. Discovery still NEVER blocks the core pipeline.
//
// v4 design retained: Yahoo Finance free predefined screeners
// (day_gainers, most_actives) — the whole US market, no API key, ZERO
// Twelve Data credits. Equities only (ETFs/funds/crypto filtered out by
// quoteType). First-time discoveries trade half size.
require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { logger } = require("../logger");
const config = require("../config");
const alerts = require("../notifications/alerts");
const marketData = require("../market-data");
const fmp = require("../data-sources/fmp");
const secEdgar = require("../data-sources/sec-edgar");
const finnhub = require("../data-sources/finnhub"); // v5.2: news-catalyst tagging

const MAX_CATALYST_QUOTES_PER_SCAN = 4; // analyst + insider combined, per scan

const YAHOO_SCREENER_URL =
  "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const discoveredHistoryPath = path.join(
  __dirname,
  "../../data/discovered-history.json",
);

// In-memory cache: screeners refresh at most every 10 minutes.
let cachedDiscoveries = null;
let cachedAt = 0;
const DISCOVERY_CACHE_MS = 10 * 60 * 1000;

// v5: consecutive-failure tracking for the dark-discovery alert
let consecutiveFailureCount = 0;

// ── First-trade history ─────────────────────────────────────────────────────
function loadDiscoveredHistory() {
  try {
    if (!fs.existsSync(discoveredHistoryPath)) return { tradedSymbols: [] };
    return JSON.parse(fs.readFileSync(discoveredHistoryPath, "utf8"));
  } catch {
    return { tradedSymbols: [] };
  }
}

function hasTradedBefore(symbol) {
  const history = loadDiscoveredHistory();
  return (history.tradedSymbols || []).includes(String(symbol).toUpperCase());
}

function recordTraded(symbol) {
  try {
    const history = loadDiscoveredHistory();
    const upperSymbol = String(symbol).toUpperCase();
    if (!(history.tradedSymbols || []).includes(upperSymbol)) {
      history.tradedSymbols = [...(history.tradedSymbols || []), upperSymbol];
      const directory = path.dirname(discoveredHistoryPath);
      if (!fs.existsSync(directory))
        fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(discoveredHistoryPath, JSON.stringify(history, null, 2));
    }
  } catch (saveError) {
    logger.warn("Could not record discovered-history: " + saveError.message);
  }
}

// v5: called on both failure paths (throw AND empty response)
async function registerDiscoveryFailure(failureDescription) {
  consecutiveFailureCount++;
  logger.warn(
    "Discovery failure " +
      consecutiveFailureCount +
      " in a row: " +
      failureDescription,
  );
  if (consecutiveFailureCount >= config.discoveryFailureAlertThreshold) {
    await alerts.systemAlert(
      "DISCOVERY",
      "Stock discovery has FAILED " +
        consecutiveFailureCount +
        " scans in a row (" +
        failureDescription +
        "). BOTH sources (Yahoo screeners AND FMP movers) are dark — the " +
        "bot is running WATCHLIST-ONLY until at least one recovers. Check " +
        "FMP_API_KEY validity and Yahoo status.",
    );
  }
}

async function registerDiscoverySuccess() {
  if (consecutiveFailureCount >= config.discoveryFailureAlertThreshold) {
    await alerts.clearAlert(
      "DISCOVERY",
      "At least one discovery source (Yahoo screeners / FMP movers) is " +
        "responding again — discovery is back online.",
    );
  }
  consecutiveFailureCount = 0;
}

// ── Yahoo screener fetch ────────────────────────────────────────────────────
async function fetchScreener(screenerId, count) {
  const response = await axios.get(YAHOO_SCREENER_URL, {
    params: { scrIds: screenerId, count },
    timeout: 12000,
    headers: { "User-Agent": BROWSER_USER_AGENT },
  });
  const quotes =
    response.data?.finance?.result?.[0]?.quotes ||
    response.data?.finance?.result?.[0]?.records ||
    [];
  return Array.isArray(quotes) ? quotes : [];
}

// Map a raw Yahoo screener row into the candidate shape the momentum
// prefilter expects.
function mapYahooRowToCandidate(row) {
  const symbol = String(row.symbol || "").toUpperCase();
  const currentPrice = Number(row.regularMarketPrice);
  const changePercent = Number(row.regularMarketChangePercent);
  const volume = Number(row.regularMarketVolume);
  const averageVolume = Number(
    row.averageDailyVolume3Month || row.averageDailyVolume10Day,
  );
  const previousClose = Number(row.regularMarketPreviousClose);
  const dayOpen = Number(row.regularMarketOpen);

  if (!symbol || isNaN(currentPrice) || currentPrice <= 0) return null;

  return {
    symbol,
    currentPrice,
    previousClose: isNaN(previousClose) ? null : previousClose,
    dayOpen: isNaN(dayOpen) ? null : dayOpen,
    dayHigh: null,
    dayLow: null,
    volumeRatio:
      averageVolume > 0 && !isNaN(volume) ? volume / averageVolume : null,
    averageVolume: isNaN(averageVolume) ? null : averageVolume, // v5.1: liquidity check
    priceChangePercent: isNaN(changePercent) ? 0 : changePercent,
    recentIntradayHigh: null,
    recentIntradayLow: null,
    vwap: null,
    rsi: null,
    source: "DISCOVERED",
  };
}

// ── v5.1: quote + wrap a catalyst-sourced symbol (FMP/SEC give no price) ───
async function quoteCatalystCandidate(symbol, catalystLabel, catalystType) {
  const quote = await marketData.fetchSingleQuote(symbol);
  if (!quote || !quote.currentPrice) return null;
  if (
    quote.currentPrice < config.discoveryMinPrice ||
    quote.currentPrice > config.discoveryMaxPrice
  ) {
    return null;
  }
  if ((quote.priceChangePercent || 0) < -1) return null;

  return {
    ...quote,
    symbol,
    source: "DISCOVERED",
    catalyst: catalystType,
    catalystLabel,
  };
}

async function fetchCatalystCandidates(excludeSymbols) {
  const results = [];
  let quotesUsed = 0;

  try {
    const analystUpgrades = await fmp.getRecentAnalystUpgrades();
    for (const upgrade of analystUpgrades) {
      if (quotesUsed >= MAX_CATALYST_QUOTES_PER_SCAN) break;
      if (excludeSymbols && excludeSymbols.has(upgrade.symbol)) continue;
      quotesUsed++;
      const candidate = await quoteCatalystCandidate(
        upgrade.symbol,
        upgrade.detail,
        "ANALYST_UPGRADE",
      );
      if (candidate) results.push(candidate);
      await marketData.sleep(8000);
    }
  } catch (analystError) {
    logger.warn("Analyst-upgrade discovery skipped: " + analystError.message);
  }

  try {
    const insiderFilers = await secEdgar.getRecentInsiderBuyFilers();
    for (const filer of insiderFilers) {
      if (quotesUsed >= MAX_CATALYST_QUOTES_PER_SCAN) break;
      if (excludeSymbols && excludeSymbols.has(filer.symbol)) continue;
      if (results.some((existing) => existing.symbol === filer.symbol))
        continue;
      quotesUsed++;
      const candidate = await quoteCatalystCandidate(
        filer.symbol,
        "Insider Form 4 filed " +
          (filer.filedDate || "recently") +
          " (" +
          filer.companyName +
          ")",
        "INSIDER_BUY",
      );
      if (candidate) results.push(candidate);
      await marketData.sleep(8000);
    }
  } catch (insiderError) {
    logger.warn("Insider-buy discovery skipped: " + insiderError.message);
  }

  if (results.length > 0) {
    logger.info(
      "📰 Catalyst discovery: " +
        results.length +
        " candidate(s) — " +
        results.map((c) => c.symbol + " (" + c.catalyst + ")").join(", "),
    );
  }
  return results;
}

// ── v5.6: map an FMP mover row into the candidate shape ─────────────────────
// FMP rows carry {symbol, name, price, change, changesPercentage} — no
// volume, no OHLC. volumeRatio stays null, which is fine post-v5.4: the
// prefilter passes "unknown" through and the REAL volume gate fires after
// enrichment fills it in from eToro candles. previousClose is derived
// from price − change so the gap math still works.
function mapFmpRowToCandidate(row) {
  const symbol = String(row.symbol || "").toUpperCase();
  const currentPrice = Number(row.price);
  const changePercent = Number(row.changesPercentage);
  const changeDollars = Number(row.change);
  const name = String(row.name || "");

  if (!symbol || isNaN(currentPrice) || currentPrice <= 0) return null;
  // Equities only: skip obvious funds, plus warrant/unit-style symbols
  // (dots, dashes, or 6+ chars — FMP movers lists include those).
  if (/ETF|Fund|Trust ETF/i.test(name)) return null;
  if (!/^[A-Z]{1,5}$/.test(symbol)) return null;

  const previousClose = !isNaN(changeDollars)
    ? currentPrice - changeDollars
    : null;

  return {
    symbol,
    currentPrice,
    previousClose,
    dayOpen: null,
    dayHigh: null,
    dayLow: null,
    volumeRatio: null, // filled in by enrichment (eToro candles)
    averageVolume: null,
    priceChangePercent: isNaN(changePercent) ? 0 : changePercent,
    recentIntradayHigh: null,
    recentIntradayLow: null,
    vwap: null,
    rsi: null,
    source: "DISCOVERED",
  };
}

// ── Public: discover movers outside the watchlist ──────────────────────────
async function discoverOpportunities(excludeSymbols) {
  if (!config.discoveryEnabled) return [];

  const now = Date.now();

  // v5.6 RESTRUCTURE: Yahoo is now BEST-EFFORT, not the whole layer. Its
  // unofficial endpoint has been hard rate-limiting ("Edge: Too Many
  // Requests") for days at a stretch, which used to kill discovery
  // entirely. Now FMP's real, documented gainers/actives endpoints run as
  // an independent second source, and "discovery failed" is only declared
  // when BOTH come back empty.
  let yahooRows = [];
  if (cachedDiscoveries && now - cachedAt < DISCOVERY_CACHE_MS) {
    yahooRows = cachedDiscoveries;
  } else {
    try {
      const [gainers, actives, growthTech, smallCapGainers] =
        await Promise.allSettled([
          fetchScreener("day_gainers", 25),
          fetchScreener("most_actives", 25),
          fetchScreener("growth_technology_stocks", 25),
          fetchScreener("small_cap_gainers", 25),
        ]);
      yahooRows = [
        ...(gainers.status === "fulfilled" ? gainers.value : []),
        ...(actives.status === "fulfilled" ? actives.value : []),
        ...(growthTech.status === "fulfilled" ? growthTech.value : []),
        ...(smallCapGainers.status === "fulfilled"
          ? smallCapGainers.value
          : []),
      ];
      if (yahooRows.length > 0) {
        cachedDiscoveries = yahooRows;
        cachedAt = now;
      }
    } catch (yahooError) {
      logger.warn("Yahoo screeners failed (non-fatal): " + yahooError.message);
      yahooRows = [];
    }
  }

  // Independent second source — cached internally in fmp.js, fails open
  const fmpMoverRows = await fmp.getMarketMovers();

  if (yahooRows.length === 0 && fmpMoverRows.length === 0) {
    await registerDiscoveryFailure(
      "BOTH Yahoo screeners AND FMP movers returned nothing",
    );
    return [];
  }
  await registerDiscoverySuccess();

  if (yahooRows.length === 0 && fmpMoverRows.length > 0) {
    logger.info(
      "🔭 Discovery running on FMP movers only this scan (Yahoo dark, " +
        fmpMoverRows.length +
        " FMP rows)",
    );
  }

  const seenSymbols = new Set();
  const candidates = [];

  // FMP movers pass (same quality filters as the Yahoo pass below)
  for (const row of fmpMoverRows) {
    const candidate = mapFmpRowToCandidate(row);
    if (!candidate) continue;
    if (seenSymbols.has(candidate.symbol)) continue;
    seenSymbols.add(candidate.symbol);

    if (excludeSymbols && excludeSymbols.has(candidate.symbol)) continue;
    if (
      candidate.currentPrice < config.discoveryMinPrice ||
      candidate.currentPrice > config.discoveryMaxPrice
    )
      continue;
    // No volume data on FMP rows, so the move itself must qualify
    if (candidate.priceChangePercent < config.discoveryMinChangePct) continue;
    // A move BEYOND the max is a pump top, not a momentum entry — chasing
    // +40%+ movers bought BRAI at the top and stopped out in one minute.
    if (candidate.priceChangePercent > config.discoveryMaxChangePct) continue;

    candidates.push(candidate);
  }

  const rawRows = yahooRows;

  for (const row of rawRows) {
    if (row.quoteType && row.quoteType !== "EQUITY") continue;

    const candidate = mapYahooRowToCandidate(row);
    if (!candidate) continue;
    if (seenSymbols.has(candidate.symbol)) continue;
    seenSymbols.add(candidate.symbol);

    if (excludeSymbols && excludeSymbols.has(candidate.symbol)) continue;

    if (
      candidate.currentPrice < config.discoveryMinPrice ||
      candidate.currentPrice > config.discoveryMaxPrice
    )
      continue;
    const isRealMover =
      candidate.priceChangePercent >= config.discoveryMinChangePct;
    const isVolumeSurge =
      candidate.volumeRatio != null &&
      candidate.volumeRatio >= config.discoveryMinRelVolume;
    if (!isRealMover && !isVolumeSurge) continue;
    if (candidate.priceChangePercent < 0) continue;
    // Same pump-top cap as the FMP path above.
    if (candidate.priceChangePercent > config.discoveryMaxChangePct) continue;

    candidates.push(candidate);
  }

  // v5.1: merge in analyst-upgrade / insider-buy candidates
  const catalystCandidates = await fetchCatalystCandidates(
    new Set([...seenSymbols, ...(excludeSymbols || [])]),
  );
  for (const catalystCandidate of catalystCandidates) {
    if (seenSymbols.has(catalystCandidate.symbol)) continue;
    seenSymbols.add(catalystCandidate.symbol);
    candidates.push(catalystCandidate);
  }

  // Catalyst-sourced candidates rank ahead of pure movers (a real catalyst
  // is a stronger signal than "it went up"), then by size of move.
  candidates.sort((a, b) => {
    const aHasCatalyst = a.catalyst ? 1 : 0;
    const bHasCatalyst = b.catalyst ? 1 : 0;
    if (aHasCatalyst !== bHasCatalyst) return bHasCatalyst - aHasCatalyst;
    return (b.priceChangePercent || 0) - (a.priceChangePercent || 0);
  });
  const topDiscoveries = candidates.slice(0, config.discoveryMaxCandidates);

  // v5.2: NEWS-CATALYST TAGGING for ordinary (non-catalyst-sourced) movers.
  if (finnhub.isConfigured()) {
    for (const discovery of topDiscoveries) {
      if (discovery.catalyst) continue; // already FMP/SEC-catalyst-sourced
      try {
        const headlines = await finnhub.getRecentHeadlines(
          discovery.symbol,
          1,
          1,
        );
        if (headlines.length > 0) {
          discovery.catalyst = "NEWS_HIT";
          discovery.catalystLabel = "Same-day news: " + headlines[0].headline;
          logger.info(
            "📰 " +
              discovery.symbol +
              " tagged NEWS_HIT: " +
              headlines[0].headline,
          );
        }
      } catch {
        // best-effort tagging only — never blocks discovery
      }
    }
  }

  if (topDiscoveries.length > 0) {
    logger.info(
      "🔭 Discovery: " +
        topDiscoveries.length +
        " new opportunity(ies) outside watchlist — " +
        topDiscoveries
          .map(
            (candidate) =>
              candidate.symbol +
              (candidate.catalyst ? " [" + candidate.catalyst + "]" : "") +
              " +" +
              candidate.priceChangePercent.toFixed(1) +
              "%",
          )
          .join(", "),
    );
  } else {
    logger.info("🔭 Discovery: no qualifying movers outside watchlist");
  }
  return topDiscoveries;
}

module.exports = { discoverOpportunities, hasTradedBefore, recordTraded };
