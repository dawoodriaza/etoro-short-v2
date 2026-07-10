// src/data-sources/fred.js
//
// v5.1 NEW MODULE — FRED (Federal Reserve Economic Data), completely free,
// key required but instant/no-approval-wait at https://fred.stlouisfed.org.
//
// Job: REAL VIX LEVEL (series VIXCLS) as a supplement to the SPY-range
// regime proxy in market-regime.js. The review specifically flagged that
// the regime classifier had "no real VIX feed, no macro awareness" — this
// doesn't replace the SPY-range proxy (that stays zero-cost and real-time,
// VIX updates once daily with a lag), it ADDS a second, independent read
// that's blended in: a genuinely elevated VIX (>25) tightens the CHOP
// threshold so the bot demands more evidence in a fearful tape, even if
// SPY's own range looks calm so far today.
//
// Fails open: no key or any error → null, and market-regime.js falls back
// to the SPY-range-only proxy exactly as before.
require("dotenv").config();
const axios = require("axios");
const { logger } = require("../logger");

const FRED_BASE_URL = "https://api.stlouisfed.org/fred/series/observations";
const FRED_API_KEY = process.env.FRED_API_KEY || "";

function isConfigured() {
  return FRED_API_KEY.length > 0;
}

let cachedVix = null;
let cachedAtMs = 0;
const CACHE_MS = 6 * 60 * 60 * 1000; // VIXCLS updates once/day — 6h cache is plenty

// Returns the latest available VIX close, or null if unconfigured/unavailable.
async function getLatestVix() {
  if (!isConfigured()) return null;

  if (cachedVix != null && Date.now() - cachedAtMs < CACHE_MS) {
    return cachedVix;
  }

  try {
    const response = await axios.get(FRED_BASE_URL, {
      params: {
        series_id: "VIXCLS",
        api_key: FRED_API_KEY,
        file_type: "json",
        sort_order: "desc",
        limit: 5, // a few, in case the most recent point(s) are "."  (no data yet)
      },
      timeout: 10000,
    });
    const observations = response.data?.observations || [];
    const latestNumeric = observations.find(
      (observation) => observation.value && observation.value !== ".",
    );
    if (!latestNumeric) return null;

    const vixValue = parseFloat(latestNumeric.value);
    if (isNaN(vixValue)) return null;

    cachedVix = vixValue;
    cachedAtMs = Date.now();
    logger.info(
      "VIX (FRED, " + latestNumeric.date + "): " + vixValue.toFixed(2),
    );
    return vixValue;
  } catch (fetchError) {
    logger.warn("FRED VIX fetch failed: " + fetchError.message);
    return null;
  }
}

module.exports = { isConfigured, getLatestVix };
