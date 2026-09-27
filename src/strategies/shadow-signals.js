// src/strategies/shadow-signals.js — v8.1 SHADOW LOG.
//
// One SHADOW_SIGNAL journal record per candidate per scan: the features the
// bot actually saw at scan time (price, day move, ATR, VWAP distance,
// position in the day's range, distance below the day's high, RSI, relative
// strength, volume ratio, regime) plus the planner's stop distance, and the
// FINAL outcome — what the bot did with it:
//
//   SCORING_REJECTED · SCORED · REENTRY_BLOCKED · NOT_SHORTLISTED ·
//   PLAN_REJECTED · PLANNED · AI_SKIP · AI_TAKE · BLOCKED · OPENED
//
// Why: the 2026-09 audit had to rebuild entry-time features from candles and
// got a look-ahead artefact on the first attempt (hourly bars that ended
// after the entry leaked future highs into "range so far"). Recording the
// features at the moment of decision removes that class of error, and every
// candidate — taken or not — becomes a labelled sample that
// `node src/replay-exits.js --set shadow` can replay with real exits.
const tradePlanner = require("./trade-planner");
const momentumScanner = require("./momentum-scanner");

function createShadowBook() {
  return new Map();
}

const round = (value, digits) =>
  value == null || !Number.isFinite(Number(value)) ? null : Number(Number(value).toFixed(digits));

function buildShadowSignal(candidate, scored, context) {
  const price = Number(candidate.currentPrice) || null;
  const high = candidate.recentIntradayHigh != null ? Number(candidate.recentIntradayHigh) : null;
  const low = candidate.recentIntradayLow != null ? Number(candidate.recentIntradayLow) : null;
  const vwap = candidate.vwap != null ? Number(candidate.vwap) : null;
  const atrPercent = candidate.atrPercent != null ? Number(candidate.atrPercent) : null;
  const changePercent =
    typeof candidate.priceChangePercent === "number" ? candidate.priceChangePercent : null;
  const wasScored = scored && !scored.rejected;
  const spyChangePercent =
    context && typeof context.spyChangePercent === "number" ? context.spyChangePercent : null;

  return {
    symbol: String(candidate.symbol || "").toUpperCase(),
    source: candidate.source || "WATCHLIST",
    price: round(price, 4),
    quoteTimestamp: candidate.quoteTimestamp || null,
    priceChangePercent: round(changePercent, 3),
    atrPercent: round(atrPercent, 3),
    moveToAtr: atrPercent > 0 && changePercent != null ? round(changePercent / atrPercent, 3) : null,
    score: wasScored ? round(scored.score, 2) : null,
    setup: wasScored ? scored.setup : null,
    rsi: round(candidate.rsi, 2),
    relativeStrength:
      wasScored && scored.relativeStrength != null
        ? round(scored.relativeStrength, 3)
        : changePercent != null && spyChangePercent != null
          ? round(changePercent - spyChangePercent, 3)
          : null,
    aboveVwap: vwap != null && price != null ? price >= vwap : null,
    vwapDistancePct: vwap && price ? round((price / vwap - 1) * 100, 3) : null,
    intradayHigh: round(high, 4),
    intradayLow: round(low, 4),
    rangePosition:
      high != null && low != null && high > low && price != null ? round((price - low) / (high - low), 3) : null,
    belowHighPct: high && price ? round((high / price - 1) * 100, 3) : null,
    volumeRatio: round(candidate.volumeRatio, 3),
    regime: (context && context.regime) || null,
    spyChangePercent: round(spyChangePercent, 3),
    stopDistancePct: round(tradePlanner.computeStopDistancePct("DAY", atrPercent) * 100, 3),
    outcome: scored && scored.rejected ? "SCORING_REJECTED" : "SCORED",
    outcomeDetail: scored && scored.rejected ? scored.rejectReason || null : null,
    ...trendScoreFields(candidate, context, price, changePercent, atrPercent),
  };
}

// v8.4: trend score V2 logged beside the live score (momentum-scanner.js).
// Observation only — nothing reads these fields to trade.
function trendScoreFields(candidate, context, price, changePercent, atrPercent) {
  if (!context || !context.scoreV2 || !Array.isArray(candidate.intradayBars)) return {};
  try {
    const previousClose = price && changePercent != null ? price / (1 + changePercent / 100) : null;
    const features = momentumScanner.extractTrendFeatures({
      bars: candidate.intradayBars,
      nowMs: context.nowMs || Date.now(),
      price,
      previousClose,
      atrPercent,
      spyBars: context.spyBars,
      spyPrice: context.spyPrice,
    });
    const trend = momentumScanner.scoreTrendV2(features);
    return {
      scoreV2: trend.score,
      scoreV2Reason: trend.reason,
      scoreV2Components: trend.components,
      trendFeatures: features,
    };
  } catch (error) {
    return { scoreV2: null, scoreV2Reason: "trend score error: " + error.message };
  }
}

function recordShadowCandidate(book, candidate, scored, context) {
  if (!book || !candidate || !candidate.symbol) return;
  book.set(String(candidate.symbol).toUpperCase(), buildShadowSignal(candidate, scored, context));
}

function markShadowOutcome(book, symbol, outcome, detail) {
  if (!book || !symbol) return;
  const entry = book.get(String(symbol).toUpperCase());
  if (!entry) return;
  entry.outcome = outcome;
  if (detail !== undefined) entry.outcomeDetail = detail;
}

module.exports = { createShadowBook, buildShadowSignal, recordShadowCandidate, markShadowOutcome };
