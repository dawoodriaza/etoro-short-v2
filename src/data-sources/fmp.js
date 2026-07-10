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

module.exports = { isConfigured, getRecentAnalystUpgrades };
