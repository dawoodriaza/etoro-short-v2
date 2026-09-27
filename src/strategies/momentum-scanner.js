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
    // v7.7: was hardcoded at 1.0%. Forensic audit of 172 trades found this
    // single number was the main driver of the bot's selection bias — a
    // stock had to already be moving 1% intraday before it was even
    // enriched with indicators. Semis (7.58% avg ATR) clear that on most
    // days; mega-caps (3.57%) clear it occasionally, which is why the most
    // profitable bucket (+$202.99, 68% win) was only 11% of all trades.
    // Now configurable via DT_PREFILTER_MIN_MOVE_PCT.
    const hasIntradayMove =
      Math.abs(quote.priceChangePercent || 0) >= config.prefilterMinMovePct;

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
  // v7.7: was hardcoded 1.0 — see prefilterMinMovePct. Kept as its own knob
  // because the pre-filter decides who gets LOOKED AT while this decides who
  // forms a valid setup; they should be tunable independently.
  if ((candidate.priceChangePercent || 0) < config.momentumSurgeMinMovePct)
    return null;
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
  // ══════════════════════════════════════════════════════════════════════
  // v7.7 — VOLATILITY CEILING.
  //
  // The single cleanest split found across 172 closed trades:
  //     ATR <  5% : 55 trades, 56% win, +$31.13
  //     ATR >= 7% : 67 trades, 43% win, -$280.88
  //
  // The pre-filter selects for movement, movement scales with ATR, and the
  // high-ATR cohort is where the losses are concentrated. This is also what
  // makes diversification possible at all: candidates are sorted by score
  // and sliced to maxCandidates, and score itself rises with ATR — so
  // without this ceiling the calm, profitable names would rank below the
  // semis and be cut before ever reaching the AI screener.
  //
  // Rejected here (after enrichment, where real ATR is known) rather than
  // in the pre-filter, so the reason lands in the decision journal.
  // ══════════════════════════════════════════════════════════════════════
  if (
    config.maxEntryAtrPct > 0 &&
    candidate.atrPercent != null &&
    candidate.atrPercent > config.maxEntryAtrPct
  ) {
    return {
      rejected: true,
      rejectReason:
        "ATR " +
        candidate.atrPercent.toFixed(2) +
        "% exceeds the " +
        config.maxEntryAtrPct +
        "% volatility ceiling (the ATR>=7% cohort lost $280.88 over 67 trades)",
    };
  }

  // v7.7 — VOLATILITY-NORMALIZED MOVE GATE (optional, off by default).
  //
  // Requires today's move to be at least N× the stock's own average daily
  // range, instead of a flat percentage that means different things on a
  // 3.5% ATR mega-cap and a 7.5% ATR semiconductor. Historically the
  // ratio>=1.0 cohort was the only profitable one: 45 trades, 62% win,
  // +$315.48 — versus losses in every band below it.
  //
  // Disabled by default (see config) because it cuts trade count ~74%.
  if (
    config.minMoveToAtrRatio > 0 &&
    candidate.atrPercent != null &&
    candidate.atrPercent > 0 &&
    typeof candidate.priceChangePercent === "number"
  ) {
    const moveToAtr =
      Math.abs(candidate.priceChangePercent) / candidate.atrPercent;
    if (moveToAtr < config.minMoveToAtrRatio) {
      return {
        rejected: true,
        rejectReason:
          "move " +
          candidate.priceChangePercent.toFixed(2) +
          "% is only " +
          moveToAtr.toFixed(2) +
          "x this stock's own " +
          candidate.atrPercent.toFixed(2) +
          "% daily range (needs " +
          config.minMoveToAtrRatio +
          "x — sub-1x moves lost money in every historical band)",
      };
    }
  }

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

// ══════════════════════════════════════════════════════════════════════
// v8.4 — TREND SCORE V2 (logged beside the live score; NOT used for any
// trading decision yet).
//
// Why: the live score is (RSI-55)*3 + dayChange*8 + bonuses. It is driven by
// 5-minute RSI(14), which swings a stock holding +4% between 40 and 100 from
// one scan to the next, treats RSI > 78 as "no setup" exactly when a move is
// strongest, and measures the move only against yesterday's close, so a
// gap-down that rallies hard (AMD 2026-09-14: -6% open, +3.7% off the low)
// reads as weak all day.
//
// V2 reads the last hour of COMPLETED 5-minute bars of today's (ET) session:
//   holdingAboveVwap  25 x share of the last hour's bars closing above VWAP
//   hourMomentum      25 x min(1, hour's rise in daily-ATR units / 0.4)
//   rallyUnderWay     15 x min(1, rise from today's low in ATR units / 0.6)
//   beatingSpy        15 x min(1, (stock hour % - SPY hour %) / 1.0)  [7.5 if SPY unknown]
//   higherLows        10 x (rising lows across three 20-minute windows, 0-2) / 2
//   roomLeft          10 x (1 - clamp((rise from low in ATR - 1.0) / 1.0))
//   stretchPenalty   -20 x clamp((distance above VWAP in ATR - 0.6) / 0.6)
// Hard zero: price not above VWAP, or not higher than an hour ago.
// Every constant above was fixed BEFORE any replay of V2 was run
// (2026-09-17). Pre-registered test: CHANGELOG v8.4.
// ══════════════════════════════════════════════════════════════════════
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const EASTERN_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
// Memoised per 5-minute bucket (ET midnight falls on a bucket boundary), so
// scoring many candidates does not re-format the same bar dates each scan.
const easternDateCache = new Map();
const easternDateOfMs = (ms) => {
  const bucket = Math.floor(ms / FIVE_MINUTES_MS);
  let date = easternDateCache.get(bucket);
  if (date === undefined) {
    date = EASTERN_DATE.format(new Date(bucket * FIVE_MINUTES_MS));
    if (easternDateCache.size > 20000) easternDateCache.clear();
    easternDateCache.set(bucket, date);
  }
  return date;
};
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const roundTo = (value, digits) =>
  value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));

// Today's completed bars (chronological), their running VWAP, and the close
// of the last bar that had ENDED an hour before `nowMs`.
function summarizeSessionBars(bars, nowMs, barMs) {
  const today = easternDateOfMs(nowMs);
  const dayBars = (bars || [])
    .filter((bar) => Number.isFinite(bar.t) && Number.isFinite(bar.c) && bar.t + barMs <= nowMs && easternDateOfMs(bar.t) === today)
    .sort((a, b) => a.t - b.t);
  let priceVolume = 0;
  let volume = 0;
  let typicalSum = 0;
  const runningVwap = dayBars.map((bar, index) => {
    const typical = (bar.h + bar.l + bar.c) / 3;
    priceVolume += typical * (bar.v || 0);
    volume += bar.v || 0;
    typicalSum += typical;
    return volume > 0 ? priceVolume / volume : typicalSum / (index + 1);
  });
  const hourAgoBars = dayBars.filter((bar) => bar.t + barMs <= nowMs - HOUR_MS);
  const hourAgoClose = hourAgoBars.length ? hourAgoBars[hourAgoBars.length - 1].c : dayBars.length ? dayBars[0].o : null;
  return { dayBars, runningVwap, hourAgoClose };
}

function extractTrendFeatures({ bars, nowMs, price, previousClose, atrPercent, spyBars, spyPrice, barMs = FIVE_MINUTES_MS }) {
  if (!(atrPercent > 0) || !Number.isFinite(nowMs)) return null;
  const session = summarizeSessionBars(bars, nowMs, barMs);
  if (session.dayBars.length < 6) return null;
  const { dayBars, runningVwap, hourAgoClose } = session;
  const lastBar = dayBars[dayBars.length - 1];
  const currentPrice = price > 0 ? price : lastBar.c;
  const atrFraction = atrPercent / 100;
  const dayLow = Math.min(...dayBars.map((bar) => bar.l), currentPrice);
  const dayHigh = Math.max(...dayBars.map((bar) => bar.h), currentPrice);
  const vwap = runningVwap[runningVwap.length - 1];

  const lastHour = dayBars.map((bar, index) => ({ bar, vwap: runningVwap[index] })).filter(({ bar }) => bar.t >= nowMs - HOUR_MS);
  const aboveVwapShare = lastHour.length ? lastHour.filter(({ bar, vwap: barVwap }) => bar.c >= barVwap).length / lastHour.length : null;

  // Lowest low in each of three 20-minute windows of the last hour.
  const windowLows = [0, 1, 2].map((windowIndex) => {
    const from = nowMs - HOUR_MS + windowIndex * 20 * 60000;
    const inWindow = dayBars.filter((bar) => bar.t >= from && bar.t < from + 20 * 60000);
    return inWindow.length ? Math.min(...inWindow.map((bar) => bar.l)) : null;
  });
  let higherLows = 0;
  for (let k = 1; k < 3; k++) {
    if (windowLows[k] != null && windowLows[k - 1] != null && windowLows[k] > windowLows[k - 1]) higherLows++;
  }

  const hourChangePct = hourAgoClose > 0 ? (currentPrice / hourAgoClose - 1) * 100 : null;
  let spyHourChangePct = null;
  if (Array.isArray(spyBars) && spyBars.length) {
    const spySession = summarizeSessionBars(spyBars, nowMs, barMs);
    const spyNow = spyPrice > 0 ? spyPrice : spySession.dayBars.length ? spySession.dayBars[spySession.dayBars.length - 1].c : null;
    if (spySession.hourAgoClose > 0 && spyNow > 0) spyHourChangePct = (spyNow / spySession.hourAgoClose - 1) * 100;
  }

  return {
    sessionBars: dayBars.length,
    price: roundTo(currentPrice, 4),
    dayOpen: roundTo(dayBars[0].o, 4),
    dayLow: roundTo(dayLow, 4),
    dayHigh: roundTo(dayHigh, 4),
    vwap: roundTo(vwap, 4),
    changeVsPreviousClosePct: previousClose > 0 ? roundTo((currentPrice / previousClose - 1) * 100, 3) : null,
    moveFromOpenPct: roundTo((currentPrice / dayBars[0].o - 1) * 100, 3),
    rallyFromLowAtr: roundTo((currentPrice / dayLow - 1) / atrFraction, 3),
    hourChangePct: roundTo(hourChangePct, 3),
    hourChangeAtr: hourChangePct != null ? roundTo(hourChangePct / atrPercent, 3) : null,
    spyHourChangePct: roundTo(spyHourChangePct, 3),
    hourVsSpyPct: hourChangePct != null && spyHourChangePct != null ? roundTo(hourChangePct - spyHourChangePct, 3) : null,
    aboveVwapShareLastHour: roundTo(aboveVwapShare, 3),
    higherLowsLastHour: higherLows,
    vwapStretchAtr: vwap > 0 ? roundTo((currentPrice / vwap - 1) / atrFraction, 3) : null,
    dayRangeAtr: roundTo((dayHigh / dayLow - 1) / atrFraction, 3),
  };
}

function scoreTrendV2(features) {
  if (!features) return { score: null, reason: "not enough completed bars today", components: null };
  if (!(features.price > features.vwap)) return { score: 0, reason: "not above VWAP", components: null };
  if (!(features.hourChangePct > 0)) return { score: 0, reason: "not higher than an hour ago", components: null };
  const components = {
    holdingAboveVwap: 25 * (features.aboveVwapShareLastHour || 0),
    hourMomentum: 25 * clamp01(features.hourChangeAtr / 0.4),
    rallyUnderWay: 15 * clamp01(features.rallyFromLowAtr / 0.6),
    beatingSpy: features.hourVsSpyPct == null ? 7.5 : 15 * clamp01(features.hourVsSpyPct / 1.0),
    higherLows: 10 * ((features.higherLowsLastHour || 0) / 2),
    roomLeft: 10 * (1 - clamp01((features.rallyFromLowAtr - 1.0) / 1.0)),
    stretchPenalty: -20 * clamp01((features.vwapStretchAtr - 0.6) / 0.6),
  };
  const total = Object.values(components).reduce((sum, value) => sum + value, 0);
  const rounded = {};
  for (const [key, value] of Object.entries(components)) rounded[key] = roundTo(value, 1);
  return { score: roundTo(Math.max(0, Math.min(100, total)), 1), reason: null, components: rounded };
}

module.exports = { prefilterCandidates, scoreEnrichedCandidate, extractTrendFeatures, scoreTrendV2 };
