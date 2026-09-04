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
const vixOverride = require("../vix-override");

const FRED_BASE_URL = "https://api.stlouisfed.org/fred/series/observations";
const FRED_API_KEY = process.env.FRED_API_KEY || "";

function isConfigured() {
  return FRED_API_KEY.length > 0;
}

const CACHE_MS = 6 * 60 * 60 * 1000; // daily series — a 6h cache is plenty

// { SERIES_ID: { atMs, points: [{date, value}] } }
const seriesCache = {};

// v7: shared fetcher. Returns the most recent `wanted` NUMERIC observations,
// newest first — FRED emits "." for days a series has no print (holidays,
// not-yet-published), so the caller must never assume observations[0] is a
// number. Returns [] on any failure: every caller degrades to "unavailable"
// rather than blocking a scan on a macro nicety.
async function fetchRecentNumericObservations(seriesId, wanted) {
  if (!isConfigured()) return [];

  const cached = seriesCache[seriesId];
  if (cached && Date.now() - cached.atMs < CACHE_MS) {
    return cached.points.slice(0, wanted);
  }

  try {
    const response = await axios.get(FRED_BASE_URL, {
      params: {
        series_id: seriesId,
        api_key: FRED_API_KEY,
        file_type: "json",
        sort_order: "desc",
        limit: Math.max(10, wanted * 5), // headroom for "." gaps
      },
      timeout: 10000,
    });
    const points = (response.data?.observations || [])
      .filter((observation) => observation.value && observation.value !== ".")
      .map((observation) => ({
        date: observation.date,
        value: parseFloat(observation.value),
      }))
      .filter((point) => !isNaN(point.value));

    if (points.length === 0) return [];

    seriesCache[seriesId] = { atMs: Date.now(), points };
    return points.slice(0, wanted);
  } catch (fetchError) {
    logger.warn(
      "FRED " + seriesId + " fetch failed (non-fatal): " + fetchError.message,
    );
    return [];
  }
}

// Returns the latest available VIX, or null if unconfigured/unavailable.
//
// v7.13: a MANUAL override takes precedence while it is live. VIXCLS is a
// daily CLOSE published with a lag, so the bot has run whole sessions on a
// VIX several days old (observed: the 2026-08-28 print still in use on
// 2026-09-01). That matters because market-regime tightens its CHOP
// threshold on an elevated VIX — a stale-calm reading leaves the bot
// treating a fearful tape as a quiet one.
//
// The override expires on its own (see src/vix-override.js) and every log
// line names its source, so a reading is never ambiguous about where it
// came from.
async function getLatestVix() {
  const override = vixOverride.getActiveOverride();
  if (override) {
    logger.info(
      "VIX (MANUAL override, " +
        vixOverride.hoursRemaining(override).toFixed(1) +
        "h left" +
        (override.note ? ", " + override.note : "") +
        "): " +
        override.value.toFixed(2) +
        " — FRED ignored until this expires",
    );
    return override.value;
  }

  const points = await fetchRecentNumericObservations("VIXCLS", 1);
  if (points.length === 0) return null;

  // v7.13: say how stale the print is. "VIX (FRED, 2026-08-28): 14.43" on a
  // September session looked authoritative; "4 days old" does not.
  const ageDays = Math.max(
    0,
    Math.round((Date.now() - Date.parse(points[0].date + "T21:00:00Z")) / 86400000),
  );
  logger.info(
    "VIX (FRED, " +
      points[0].date +
      (ageDays >= 2 ? ", " + ageDays + " days old" : "") +
      "): " +
      points[0].value.toFixed(2),
  );
  return points[0].value;
}

// v7: 10-YEAR TREASURY YIELD (series DGS10) + its 1-session change in basis
// points. Rates are the single macro variable that reliably re-prices whole
// sectors intraday — financials tend to like a rising 10y, long-duration
// growth/tech tends to dislike it. That is a real, checkable relationship
// this bot can act on, unlike the monthly macro prints (CPI/GDP/employment),
// which are weeks stale by the time a day-trade scan runs and would only
// give the model something vague to rationalise with.
//
// Returns { value, changeBps, asOf } or null. changeBps is null when only a
// single observation is available (so the model is never shown a fabricated
// zero change).
async function getTenYearYield() {
  const points = await fetchRecentNumericObservations("DGS10", 2);
  if (points.length === 0) return null;

  const changeBps =
    points.length >= 2
      ? Number(((points[0].value - points[1].value) * 100).toFixed(1))
      : null;

  return { value: points[0].value, changeBps, asOf: points[0].date };
}

module.exports = { isConfigured, getLatestVix, getTenYearYield };
