// src/strategies/trade-planner.js
//
// v5.1 (2026-07-04): TRADE ARCHETYPES. The review's §4 proposed replacing
// the pure mechanical DAY/SWING split with catalyst-aware archetypes so a
// stock's classification reflects WHY it's interesting, not just its
// volatility/regime stats. Kept backward-compatible — the exit engine
// still only knows DAY/SWING — but an `archetype` field is now computed,
// and a genuine catalyst (fresh analyst upgrade or insider buy from
// discovery, via candidate.catalyst) can unlock SWING even when the
// mechanical disqualifiers would otherwise force DAY. Deliberately
// narrow: only a REAL discovery catalyst overrides, never the AI's opinion
// alone — keeps "AI sets no prices, code decides geometry" intact.
//
//   MOMENTUM_BREAKOUT      — GAP_AND_GO / BREAKOUT / MOMENTUM_SURGE, no
//                            catalyst. Same as v4's DAY-biased path.
//   NEWS_CATALYST          — candidate.catalyst is ANALYST_UPGRADE or
//                            INSIDER_BUY — these persist beyond one
//                            session, so they get a real shot at SWING.
//   MOMENTUM_CONTINUATION  — no catalyst, but every mechanical SWING
//                            criterion is met — the old "trend
//                            persistence" path from v4.
//
// v4 NEW MODULE — the strategy brain. For every scored candidate this builds
// a complete, professional trade plan BEFORE any AI call or order:
//
//   1. CLASSIFY: DAY (intraday exit) or SWING (1-10 day hold)
//   2. VOLATILITY BUCKET: LOW / MEDIUM / HIGH from daily ATR% of price
//   3. GEOMETRY: ATR-scaled stop + T1/T2 (day) or T1/T2/T3 (swing)
//   4. SIZE: risk-based — dollars risked = capital × risk% × drawdown
//      multiplier; position = risk ÷ stop distance, capped per trade type
//   5. RRR: reject any plan whose reward:risk is below the configured floor
//      — bad-geometry setups never even reach the AI screener
//
// The plan object it returns is the single source of truth for the trade:
// the AI screener sees it, the order uses its levels, the exit engine
// enforces them, the journal records them.
require("dotenv").config();
const { logger } = require("../logger");
const config = require("../config");
const { escapeHtml, humanize } = require("../notifications/format-helpers");

// ── Trend read (bullish / bearish / sideways) ──────────────────────────────
function classifyTrend(candidate, spyChangePercent, regime) {
  const aboveVwap = candidate.aboveVwap === true;
  const strongRelativeStrength =
    (candidate.relativeStrength || 0) >= config.minRelativeStrengthVsSpyPct;
  const marketUp = (spyChangePercent || 0) > 0;

  if (regime && regime.regime === "CHOP") return "SIDEWAYS";
  if (aboveVwap && strongRelativeStrength && marketUp) return "BULLISH";
  if (!aboveVwap && (candidate.priceChangePercent || 0) < 0) return "BEARISH";
  return "SIDEWAYS";
}

// ── Volatility bucket from daily ATR as a % of price ───────────────────────
function classifyVolatility(atrPercent) {
  if (atrPercent == null) return "MEDIUM"; // unknown → assume medium, no bonus
  if (atrPercent >= config.highVolAtrPct) return "HIGH";
  if (atrPercent <= config.lowVolAtrPct) return "LOW";
  return "MEDIUM";
}

// ── DAY vs SWING classification ────────────────────────────────────────────
// A swing hold is only justified when the strength is likely to PERSIST
// beyond today. Rules (first disqualifier wins):
//   - HIGH volatility → DAY (overnight gap risk in a 5%+ ATR name is not
//     acceptable on a small account)
//   - GAP_AND_GO setups → DAY (gaps are intraday plays; most fade or fill)
//   - Thu/Fri (ET) entries → DAY (mandatory Friday close leaves no room for
//     a swing to develop — config.swingEntryDaysET, default Mon-Wed)
//   - CHOP regime → DAY (no trend to ride overnight)
//   - RSI > 70 → DAY (already extended; overnight continuation is a coin flip)
//   - weak relative strength or below VWAP → DAY
function classifyTradeType(candidate, regime, easternWeekday) {
  const disqualifiers = [];
  // v5.2: NEWS_HIT (added by discovery's news-catalyst tagging) is
  // DIRECTIONALLY UNKNOWN — we only checked that a headline exists, not
  // its sentiment. It's worth labeling for the journal/AI screener, but
  // it must NOT get the same "override the mechanical disqualifiers"
  // trust as ANALYST_UPGRADE/INSIDER_BUY, which are bullish by
  // construction (an upgrade or an open-market buy is an unambiguous
  // positive signal; a random headline is not).
  const hasVerifiedBullishCatalyst =
    candidate.catalyst === "ANALYST_UPGRADE" ||
    candidate.catalyst === "INSIDER_BUY";
  const hasAnyCatalystLabel = !!candidate.catalyst;

  // High volatility and late-week entry are HARD disqualifiers even for a
  // real catalyst — an unhedged 5%+ ATR overnight hold or a swing with no
  // runway before Friday's mandatory close is a bad idea regardless of WHY
  // the stock is interesting.
  if (classifyVolatility(candidate.atrPercent) === "HIGH")
    disqualifiers.push("high volatility — no overnight risk");
  if (!config.swingEntryDaysET.includes(easternWeekday))
    disqualifiers.push("late-week entry — no room before Friday close");

  if (hasVerifiedBullishCatalyst) {
    // v5.1: a genuine, DIRECTIONALLY-VERIFIED catalyst (analyst upgrade /
    // insider buy) is allowed to override the mechanical/technical
    // disqualifiers below.
    if (candidate.setup === "GAP_AND_GO") {
      disqualifiers.push("gap setups are intraday plays even with a catalyst");
    }
    if (disqualifiers.length === 0) {
      return {
        tradeType: "SWING",
        reason: "catalyst override (" + candidate.catalyst + ")",
        archetype: "NEWS_CATALYST",
      };
    }
    return {
      tradeType: "DAY",
      reason: disqualifiers[0],
      archetype: "NEWS_CATALYST",
    };
  }

  if (candidate.setup === "GAP_AND_GO")
    disqualifiers.push("gap setups are intraday plays");
  if (!regime || regime.regime !== "TRENDING")
    disqualifiers.push("regime not TRENDING");
  if (candidate.rsi != null && candidate.rsi > 70)
    disqualifiers.push("RSI extended above 70");
  if ((candidate.relativeStrength || 0) < 1.5)
    disqualifiers.push("relative strength below swing bar (1.5 pts)");
  if (candidate.aboveVwap !== true) disqualifiers.push("not above VWAP");

  if (disqualifiers.length === 0) {
    return {
      tradeType: "SWING",
      reason: "trend persistence criteria met",
      // v5.2: a NEWS_HIT that ALSO happens to clear every mechanical
      // swing bar earns the NEWS_CATALYST label for reporting — it still
      // had to pass the real criteria, it just gets credit for why.
      archetype: hasAnyCatalystLabel ? "NEWS_CATALYST" : "MOMENTUM_CONTINUATION",
    };
  }
  return {
    tradeType: "DAY",
    reason: disqualifiers[0],
    archetype: hasAnyCatalystLabel ? "NEWS_CATALYST" : "MOMENTUM_BREAKOUT",
  };
}

// ── Stop distance: ATR-scaled with honest clamps ───────────────────────────
function computeStopDistancePct(tradeType, atrPercent) {
  if (tradeType === "SWING") {
    const raw =
      atrPercent != null
        ? (atrPercent / 100) * config.swingAtrStopMultiple
        : config.swingStopClampMinPct * 1.5; // no ATR → mid-range fallback
    return Math.min(
      config.swingStopClampMaxPct,
      Math.max(config.swingStopClampMinPct, raw),
    );
  }
  const raw =
    atrPercent != null
      ? (atrPercent / 100) * config.dayAtrStopMultiple
      : config.stopLossPct; // no ATR → legacy 2% fallback
  return Math.min(
    config.dayStopClampMaxPct,
    Math.max(config.dayStopClampMinPct, raw),
  );
}

// ── Build the full plan ─────────────────────────────────────────────────────
// Inputs:
//   candidate       — scored candidate (currentPrice, setup, rsi, vwap,
//                     relativeStrength, atrPercent, source, ...)
//   context         — { regime, spyChangePercent, easternWeekday }
//   capitalState    — from capital-manager: { effectiveCapital,
//                     riskMultiplier, consecutiveLosingDays }
//   openCounts      — { dayCount, swingCount } current open positions by type
//   isFirstTimeDiscovered — true if a DISCOVERED symbol never traded before
//
// Returns { accepted: true, plan } or { accepted: false, rejectReason }.
function buildTradePlan(
  candidate,
  context,
  capitalState,
  openCounts,
  isFirstTimeDiscovered,
) {
  const entryPrice = candidate.currentPrice;
  if (!entryPrice || entryPrice <= 0) {
    return { accepted: false, rejectReason: "no valid entry price" };
  }

  const {
    tradeType,
    reason: typeReason,
    archetype,
  } = classifyTradeType(
    candidate,
    { regime: context.regime },
    context.easternWeekday,
  );

  // Per-type position slot check (cheap, before any math)
  if (tradeType === "DAY" && openCounts.dayCount >= config.maxDayPositions) {
    return { accepted: false, rejectReason: "day-trade slots full" };
  }
  if (
    tradeType === "SWING" &&
    openCounts.swingCount >= config.maxSwingPositions
  ) {
    return { accepted: false, rejectReason: "swing slots full" };
  }

  const volatilityBucket = classifyVolatility(candidate.atrPercent);
  const trendDirection = classifyTrend(candidate, context.spyChangePercent, {
    regime: context.regime,
  });

  // ── Geometry ──
  const stopDistanceRawPct = computeStopDistancePct(
    tradeType,
    candidate.atrPercent,
  );
  // Slippage buffer nudges the stop slightly closer (triggers earlier) —
  // honest free-tier approximation, same convention as v3.
  const stopPrice =
    entryPrice * (1 - stopDistanceRawPct) * (1 + config.slippageBufferPct);
  const riskPerSharePct = (entryPrice - stopPrice) / entryPrice;

  const targetT1 = entryPrice * (1 + riskPerSharePct * 1.0);
  const targetT2 = entryPrice * (1 + riskPerSharePct * 2.0);
  const targetT3 =
    tradeType === "SWING" ? entryPrice * (1 + riskPerSharePct * 3.5) : null;

  // ── Reward:risk ──
  // DAY realistic reward = T2 (50% off at T1, trail the rest toward T2+).
  // SWING blended ladder: 1/3 at T1, 1/3 at T2, 1/3 at T3 →
  //   (1 + 2 + 3.5) / 3 ≈ 2.17R.
  const riskRewardRatio =
    tradeType === "SWING" ? Number(((1 + 2 + 3.5) / 3).toFixed(2)) : 2.0;

  if (riskRewardRatio < config.minRiskRewardRatio) {
    return {
      accepted: false,
      rejectReason:
        "RRR " + riskRewardRatio + " below floor " + config.minRiskRewardRatio,
    };
  }

  // ── Risk-based sizing ──
  const riskPct =
    tradeType === "SWING" ? config.riskPctSwing : config.riskPctDay;
  const riskMultiplier = capitalState.riskMultiplier || 1;
  const volatilityMultiplier =
    volatilityBucket === "HIGH" ? config.highVolSizeMultiplier : 1;
  const discoveryMultiplier = isFirstTimeDiscovered
    ? config.discoveryFirstTradeSizeMultiplier
    : 1;

  const riskDollars =
    capitalState.effectiveCapital *
    riskPct *
    riskMultiplier *
    volatilityMultiplier *
    discoveryMultiplier;

  const maxPositionPct =
    tradeType === "SWING"
      ? config.maxPositionPctSwing
      : config.maxPositionPctDay;

  let positionDollars = riskDollars / riskPerSharePct;
  positionDollars = Math.min(
    positionDollars,
    capitalState.effectiveCapital * maxPositionPct,
  );
  positionDollars = Math.round(positionDollars / 5) * 5; // small-account rounding

  if (positionDollars < config.minimumPositionDollars) {
    return {
      accepted: false,
      rejectReason:
        "sized position $" +
        positionDollars +
        " below minimum $" +
        config.minimumPositionDollars,
    };
  }

  // Actual dollars at risk after the position cap may have shrunk the size:
  const actualRiskDollars = positionDollars * riskPerSharePct;
  const actualRiskPctOfCapital =
    (actualRiskDollars / capitalState.effectiveCapital) * 100;
  const expectedReturnDollars = actualRiskDollars * riskRewardRatio;

  const plan = {
    symbol: candidate.symbol,
    tradeType, // "DAY" | "SWING"
    tradeTypeReason: typeReason,
    archetype, // "MOMENTUM_BREAKOUT" | "NEWS_CATALYST" | "MOMENTUM_CONTINUATION"
    catalyst: candidate.catalyst || null, // "ANALYST_UPGRADE" | "INSIDER_BUY" | null
    catalystLabel: candidate.catalystLabel || null,
    source: candidate.source || "WATCHLIST", // "WATCHLIST" | "DISCOVERED"
    isFirstTimeDiscovered: !!isFirstTimeDiscovered,
    setup: candidate.setup,
    setupDetail: candidate.detail,
    score: candidate.score,

    // Market context at plan time
    regime: context.regime,
    trendDirection,
    volatilityBucket,
    atrPercent: candidate.atrPercent != null ? candidate.atrPercent : null,
    spyChangePercent: context.spyChangePercent,
    relativeStrength: candidate.relativeStrength,
    rsi: candidate.rsi,
    aboveVwap: candidate.aboveVwap,

    // Geometry
    entryPrice: Number(entryPrice.toFixed(4)),
    stopPrice: Number(stopPrice.toFixed(4)),
    stopDistancePct: Number((riskPerSharePct * 100).toFixed(2)),
    targetT1: Number(targetT1.toFixed(4)),
    targetT2: Number(targetT2.toFixed(4)),
    targetT3: targetT3 != null ? Number(targetT3.toFixed(4)) : null,
    // Swing trailing % (used after T2): 1×ATR%, clamped 2-6%
    swingTrailPct:
      tradeType === "SWING"
        ? Number(
            Math.min(
              0.06,
              Math.max(0.02, (candidate.atrPercent || 3) / 100),
            ).toFixed(4),
          )
        : null,

    // v5.1: liquidity check input — null if unavailable (guard doesn't
    // block on unknown, only on a CONFIRMED thin market)
    averageDollarVolume:
      candidate.averageVolume != null
        ? Number((candidate.averageVolume * entryPrice).toFixed(0))
        : null,

    // Risk & sizing
    positionDollars,
    riskDollars: Number(actualRiskDollars.toFixed(2)),
    riskPctOfCapital: Number(actualRiskPctOfCapital.toFixed(2)),
    expectedReturnDollars: Number(expectedReturnDollars.toFixed(2)),
    riskRewardRatio,
    sizingBreakdown: {
      effectiveCapital: capitalState.effectiveCapital,
      baseRiskPct: riskPct,
      drawdownMultiplier: riskMultiplier,
      volatilityMultiplier,
      discoveryMultiplier,
    },

    plannedAt: new Date().toISOString(),
  };

  logger.info(
    "📋 Plan " +
      plan.symbol +
      " [" +
      plan.tradeType +
      "/" +
      plan.source +
      "/" +
      plan.archetype +
      (plan.catalyst ? " · " + plan.catalyst : "") +
      "] $" +
      plan.positionDollars +
      " | risk $" +
      plan.riskDollars +
      " (" +
      plan.riskPctOfCapital +
      "%) | stop -" +
      plan.stopDistancePct +
      "% | T1 $" +
      plan.targetT1 +
      " T2 $" +
      plan.targetT2 +
      (plan.targetT3 ? " T3 $" + plan.targetT3 : "") +
      " | RRR " +
      plan.riskRewardRatio +
      " | vol " +
      plan.volatilityBucket,
  );

  return { accepted: true, plan };
}

// Human summary for Telegram (the required trade output format). HTML parse
// mode — plain text needs no escaping except the freeform AI reasoning.
function formatPlanForTelegram(plan, aiReasoning) {
  const money = (value) => "$" + Number(value).toFixed(2);
  const titleLine =
    "🟢 <b>OPEN " +
    plan.symbol +
    "</b> — " +
    plan.tradeType +
    " · " +
    humanize(plan.source) +
    (plan.isFirstTimeDiscovered ? " · first trade, half size" : "");

  const setupLine =
    "<b>Setup:</b> " +
    humanize(plan.setup) +
    " (" +
    humanize(plan.archetype) +
    ")\n" +
    humanize(plan.volatilityBucket) +
    " vol · " +
    humanize(plan.trendDirection) +
    " · " +
    humanize(plan.regime) +
    " market";

  const catalystLine = plan.catalystLabel
    ? "\n📰 " + escapeHtml(plan.catalystLabel)
    : "";

  const entryLine =
    "\n\nEntry " +
    money(plan.entryPrice) +
    " → Stop " +
    money(plan.stopPrice) +
    " (-" +
    plan.stopDistancePct +
    "%)\n" +
    "Size " +
    money(plan.positionDollars) +
    " · Risk " +
    money(plan.riskDollars) +
    " (" +
    plan.riskPctOfCapital +
    "% of capital)";

  const targetsLine =
    "\n🎯 Target 1: " +
    money(plan.targetT1) +
    " (sell half) · Target 2: " +
    money(plan.targetT2) +
    (plan.targetT3 ? " · Target 3: " + money(plan.targetT3) : "") +
    "\nReward vs risk: " +
    plan.riskRewardRatio +
    ":1";

  const expectedLine =
    "\n\nExpected profit if it works: +" +
    money(plan.expectedReturnDollars);

  const aiLine = aiReasoning
    ? "\n\n<i>" + escapeHtml(aiReasoning) + "</i>"
    : "";

  return (
    titleLine +
    "\n" +
    setupLine +
    catalystLine +
    entryLine +
    targetsLine +
    expectedLine +
    aiLine
  );
}

module.exports = {
  buildTradePlan,
  classifyTradeType,
  classifyVolatility,
  classifyTrend,
  formatPlanForTelegram,
};
