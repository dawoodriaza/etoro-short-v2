// src/strategies/momentum-scanner.js
//
// v5 (2026-07-04) — P0 FIX: the previous version did
//     const { getCurrentBahrainTime } = require("../");
// which resolves to src/index.js — a CIRCULAR require (index.js requires
// this file). Node returned an empty export object, getCurrentBahrainTime
// was undefined, and prefilterCandidates() THREW on its first log line —
// killing every scan cycle after the quote fetch and before any candidate
// was ever produced. The import now correctly points at market-hours.js,
// where the function actually lives.
//
// Pure-code pre-filter for day-trade candidates. Runs BEFORE the AI screener
// so the bot only spends an AI call on stocks that already show a real
// intraday signal.
//
// Two-phase design:
//   Phase A (cheap): gap + volume + price-change pre-filter on the batch quote
//                    data — no extra API calls. Narrows ~20 stocks to a few.
//   Phase B (richer): the index.js loop enriches survivors with real intraday
//                     high, VWAP, and RSI, then calls scoreEnrichedCandidate()
//                     which applies the breakout / VWAP / RSI logic.
//
// Setups: GAP_AND_GO, BREAKOUT (vs real intraday high), MOMENTUM_SURGE.
require("dotenv").config();
const { logger } = require("../logger");
const config = require("../config");
const { getCurrentBahrainTime } = require("../market-hours"); // ← P0 FIX

// ── Phase A: cheap pre-filter, no extra API calls ───────────────────────────
function prefilterCandidates(quotesBySymbol) {
  const survivors = [];
  for (const [symbol, quote] of Object.entries(quotesBySymbol || {})) {
    if (!quote || !quote.currentPrice) continue;
    // v5.4: eToro's cheap batched quote path (rates + closing-price) can't
    // supply volumeRatio without an extra per-symbol candles call — so at
    // THIS stage it's null (unknown), not zero (actually low). Treat
    // "unknown" as passing here; the real volume check happens after
    // enrichCandidate() populates it from eToro's candle data, via the
    // score contribution in detectGapAndGo/detectBreakout/detectMomentumSurge
    // below (score-based, not a hard reject — see scoreEnrichedCandidate).
    const volumeOk =
      quote.volumeRatio == null || quote.volumeRatio >= config.minVolumeRatio;
    if (!volumeOk) continue;

    const gapPercent =
      quote.dayOpen && quote.previousClose
        ? ((quote.dayOpen - quote.previousClose) / quote.previousClose) * 100
        : 0;
    const hasGap = Math.abs(gapPercent) >= config.gapThresholdPct;
    const hasIntradayMove = Math.abs(quote.priceChangePercent || 0) >= 1.0;

    // Only worth enriching (costs API calls) if SOMETHING is moving
    if (hasGap || hasIntradayMove) {
      survivors.push({ ...quote, gapPercent });
    }
  }

  logger.info(
    `[${getCurrentBahrainTime()} Bahrain] 📡 Pre-filter: ${survivors.length} stocks moving enough to enrich`,
  );

  return survivors;
}

// ── Phase B: score a candidate AFTER enrichment (real high, VWAP, RSI) ──────
function detectGapAndGo(candidate) {
  const absoluteGap = Math.abs(candidate.gapPercent || 0);
  if (absoluteGap < config.gapThresholdPct) return null;
  const direction = candidate.gapPercent > 0 ? "UP" : "DOWN";
  // Only trade gap-UPs long (this bot is long-only)
  if (direction !== "UP") return null;
  // Gap must be holding (price still near/above open)
  if (candidate.currentPrice < candidate.dayOpen * 0.995) return null;
  return {
    setup: "GAP_AND_GO",
    score: Math.min(100, absoluteGap * 8 + (candidate.volumeRatio || 1) * 10),
    detail:
      "Gapped up " +
      absoluteGap.toFixed(1) +
      "% on " +
      (candidate.volumeRatio || 0).toFixed(1) +
      "x volume, holding above open",
  };
}

function detectBreakout(candidate) {
  if (!candidate.recentIntradayHigh || !candidate.currentPrice) return null;
  const breakoutMargin =
    ((candidate.currentPrice - candidate.recentIntradayHigh) /
      candidate.recentIntradayHigh) *
    100;
  // fresh breakout above the real intraday high, not already extended
  if (breakoutMargin <= 0 || breakoutMargin > 3) return null;
  return {
    setup: "BREAKOUT",
    score: Math.min(
      100,
      breakoutMargin * 20 + (candidate.volumeRatio || 1) * 10,
    ),
    detail:
      "Broke above intraday high by " +
      breakoutMargin.toFixed(1) +
      "% on " +
      (candidate.volumeRatio || 0).toFixed(1) +
      "x volume",
  };
}

function detectMomentumSurge(candidate) {
  if (candidate.rsi == null) return null;
  if (
    candidate.rsi < config.rsiMomentumMin ||
    candidate.rsi > config.rsiOverextendedMax
  )
    return null;
  if ((candidate.priceChangePercent || 0) < 1.0) return null;
  return {
    setup: "MOMENTUM_SURGE",
    score: Math.min(
      100,
      (candidate.rsi - config.rsiMomentumMin) * 3 +
        (candidate.priceChangePercent || 0) * 8,
    ),
    detail:
      "RSI " +
      candidate.rsi.toFixed(0) +
      " with " +
      (candidate.priceChangePercent || 0).toFixed(1) +
      "% move on " +
      (candidate.volumeRatio || 0).toFixed(1) +
      "x volume",
  };
}

// Apply VWAP trend filter + relative strength filter + regime-aware scoring,
// then pick the best setup. Returns null if any hard filter fails.
function scoreEnrichedCandidate(candidate, spyChangePercent, regime) {
  // v5.4: the REAL volume hard-gate. prefilterCandidates() lets "unknown"
  // (null) volumeRatio through, since eToro's cheap quote path can't
  // supply it without a per-symbol candles call. By THIS stage,
  // enrichCandidate() has run and volumeRatio should be a real number
  // (from eToro candles, or Twelve Data as fallback) — now we enforce the
  // actual threshold, restoring the original hard-gate behavior at the
  // correct pipeline stage instead of losing it.
  if (
    candidate.volumeRatio != null &&
    candidate.volumeRatio < config.minVolumeRatio
  ) {
    return null;
  }

  // VWAP filter: only go long if price is above VWAP (intraday uptrend).
  if (
    config.requireAboveVwap &&
    candidate.vwap != null &&
    candidate.currentPrice < candidate.vwap
  ) {
    return null;
  }

  // Relative strength filter: candidate must be leading the market, not
  // just along for the ride. Skip the check if we don't have a SPY reading.
  const relativeStrength =
    typeof spyChangePercent === "number"
      ? (candidate.priceChangePercent || 0) - spyChangePercent
      : null;
  if (
    relativeStrength != null &&
    relativeStrength < config.minRelativeStrengthVsSpyPct
  ) {
    return null;
  }

  const setups = [
    detectGapAndGo(candidate),
    detectBreakout(candidate),
    detectMomentumSurge(candidate),
  ].filter(Boolean);
  if (setups.length === 0) return null;

  const bestSetup = setups.reduce((best, setup) =>
    setup.score > best.score ? setup : best,
  );
  // small bonus if comfortably above VWAP (stronger trend)
  const vwapBonus =
    candidate.vwap && candidate.currentPrice > candidate.vwap * 1.005 ? 5 : 0;
  // small bonus scaled to how much the stock is beating the market today
  const relativeStrengthBonus =
    relativeStrength != null
      ? Math.min(10, Math.max(0, relativeStrength * 2))
      : 0;
  // regime penalty: in CHOP, demand a stronger setup before trusting it
  const regimePenalty =
    regime && regime.regime === "CHOP" ? config.chopRegimeScoreBonus : 0;

  const finalScore = Math.min(
    100,
    Math.max(
      0,
      bestSetup.score + vwapBonus + relativeStrengthBonus - regimePenalty,
    ),
  );

  return {
    symbol: candidate.symbol,
    currentPrice: candidate.currentPrice,
    volumeRatio: candidate.volumeRatio,
    rsi: candidate.rsi,
    vwap: candidate.vwap,
    aboveVwap: candidate.vwap
      ? candidate.currentPrice >= candidate.vwap
      : null,
    relativeStrength,
    regime: regime ? regime.regime : "UNKNOWN",
    ...bestSetup,
    score: finalScore,
  };
}

module.exports = { prefilterCandidates, scoreEnrichedCandidate };
