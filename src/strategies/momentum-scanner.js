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
const sectorMap = require("./sector-map"); // v5.5: for sector-rotation bucket lookup

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

// v5.6.1 BUG FIX: every setup-detail string below used to do
// `(candidate.volumeRatio || 0).toFixed(1) + "x volume"` — when volumeRatio
// was genuinely UNKNOWN (null, e.g. a discovered micro-cap that doesn't
// exist on eToro's instrument list, so real volume was never fetched), this
// silently produced the literal text "0.0x volume" in the plan description
// shown to the AI screener. The AI then read "0.0x volume" as CONFIRMED
// ZERO trading activity — a genuine, scary red flag — and rejected the
// plan citing "single-print pump, zero real participation," when the true
// state was simply "we don't have this data," not "this stock traded on
// no volume." Traced directly from real rejection reasoning in the
// decision journal (IOTR/ZTG cited "0.0x volume" as their #1 reason,
// every single time, for weeks). This helper tells the truth instead.
function describeVolume(volumeRatio) {
  return volumeRatio != null
    ? volumeRatio.toFixed(1) + "x volume"
    : "volume data unavailable for this ticker";
}

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
      describeVolume(candidate.volumeRatio) +
      ", holding above open",
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
      describeVolume(candidate.volumeRatio),
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
      describeVolume(candidate.volumeRatio),
  };
}

// Apply VWAP trend filter + relative strength filter + regime-aware scoring,
// then pick the best setup. Returns null if any hard filter fails.
function scoreEnrichedCandidate(
  candidate,
  spyChangePercent,
  regime,
  sectorProxyChanges,
) {
  // v5.4.1: every rejection path now returns { rejected: true, rejectReason }
  // instead of a bare null — the journal was logging one vague
  // "failed VWAP/RS/setup scoring" for FOUR different possible causes
  // (volume, VWAP, relative strength, no setup detected), which made a
  // real bug (the volumeRatio miscalibration below) invisible in the logs
  // for a full trading day before it was traced by hand. Never again —
  // callers should check result.rejected and log result.rejectReason.

  // v5.4: the REAL volume gate — but v5.8: HARD only for DISCOVERED names.
  // Measured live on 2026-07-14: NVDA computed RVOL 0.78x on a +3% semi day
  // and the 1.5x hard floor rejected the ENTIRE watchlist all afternoon,
  // every scan. Two structural reasons: (1) demanding a 1.5x SURGE means
  // ordinary strong days never qualify; (2) expected volume is pro-rata
  // linear while real volume is front-loaded at the open, so the computed
  // ratio decays below 1 by midday even on above-average days.
  // The floor's real job is catching fake moves in unknown DISCOVERED
  // tickers — hand-picked watchlist names keep volume as a SCORE input
  // (bonus for surges via the setup detectors, small penalty below-average
  // applied in the final score below) rather than a kill switch.
  const isDiscoveredCandidate = (candidate.source || "WATCHLIST") === "DISCOVERED";
  if (
    isDiscoveredCandidate &&
    candidate.volumeRatio != null &&
    candidate.volumeRatio < config.minVolumeRatio
  ) {
    return {
      rejected: true,
      rejectReason:
        "volumeRatio " +
        candidate.volumeRatio.toFixed(2) +
        "x below floor " +
        config.minVolumeRatio +
        "x (hard gate for discovered tickers)",
    };
  }

  // VWAP filter: only go long if price is above VWAP (intraday uptrend).
  if (
    config.requireAboveVwap &&
    candidate.vwap != null &&
    candidate.currentPrice < candidate.vwap
  ) {
    return { rejected: true, rejectReason: "below VWAP" };
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
    return {
      rejected: true,
      rejectReason:
        "relative strength " +
        relativeStrength.toFixed(2) +
        "pts below floor " +
        config.minRelativeStrengthVsSpyPct +
        "pts",
    };
  }

  const setups = [
    detectGapAndGo(candidate),
    detectBreakout(candidate),
    detectMomentumSurge(candidate),
  ].filter(Boolean);
  if (setups.length === 0) {
    return {
      rejected: true,
      rejectReason: "no gap/breakout/momentum setup detected",
    };
  }

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

  // v5.8: below-average volume is a score PENALTY for watchlist names (the
  // hard floor above only applies to discovered tickers). A move on thin
  // participation is less trustworthy — but not auto-disqualifying for a
  // hand-picked liquid name. 10 points at 0.99x, scaling to 20 at 0.5x.
  const lowVolumePenalty =
    !isDiscoveredCandidate &&
    candidate.volumeRatio != null &&
    candidate.volumeRatio < 1.0
      ? Math.min(20, 10 + (1.0 - candidate.volumeRatio) * 20)
      : 0;

  // v5.5: SECTOR ROTATION bonus — "if oil is up, Chevron should follow."
  // A scoring TILT (like the RS bonus above), not a hard gate — a
  // candidate in a hot sector gets a nudge, but still has to clear every
  // other real filter on its own. Only applies if this candidate's static
  // sector bucket is one of the mapped proxies (see sector-rotation.js)
  // AND that proxy is actually configured/known this scan.
  let sectorRotationBonus = 0;
  if (sectorProxyChanges) {
    const candidateBucket = sectorMap.getStaticBucket(candidate.symbol);
    const proxyChangePercent = candidateBucket
      ? sectorProxyChanges[candidateBucket]
      : null;
    if (
      proxyChangePercent != null &&
      proxyChangePercent >= config.sectorRotationMinChangePct
    ) {
      sectorRotationBonus = Math.min(
        config.sectorRotationMaxBonus,
        proxyChangePercent * 4,
      );
    }
  }

  const finalScore = Math.min(
    100,
    Math.max(
      0,
      bestSetup.score +
        vwapBonus +
        relativeStrengthBonus +
        sectorRotationBonus -
        regimePenalty -
        lowVolumePenalty,
    ),
  );

  return {
    rejected: false,
    symbol: candidate.symbol,
    currentPrice: candidate.currentPrice,
    volumeRatio: candidate.volumeRatio,
    rsi: candidate.rsi,
    vwap: candidate.vwap,
    aboveVwap: candidate.vwap ? candidate.currentPrice >= candidate.vwap : null,
    relativeStrength,
    sectorRotationBonus, // v5.5: visible in the journal for later analysis
    regime: regime ? regime.regime : "UNKNOWN",
    ...bestSetup,
    score: finalScore,
  };
}

module.exports = { prefilterCandidates, scoreEnrichedCandidate };
