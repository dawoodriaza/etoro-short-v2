// src/data-sources/fmp.js
//
// v5.1 NEW MODULE — Financial Modeling Prep free tier (250 req/day — same
// provider your long-term bot already uses; get a SEPARATE key here so the
// two bots don't share one 250/day quota).
//
// Job: ANALYST RATING CHANGES. This feeds discovery with a genuinely
// different signal than "already moving" — a fresh upgrade/price-target
// raise often PRECEDES the price move, not just confirms it.
//
// Fails open everywhere: no key or any API error → [] and the rest of
// discovery runs exactly as before.
require("dotenv").config();
const axios = require("axios");
const { logger } = require("../logger");

const FMP_BASE_URL = "https://financialmodelingprep.com/api/v3";
const FMP_API_KEY = process.env.FMP_API_KEY || "";

function isConfigured() {
  return FMP_API_KEY.length > 0;
}

let cachedUpgrades = null;
let cachedAtMs = 0;
const CACHE_MS = 30 * 60 * 1000; // analyst actions don't need to be fresher than 30 min

// Returns recent upgrade/price-target-raise actions (last ~24h), deduped
// by symbol, most-bullish action per symbol only.
async function getRecentAnalystUpgrades() {
  if (!isConfigured()) return [];

  if (cachedUpgrades && Date.now() - cachedAtMs < CACHE_MS) {
    return cachedUpgrades;
  }

  try {
    const response = await axios.get(
      FMP_BASE_URL + "/upgrades-downgrades-rss-feed",
      { params: { apikey: FMP_API_KEY, limit: 100 }, timeout: 12000 },
    );
    const rows = Array.isArray(response.data) ? response.data : [];

    const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
    const seenSymbols = new Set();
    const upgrades = [];

    for (const row of rows) {
      const publishedMs = row.publishedDate
        ? new Date(row.publishedDate).getTime()
        : 0;
      if (publishedMs < cutoffMs) continue;

      const action = String(row.action || "").toLowerCase();
      const isBullishAction =
        action.includes("upgrade") ||
        action.includes("raises price target") ||
        action.includes("buy") ||
        action.includes("outperform") ||
        action.includes("overweight");
      if (!isBullishAction) continue;

      const symbol = String(row.symbol || "").toUpperCase();
      if (!symbol || seenSymbols.has(symbol)) continue;
      seenSymbols.add(symbol);

      upgrades.push({
        symbol,
        analystCompany: row.gradingCompany || "analyst",
        action: row.action || "",
        detail:
          (row.gradingCompany || "An analyst") +
          ": " +
          (row.action || "rating change") +
          (row.newGrade ? " to " + row.newGrade : ""),
      });
    }

    cachedUpgrades = upgrades;
    cachedAtMs = Date.now();

    if (upgrades.length > 0) {
      logger.info(
        "📈 FMP: " +
          upgrades.length +
          " fresh bullish analyst action(s) in the last 24h",
      );
    }
    return upgrades;
  } catch (fetchError) {
    logger.warn("FMP analyst-actions fetch failed: " + fetchError.message);
    return [];
  }
}

// ── v5.6: MARKET MOVERS (gainers + most active) ─────────────────────────────
// Added as a Yahoo-independent discovery source after Yahoo's unofficial
// screener endpoint started hard rate-limiting ("Edge: Too Many Requests")
// for days at a time, leaving discovery completely dark. FMP has REAL,
// documented gainers/actives endpoints on the free tier.
//
// Defensive: FMP has TWO endpoint generations (legacy /api/v3 and newer
// /stable). Your working analyst-upgrades code uses v3, so v3 is tried
// first; if it errors or comes back empty, the stable style is tried.
// Fails open to [] — never blocks discovery, just contributes nothing.
let cachedMovers = null;
let moversCachedAtMs = 0;
const MOVERS_CACHE_MS = 10 * 60 * 1000; // matches the discovery scan cadence

async function fetchMoversFromUrl(url, label) {
  const response = await axios.get(url, { timeout: 12000 });
  const rows = Array.isArray(response.data) ? response.data : [];
  if (rows.length > 0) {
    logger.info("📈 FMP movers (" + label + "): " + rows.length + " rows");
  }
  return rows;
}

// Returns raw mover rows: [{ symbol, name, price, change, changesPercentage }]
// deduped across gainers + actives. [] if unconfigured or all endpoints fail.
async function getMarketMovers() {
  if (!isConfigured()) return [];

  if (cachedMovers && Date.now() - moversCachedAtMs < MOVERS_CACHE_MS) {
    return cachedMovers;
  }

  const endpointGenerations = [
    {
      label: "v3",
      gainersUrl:
        FMP_BASE_URL + "/stock_market/gainers?apikey=" + FMP_API_KEY,
      activesUrl:
        FMP_BASE_URL + "/stock_market/actives?apikey=" + FMP_API_KEY,
    },
    {
      label: "stable",
      gainersUrl:
        "https://financialmodelingprep.com/stable/biggest-gainers?apikey=" +
        FMP_API_KEY,
      activesUrl:
        "https://financialmodelingprep.com/stable/most-actives?apikey=" +
        FMP_API_KEY,
    },
  ];

  for (const generation of endpointGenerations) {
    try {
      const [gainersResult, activesResult] = await Promise.allSettled([
        fetchMoversFromUrl(generation.gainersUrl, generation.label + " gainers"),
        fetchMoversFromUrl(generation.activesUrl, generation.label + " actives"),
      ]);
      const combinedRows = [
        ...(gainersResult.status === "fulfilled" ? gainersResult.value : []),
        ...(activesResult.status === "fulfilled" ? activesResult.value : []),
      ];
      if (combinedRows.length === 0) continue; // try the next generation

      const seenSymbols = new Set();
      const dedupedRows = [];
      for (const row of combinedRows) {
        const symbol = String(row.symbol || "").toUpperCase();
        if (!symbol || seenSymbols.has(symbol)) continue;
        seenSymbols.add(symbol);
        dedupedRows.push(row);
      }

      cachedMovers = dedupedRows;
      moversCachedAtMs = Date.now();
      return dedupedRows;
    } catch (fetchError) {
      logger.warn(
        "FMP movers (" + generation.label + ") failed: " + fetchError.message,
      );
    }
  }

  return [];
}

module.exports = { isConfigured, getRecentAnalystUpgrades, getMarketMovers };