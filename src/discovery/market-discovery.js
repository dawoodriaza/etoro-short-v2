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
      "Stock discovery (Yahoo screeners) has FAILED " +
        consecutiveFailureCount +
        " scans in a row (" +
        failureDescription +
        "). The bot is running WATCHLIST-ONLY — it will not find any " +
        "opportunities outside the watchlist until this recovers. The Yahoo " +
        "endpoint may have changed shape.",
    );
  }
}

async function registerDiscoverySuccess() {
  if (consecutiveFailureCount >= config.discoveryFailureAlertThreshold) {
    await alerts.clearAlert(
      "DISCOVERY",
      "Yahoo screeners are responding again — discovery is back online.",
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

// ── Public: discover movers outside the watchlist ──────────────────────────
async function discoverOpportunities(excludeSymbols) {
  if (!config.discoveryEnabled) return [];

  const now = Date.now();
  let rawRows;
  if (cachedDiscoveries && now - cachedAt < DISCOVERY_CACHE_MS) {
    rawRows = cachedDiscoveries;
  } else {
    try {
      // v5.1: added growth_technology_stocks + small_cap_gainers so
      // discovery isn't ONLY "biggest raw % movers".
      const [gainers, actives, growthTech, smallCapGainers] =
        await Promise.allSettled([
          fetchScreener("day_gainers", 25),
          fetchScreener("most_actives", 25),
          fetchScreener("growth_technology_stocks", 25),
          fetchScreener("small_cap_gainers", 25),
        ]);
      rawRows = [
        ...(gainers.status === "fulfilled" ? gainers.value : []),
        ...(actives.status === "fulfilled" ? actives.value : []),
        ...(growthTech.status === "fulfilled" ? growthTech.value : []),
        ...(smallCapGainers.status === "fulfilled"
          ? smallCapGainers.value
          : []),
      ];
      if (rawRows.length === 0) {
        await registerDiscoveryFailure(
          "screeners returned nothing — endpoint change or outage",
        );
        return [];
      }
      cachedDiscoveries = rawRows;
      cachedAt = now;
      await registerDiscoverySuccess();
    } catch (fetchError) {
      await registerDiscoveryFailure(fetchError.message);
      return [];
    }
  }

  const seenSymbols = new Set();
  const candidates = [];

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
  // The review's discovery point 5 specifically asked for this: "this
  // mover has a same-day news hit" is a meaningfully different, higher-
  // quality signal than "this mover is up 5% with no visible reason" —
  // distinct from the ANALYST_UPGRADE/INSIDER_BUY catalyst candidates
  // above, which are sourced FROM a catalyst. This checks whether a plain
  // price/volume mover ALSO has fresh news, and tags it if so. One
  // Finnhub call per top candidate that doesn't already have a catalyst —
  // cheap, and only runs on the handful of names that already survived
  // every other filter, not the whole raw candidate pool.
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
          discovery.catalystLabel =
            "Same-day news: " + headlines[0].headline;
          logger.info(
            "📰 " + discovery.symbol + " tagged NEWS_HIT: " +
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
