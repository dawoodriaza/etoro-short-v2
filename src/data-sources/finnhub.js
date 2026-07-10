// src/data-sources/finnhub.js
//
// v5 NEW MODULE — FINNHUB FREE TIER (60 calls/min, no credit card).
//
// Three jobs, all OPTIONAL — every function degrades gracefully to null /
// [] / "unknown" if FINNHUB_API_KEY is not set or the API fails, so the
// bot keeps trading exactly as before if you never add the key. But WITH
// the key you get, for free:
//
//   1. EARNINGS CALENDAR → earnings blackout. Before entering a position,
//      the bot checks whether the company reports earnings inside the
//      position's expected holding window. Entering the night before an
//      earnings gap is an avoidable coin flip — skip it.
//      Cached 12h per symbol (earnings dates don't move intraday).
//
//   2. COMPANY PROFILE (sector/industry) → dynamic correlation buckets.
//      Feeds sector-map.js so DISCOVERED tickers — which by definition are
//      not in the hardcoded SECTOR_BUCKETS map — still get correlation-
//      guard protection. Cached forever per symbol (sectors don't change).
//
//   3. COMPANY NEWS (last 2 days) → context for the daily AI position
//      reviewer. "Held name has fresh negative headline" is exactly the
//      evidence that should TIGHTEN a stop.
//
// Get a free key at https://finnhub.io (register → dashboard → API key),
// then add FINNHUB_API_KEY=... to .env and restart.
require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { logger } = require("../logger");

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "";

function isConfigured() {
  return FINNHUB_API_KEY.length > 0;
}

// ── Simple in-memory caches ─────────────────────────────────────────────────
const earningsCacheBySymbol = {}; // { SYMBOL: { atMs, nextEarningsDate } }
const EARNINGS_CACHE_MS = 12 * 60 * 60 * 1000; // 12h

const profileCachePath = path.join(
  __dirname,
  "../../data/finnhub-profile-cache.json",
);

function loadProfileCache() {
  try {
    if (!fs.existsSync(profileCachePath)) return {};
    return JSON.parse(fs.readFileSync(profileCachePath, "utf8"));
  } catch {
    return {};
  }
}
function saveProfileCache(cache) {
  try {
    const directory = path.dirname(profileCachePath);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(profileCachePath, JSON.stringify(cache, null, 2));
  } catch (saveError) {
    logger.warn("Could not save Finnhub profile cache: " + saveError.message);
  }
}

function formatDateYmd(date) {
  return date.toISOString().slice(0, 10);
}

// ── 1. Earnings blackout ────────────────────────────────────────────────────
// Returns the next earnings date (YYYY-MM-DD string) within the lookahead
// window, or null if none / unknown / not configured.
async function getNextEarningsDate(symbol, lookaheadDays) {
  if (!isConfigured()) return null;

  const upperSymbol = String(symbol).toUpperCase();
  const cached = earningsCacheBySymbol[upperSymbol];
  if (cached && Date.now() - cached.atMs < EARNINGS_CACHE_MS) {
    return cached.nextEarningsDate;
  }

  try {
    const fromDate = new Date();
    const toDate = new Date(
      Date.now() + Math.max(lookaheadDays, 7) * 24 * 60 * 60 * 1000,
    );
    const response = await axios.get(FINNHUB_BASE_URL + "/calendar/earnings", {
      params: {
        symbol: upperSymbol,
        from: formatDateYmd(fromDate),
        to: formatDateYmd(toDate),
        token: FINNHUB_API_KEY,
      },
      timeout: 10000,
    });
    const calendarEntries = response.data?.earningsCalendar || [];
    const nextEarningsDate =
      calendarEntries.length > 0 ? calendarEntries[0].date || null : null;

    earningsCacheBySymbol[upperSymbol] = {
      atMs: Date.now(),
      nextEarningsDate,
    };
    return nextEarningsDate;
  } catch (fetchError) {
    logger.warn(
      "Finnhub earnings calendar failed for " +
        symbol +
        ": " +
        fetchError.message,
    );
    return null; // unknown → caller decides (we allow the trade, but log)
  }
}

// Convenience: does this symbol report earnings within N days from now?
// Returns { hasEarnings: bool|null, earningsDate: string|null }
// hasEarnings === null means "unknown" (no key or API failure).
async function checkEarningsWithinDays(symbol, windowDays) {
  if (!isConfigured()) return { hasEarnings: null, earningsDate: null };
  const nextEarningsDate = await getNextEarningsDate(symbol, windowDays);
  if (!nextEarningsDate) return { hasEarnings: false, earningsDate: null };

  const earningsTimeMs = new Date(nextEarningsDate + "T00:00:00Z").getTime();
  const windowEndMs = Date.now() + windowDays * 24 * 60 * 60 * 1000;
  return {
    hasEarnings: earningsTimeMs <= windowEndMs,
    earningsDate: nextEarningsDate,
  };
}

// ── 2. Company profile (sector/industry) ───────────────────────────────────
// Returns the Finnhub industry string (e.g. "Semiconductors") or null.
// Cached on disk forever — a company's sector does not change intraday.
async function getCompanyIndustry(symbol) {
  const upperSymbol = String(symbol).toUpperCase();

  const cache = loadProfileCache();
  if (cache[upperSymbol] !== undefined) return cache[upperSymbol];

  if (!isConfigured()) return null;

  try {
    const response = await axios.get(FINNHUB_BASE_URL + "/stock/profile2", {
      params: { symbol: upperSymbol, token: FINNHUB_API_KEY },
      timeout: 10000,
    });
    const industry = response.data?.finnhubIndustry || null;
    cache[upperSymbol] = industry;
    saveProfileCache(cache);
    return industry;
  } catch (fetchError) {
    logger.warn(
      "Finnhub profile failed for " + symbol + ": " + fetchError.message,
    );
    return null;
  }
}

// ── 3. Recent company news (for the AI position reviewer) ──────────────────
// Returns up to maxHeadlines of the last `days` days of headlines, or [].
async function getRecentHeadlines(symbol, days, maxHeadlines) {
  if (!isConfigured()) return [];
  try {
    const toDate = new Date();
    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const response = await axios.get(FINNHUB_BASE_URL + "/company-news", {
      params: {
        symbol: String(symbol).toUpperCase(),
        from: formatDateYmd(fromDate),
        to: formatDateYmd(toDate),
        token: FINNHUB_API_KEY,
      },
      timeout: 10000,
    });
    const articles = Array.isArray(response.data) ? response.data : [];
    return articles
      .slice(0, maxHeadlines || 5)
      .map((article) => ({
        headline: article.headline || "",
        source: article.source || "",
        datetime: article.datetime
          ? new Date(article.datetime * 1000).toISOString()
          : null,
      }))
      .filter((article) => article.headline.length > 0);
  } catch (fetchError) {
    logger.warn(
      "Finnhub news failed for " + symbol + ": " + fetchError.message,
    );
    return [];
  }
}

module.exports = {
  isConfigured,
  getNextEarningsDate,
  checkEarningsWithinDays,
  getCompanyIndustry,
  getRecentHeadlines,
};
