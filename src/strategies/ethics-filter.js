// src/strategies/ethics-filter.js
//
// EXCLUDED-INDUSTRY FILTER — the bot must never BUY into gambling/betting,
// alcohol, or adult-entertainment companies, whether the candidate came from
// the watchlist or autonomous discovery.
//
// Two layers:
//   1. STATIC TICKER BLOCKLIST (sync, offline, authoritative) — well-known
//      US-listed names in the excluded industries. This is the primary
//      defense and works even when Finnhub isn't configured.
//   2. FINNHUB INDUSTRY KEYWORDS (async, best-effort) — catches unknown
//      DISCOVERED tickers whose Finnhub industry label clearly matches an
//      excluded category. Keywords are deliberately conservative: "gaming"
//      is NOT used because video-game companies carry it; "beverage" is NOT
//      used because it would block soda makers.
//
// Unknown industry (no Finnhub key / lookup fails / label ambiguous) →
// ALLOW: the static list is the hard floor, and blocking every unknowable
// ticker would disable discovery entirely.
//
// Enforced in two places (see index.js):
//   - scan pipeline, BEFORE enrichment (saves API credits on blocked names)
//   - tryOpenPosition, as an async hard gate before any order
require("dotenv").config();
const { logger } = require("../logger");
const finnhub = require("../data-sources/finnhub");

// Well-known US-listed tickers in the excluded industries.
const BLOCKED_TICKERS = new Set([
  // ── Gambling / betting / casinos ──
  "DKNG", // DraftKings — sports betting
  "FLUT", // Flutter Entertainment (FanDuel)
  "PENN", // Penn Entertainment — casinos & sportsbook
  "MGM", // MGM Resorts — casinos
  "LVS", // Las Vegas Sands — casinos
  "WYNN", // Wynn Resorts — casinos
  "CZR", // Caesars Entertainment — casinos & betting
  "CHDN", // Churchill Downs — horse racing & betting
  "RSI", // Rush Street Interactive — online casino
  "GENI", // Genius Sports — betting data
  "SRAD", // Sportradar — betting data
  "BALY", // Bally's — casinos
  "IGT", // International Game Technology — slot machines/lottery
  "LNW", // Light & Wonder — casino games
  "EVRI", // Everi — casino payments/games
  "ACEL", // Accel Entertainment — slot routes
  "GAMB", // Gambling.com Group
  "MCRI", // Monarch Casino
  "GDEN", // Golden Entertainment — casinos
  "BYD", // Boyd Gaming on US exchanges (NOT the Chinese EV maker)
  "SGHC", // Super Group — Betway
  // ── Alcohol ──
  "BUD", // Anheuser-Busch InBev
  "TAP", // Molson Coors
  "STZ", // Constellation Brands
  "SAM", // Boston Beer
  "DEO", // Diageo
  "BF.B", // Brown-Forman
  "BF-B",
  "ABEV", // Ambev
  "CCU", // Compañía Cervecerías Unidas
  "NAPA", // Duckhorn wine
  "WVVI", // Willamette Valley Vineyards
  // ── Adult entertainment ──
  "RICK", // RCI Hospitality
  "PLBY", // PLBY Group (Playboy)
]);

// Conservative industry-label keywords (lowercased substring match against
// Finnhub's finnhubIndustry). Deliberately NOT included: "gaming" (video
// games), "beverage" (soft drinks), "leisure"/"hotel" (too broad).
const BLOCKED_INDUSTRY_KEYWORDS = [
  "casino",
  "gambl", // gambling / gambler
  "betting",
  "distill", // distillers
  "brewer", // brewers
  "winer", // wineries
  "spirits",
  "alcohol",
];

// Layer 1: static list — sync, no network. Use in the scan pipeline.
function isBlockedStatic(symbol) {
  return BLOCKED_TICKERS.has(String(symbol || "").toUpperCase());
}

// Layers 1+2: full check — async (may hit the cached Finnhub profile).
// Returns { blocked, reason }.
async function isBlocked(symbol) {
  const upperSymbol = String(symbol || "").toUpperCase();
  if (BLOCKED_TICKERS.has(upperSymbol)) {
    return {
      blocked: true,
      reason: "excluded industry (static blocklist: gambling/alcohol/adult)",
    };
  }

  if (finnhub.isConfigured()) {
    try {
      const industry = await finnhub.getCompanyIndustry(upperSymbol);
      if (industry) {
        const lowered = industry.toLowerCase();
        const matched = BLOCKED_INDUSTRY_KEYWORDS.find((keyword) =>
          lowered.includes(keyword),
        );
        if (matched) {
          logger.info(
            upperSymbol +
              " blocked by ethics filter — Finnhub industry '" +
              industry +
              "' matches excluded keyword '" +
              matched +
              "'",
          );
          return {
            blocked: true,
            reason: "excluded industry (Finnhub: " + industry + ")",
          };
        }
      }
    } catch {
      // Industry lookup failing must never block trading in ALLOWED names —
      // the static list above remains the hard floor.
    }
  }

  return { blocked: false };
}

module.exports = { isBlocked, isBlockedStatic };
