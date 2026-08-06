// src/strategies/market-regime.js
//
// Classifies today's market as TRENDING or CHOP using SPY's intraday range
// as a % of price (high-low)/price.
//
// ═══════════════════════════════════════════════════════════════════════════
// FIX (2026-07-02) — TIME-OF-DAY BIAS REMOVED:
//   The old version compared the RAW range-so-far against a fixed threshold.
//   But intraday range GROWS through the day — at 10:00 AM the range is
//   always small, so morning scans were near-always classified CHOP (score
//   penalty applied), and late-day scans near-always TRENDING. That's a
//   clock reading, not a regime reading.
//
//   Fixed two ways:
//   1. The range-so-far is PROJECTED to a full-day equivalent using the
//      square-root-of-time scaling that random-walk ranges follow:
//        projectedFullDayRange = rangeSoFar * sqrt(390 / minutesElapsed)
//      (390 = minutes in a regular US session). The projection is compared
//      against the configured threshold.
//   2. In the first 45 minutes there is too little information for even a
//      projection — the regime is reported UNKNOWN (no score penalty), which
//      the scorer already handles.
//
// This is still a simple, honest proxy — not a true ADX/regime model — but
// it costs zero extra API calls and no longer punishes the morning session
// for being the morning.
//
// v5.1: OPTIONAL REAL VIX BLEND (needs FRED_API_KEY; degrades gracefully
// to the SPY-range-only behavior above without it). VIX updates once/day
// with a lag, so it can't replace the real-time SPY-range read — instead,
// a genuinely elevated VIX (>25, "fear" territory) tightens the effective
// CHOP threshold by 20%, meaning the bot demands MORE range/movement
// before calling the tape "TRENDING" when the broad market is fearful,
// even if SPY's own intraday range looks fine so far today.

const { logger } = require("../logger");
const config = require("../config");
const fred = require("../data-sources/fred");
const marketHours = require("../market-hours");

const VIX_ELEVATED_THRESHOLD = 25;
const VIX_ELEVATED_TIGHTEN_FACTOR = 1.2; // effective threshold × 1.2 when VIX is elevated

const REGULAR_SESSION_MINUTES = 390; // 09:30 → 16:00 ET
const MINIMUM_MINUTES_FOR_REGIME = 45; // too early to judge before this

// Minutes elapsed since the 09:30 ET open (can be negative pre-open).
//
// P0 FIX (2026-07-27): this used to parse `hour12: false` itself. On the
// production server's Node 20 that yields hour 24 at 00:xx ET, so this
// returned ~900 instead of ~-540 — and since 900 >= 45 the "too early to
// judge" gate never fired. Between 00:00 and 00:59 ET every day, a dead
// overnight tape was classified as a COMPLETED 390-minute session using
// stale range data. Now delegated to the single fixed implementation in
// market-hours.js; see the block comment there.
function getMinutesSinceOpenEastern() {
  return marketHours.getMinutesSinceEasternOpen();
}

// spyQuote: the raw quote object for SPY (has high, low, currentPrice)
// effectiveChopThreshold: optional override (v5.1 VIX blend passes a
// tightened threshold here instead of duplicating this whole function)
function classifyRegime(spyQuote, effectiveChopThreshold) {
  const chopThreshold = effectiveChopThreshold || config.chopRangeThresholdPct;

  if (!spyQuote || !spyQuote.high || !spyQuote.low || !spyQuote.currentPrice) {
    return { regime: "UNKNOWN", rangePct: null };
  }

  const rangeSoFarPct =
    ((spyQuote.high - spyQuote.low) / spyQuote.currentPrice) * 100;

  const minutesElapsed = getMinutesSinceOpenEastern();

  // Too early in the session to say anything meaningful — no penalty.
  if (minutesElapsed < MINIMUM_MINUTES_FOR_REGIME) {
    // FIX (2026-07-22): this used to always print "Math.max(0, minutesElapsed)
    // min since open" — clamping any NEGATIVE value (pre-market/overnight,
    // hours before 9:30 ET) up to 0, so "4h before open" and "just opened"
    // both logged as the identical, misleading "0 min since open". Now shows
    // an honest "opens in Xh Ym" when the session hasn't started yet, and
    // the real elapsed minutes once it has.
    const timingDescription =
      minutesElapsed < 0
        ? "opens in " +
          Math.floor(-minutesElapsed / 60) +
          "h " +
          (-minutesElapsed % 60) +
          "m"
        : minutesElapsed + " min since open";
    logger.info(
      "Market regime: UNKNOWN — " +
        timingDescription +
        " (need " +
        MINIMUM_MINUTES_FOR_REGIME +
        "+ min since open to judge). Range so far " +
        rangeSoFarPct.toFixed(2) +
        "%",
    );
    return { regime: "UNKNOWN", rangePct: rangeSoFarPct };
  }

  // Project the partial-day range to a full-day equivalent (sqrt-of-time
  // scaling), capped so late-day readings aren't shrunk below the raw range.
  const effectiveMinutes = Math.min(minutesElapsed, REGULAR_SESSION_MINUTES);
  const projectionFactor = Math.sqrt(
    REGULAR_SESSION_MINUTES / effectiveMinutes,
  );
  const projectedFullDayRangePct = rangeSoFarPct * projectionFactor;

  const regime =
    projectedFullDayRangePct >= chopThreshold ? "TRENDING" : "CHOP";

  logger.info(
    "Market regime: " +
      regime +
      " (SPY range " +
      rangeSoFarPct.toFixed(2) +
      "% after " +
      effectiveMinutes +
      " min → projected full-day " +
      projectedFullDayRangePct.toFixed(2) +
      "% vs " +
      chopThreshold.toFixed(2) +
      "% threshold" +
      (effectiveChopThreshold ? ", VIX-tightened" : "") +
      ")",
  );
  return { regime, rangePct: projectedFullDayRangePct };
}

// v5.1: VIX-aware wrapper. Fetches real VIX (if FRED_API_KEY configured);
// if VIX is elevated (>25), tightens the CHOP threshold by 20% before
// calling the same classifyRegime() above. Falls back to the plain
// SPY-only classification when FRED isn't configured or the fetch fails —
// never blocks on this being unavailable.
async function classifyRegimeWithVix(spyQuote) {
  const currentVix = await fred.getLatestVix();
  if (currentVix == null) {
    return classifyRegime(spyQuote);
  }

  const isVixElevated = currentVix > VIX_ELEVATED_THRESHOLD;
  const effectiveChopThreshold = isVixElevated
    ? config.chopRangeThresholdPct * VIX_ELEVATED_TIGHTEN_FACTOR
    : config.chopRangeThresholdPct;

  if (isVixElevated) {
    logger.info(
      "⚠️ VIX elevated (" +
        currentVix.toFixed(1) +
        ") — tightening CHOP threshold to " +
        effectiveChopThreshold.toFixed(2) +
        "% (from " +
        config.chopRangeThresholdPct +
        "%)",
    );
  }

  const classification = classifyRegime(spyQuote, effectiveChopThreshold);
  return { ...classification, vix: currentVix, vixElevated: isVixElevated };
}

module.exports = { classifyRegime, classifyRegimeWithVix };
