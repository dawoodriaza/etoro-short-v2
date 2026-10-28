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
const {
  escapeHtml,
  humanize,
  toRealDollars,
  formatDualAmount,
} = require("../notifications/format-helpers");

// ── Trend read (bullish / bearish / sideways) ──────────────────────────────
function classifyTrend(candidate, spyChangePercent, regime) {
  const aboveVwap = candidate.aboveVwap === true;
  const strongRelativeStrength =
    (candidate.relativeStrength || 0) >= config.minRelativeStrengthVsSpyPct;

  if (regime && regime.regime === "CHOP") return "SIDEWAYS";
  // v8.3: relative strength already measures the stock AGAINST SPY. Also
  // requiring SPY itself to be green labelled every stock rising above VWAP
  // while beating a flat/red market as SIDEWAYS — the AI screener's most
  // common SKIP reason Sep 14-16 (MSFT x4, SNAP, AMD, ANET...) and an
  // automatic SKIP outside regular hours ("trend read is SIDEWAYS").
  if (aboveVwap && strongRelativeStrength) return "BULLISH";
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
  options = {}, // v9.2: { ignoreScoreFloor, quiet } — used only by the paper book
) {
  const entryPrice = candidate.currentPrice;
  if (!entryPrice || entryPrice <= 0) {
    return { accepted: false, rejectReason: "no valid entry price" };
  }

  // ══════════════════════════════════════════════════════════════════════
  // v7.4 — MINIMUM CONVICTION SCORE.
  //
  // The single highest-impact filter found in the 114-trade audit. Every
  // score band below 80 lost money; the three of them cost $476.24 while
  // the 80+ band made $166.68. The system was already computing this
  // number at entry and trading against it anyway.
  //
  // Rejected here rather than later so the reason is named in the decision
  // journal — a silent filter is one nobody can evaluate afterwards.
  // ══════════════════════════════════════════════════════════════════════
  if (
    !options.ignoreScoreFloor &&
    config.minEntryScore > 0 &&
    typeof candidate.score === "number" &&
    candidate.score < config.minEntryScore
  ) {
    return {
      accepted: false,
      rejectReason:
        // v7.11: one decimal, not toFixed(0) — a rejected 79.6 printed as
        // "score 80 below the entry floor of 80", which reads as an
        // off-by-one bug that isn't there.
        "score " +
        candidate.score.toFixed(1) +
        " below the entry floor of " +
        config.minEntryScore +
        // v8.3: the old "(every score band under 80 lost money across 114
        // audited trades)" is no longer true — see config.minEntryScore.
        " (desk-score floor; the 2026-09-16 recheck found no score band that wins consistently — CHANGELOG v8.3)",
    };
  }

  let {
    tradeType,
    reason: typeReason,
    archetype,
  } = classifyTradeType(
    candidate,
    { regime: context.regime },
    context.easternWeekday,
  );

  // ══════════════════════════════════════════════════════════════════════
  // v7.11 BUG FIX — SWING CAPACITY DOWNGRADES, IT DOES NOT DISCARD.
  //
  // classifyTradeType returns SWING only when a candidate passes EVERY
  // trend-persistence bar (TRENDING regime, RSI under 70, relative
  // strength >= 1.5, above VWAP). Failing any one of them already
  // downgrades it to DAY, which then trades normally.
  //
  // So the old "swing slots full -> reject" branch inverted the quality
  // filter: with DT_MAX_SWING_POSITIONS=0 (swings paused since the v7.7
  // forensics) the check `0 >= 0` was true for EVERY swing-qualified
  // candidate, meaning the best setups of the day were thrown away while
  // weaker ones proceeded. Observed live on 2026-09-01 — MMED and CRK
  // rejected as "swing slots full" on six consecutive scans while the
  // bot took zero trades.
  //
  // A swing-qualified name is still a perfectly good DAY trade; it just
  // can't be HELD for days. So when swing capacity is unavailable we now
  // demote it to DAY and let the DAY slot check decide. The flag below is
  // carried into the plan and the journal so a month of live data can
  // answer "should swings be re-enabled?" with evidence.
  // ══════════════════════════════════════════════════════════════════════
  let downgradedFromSwing = false;
  if (
    tradeType === "SWING" &&
    openCounts.swingCount >= config.maxSwingPositions
  ) {
    downgradedFromSwing = true;
    tradeType = "DAY";
    typeReason =
      config.maxSwingPositions === 0
        ? "swings paused — traded as DAY (qualified: " + typeReason + ")"
        : "swing slots full — traded as DAY (qualified: " + typeReason + ")";
  }

  // Per-type position slot check (cheap, before any math)
  if (tradeType === "DAY" && openCounts.dayCount >= config.maxDayPositions) {
    return { accepted: false, rejectReason: "day-trade slots full" };
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

  // v7.7: per-symbol size multiplier from watchlist-daytrade.json. Lets a
  // name be KEPT in the universe but traded smaller — the middle option
  // between "full size" and "delete it". Used for TSLA, whose bucket lost
  // $18.59/trade across 14 trades but which is deliberately retained.
  const symbolMultiplier =
    typeof candidate.sizeMultiplier === "number" &&
    candidate.sizeMultiplier > 0 &&
    candidate.sizeMultiplier <= 1
      ? candidate.sizeMultiplier
      : 1;

  const riskDollars =
    capitalState.effectiveCapital *
    riskPct *
    riskMultiplier *
    volatilityMultiplier *
    discoveryMultiplier *
    symbolMultiplier;

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
    // v7.11: true when this cleared every SWING bar but was demoted to DAY
    // because swing capacity was unavailable. Recorded so a month of live
    // trades can answer whether swings deserve re-enabling.
    downgradedFromSwing,
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
    // v7.8 — INSTRUMENTATION FOR THE ONE-MONTH TEST.
    //
    // These were previously absent and had to be RECONSTRUCTED during the
    // 2026-08-28 forensic audit (raw move backed out of
    // relativeStrength + spyChangePercent, sector joined from the
    // watchlist file). Reconstruction only works while every input
    // survives, and it silently fails the moment one of them changes.
    // Recording them directly makes the trade log self-describing.
    //
    // moveToAtrRatio is the single strongest predictor found anywhere in
    // this system: the >=1.0 cohort was 62% win / +$315.48, while every
    // band below it lost money. It must be measurable per trade.
    priceChangePercent: candidate.priceChangePercent,
    moveToAtrRatio:
      candidate.atrPercent > 0 &&
      typeof candidate.priceChangePercent === "number"
        ? Number(
            (
              Math.abs(candidate.priceChangePercent) / candidate.atrPercent
            ).toFixed(3),
          )
        : null,

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
      symbolMultiplier, // v7.7: per-symbol override from the watchlist
    },

    plannedAt: new Date().toISOString(),
  };

  if (!options.quiet) logger.info(
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

  // Entry/Stop/Target are per-share PRICES — identical in both accounts,
  // never scaled. Size/Risk/Expected are TOTAL DOLLAR AMOUNTS — scaled to
  // what YOUR real account actually risks, via the copy ratio.
  const entryLine =
    "\n\nEntry " +
    money(plan.entryPrice) +
    " → Stop " +
    money(plan.stopPrice) +
    " (-" +
    plan.stopDistancePct +
    "%)\n" +
    // v7.3: show YOUR amount and the bot's, so a Telegram message can
    // always be reconciled against the logs/ledger (which are agent dollars).
    "Size " +
    formatDualAmount(plan.positionDollars) +
    " · Risk " +
    formatDualAmount(plan.riskDollars) +
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
    "\n\nExpected profit if it works: " +
    formatDualAmount(plan.expectedReturnDollars, { signed: true });

  const aiLine = aiReasoning
    ? "\n\n<i>" + escapeHtml(aiReasoning) + "</i>"
    : "";

  // v8.2: a dip entry says where it was approved and how much lower it bought.
  const dipLine = plan.dipEntry
    ? "\n📉 Bought on a dip: approved at " +
      money(plan.dipEntry.signalPrice) +
      ", bought at " +
      money(plan.entryPrice) +
      " (-" +
      ((1 - plan.entryPrice / plan.dipEntry.signalPrice) * 100).toFixed(2) +
      "%) after " +
      plan.dipEntry.minutesWaited +
      " min"
    : "";

  return (
    titleLine +
    dipLine +
    "\n" +
    setupLine +
    catalystLine +
    entryLine +
    targetsLine +
    expectedLine +
    aiLine
  );
}

// ══════════════════════════════════════════════════════════════════════
// v8.2 — DIP ENTRY (pure helpers; index.js owns the clock and the order).
// An approved plan becomes an order that buys only if the price dips
// depthOfStop x the stop distance below the approval price within
// windowMinutes. The plan is then moved to the fill price with the SAME stop
// percentage, so size and dollar risk are unchanged.
// ══════════════════════════════════════════════════════════════════════
function buildDipEntryOrder(plan, { depthOfStop, windowMinutes, nowMs, trailFromHigh = false }) {
  const stopFraction = plan.stopDistancePct / 100;
  const triggerPrice = plan.entryPrice * (1 - stopFraction * depthOfStop);
  return {
    symbol: String(plan.symbol).toUpperCase(),
    plan,
    signalPrice: plan.entryPrice,
    triggerPrice: Number(triggerPrice.toFixed(4)),
    // v8.6: with trailFromHigh the buy level is re-measured from the highest
    // price seen while waiting, so a stock that runs first and pulls back
    // later can still fill. stopFraction is stored because the order is
    // re-priced on every check, long after the plan was built.
    trailFromHigh: !!trailFromHigh,
    stopFraction,
    // A further full stop distance below the buy price is where the new
    // position's stop would sit — a breakdown, not a dip. Never buy there.
    breakdownPrice: Number((triggerPrice * (1 - stopFraction)).toFixed(4)),
    depthOfStop,
    windowMinutes,
    armedAtMs: nowMs,
    expiresAtMs: nowMs + windowMinutes * 60000,
    lowestPrice: plan.entryPrice,
    highestPrice: plan.entryPrice,
    lastPrice: plan.entryPrice,
    quoteMisses: 0, // minutes with no usable quote (the order could not be checked)
    checkFailures: 0, // minutes the whole dip check crashed
  };
}

// v8.6: the buy level, re-measured on every check. With trailFromHigh it sits
// one dip below the highest price seen since approval, but is never allowed
// above the approval price itself - the bot buys a pullback, and will still
// take the stock if it comes back to where it was spotted, but never pays up
// to chase it.
function dipLevels(order) {
  const stopFraction =
    order.stopFraction != null ? order.stopFraction : (order.plan.stopDistancePct || 0) / 100;
  const dip = 1 - stopFraction * order.depthOfStop;
  const trigger = order.trailFromHigh
    ? Math.min(order.highestPrice * dip, order.signalPrice)
    : order.signalPrice * dip;
  return {
    triggerPrice: Number(trigger.toFixed(4)),
    // A further full stop distance below the buy level is a breakdown, not a
    // dip. It moves with the trigger so the guard keeps the same meaning.
    breakdownPrice: Number((trigger * (1 - stopFraction)).toFixed(4)),
  };
}

// askPrice null = no usable quote this minute (the order just waits).
function evaluateDipEntry(order, askPrice, nowMs) {
  if (Number.isFinite(askPrice) && askPrice > 0) {
    order.lastPrice = askPrice;
    order.lowestPrice = Math.min(order.lowestPrice, askPrice);
    order.highestPrice = Math.max(order.highestPrice, askPrice);
    if (order.trailFromHigh) {
      const levels = dipLevels(order);
      order.triggerPrice = levels.triggerPrice;
      order.breakdownPrice = levels.breakdownPrice;
    }
    if (askPrice <= order.breakdownPrice) {
      return { action: "CANCEL", reason: "fell through $" + order.breakdownPrice + " — a breakdown, not a dip" };
    }
    if (askPrice <= order.triggerPrice) return { action: "FILL", price: askPrice };
  } else {
    order.quoteMisses = (order.quoteMisses || 0) + 1;
  }
  if (nowMs >= order.expiresAtMs) return { action: "EXPIRE" };
  return { action: "WAIT" };
}

function rebasePlanToFill(plan, fillPrice) {
  const ratio = fillPrice / plan.entryPrice;
  const scale = (value) => (typeof value === "number" ? Number((value * ratio).toFixed(4)) : value);
  return {
    ...plan,
    entryPrice: Number(fillPrice.toFixed(4)),
    stopPrice: scale(plan.stopPrice),
    targetT1: scale(plan.targetT1),
    targetT2: scale(plan.targetT2),
    targetT3: scale(plan.targetT3),
  };
}

// The DIP_ENTRY journal record. deepestDipOfStop is how far the price fell
// below the approval price, in stop distances — what lets the depth setting
// be re-tuned from live data (a 0.5 setting would have filled every order
// with deepestDipOfStop >= 0.5).
function describeDipEntryOrder(order, nowMs) {
  const stopFraction = (order.plan.stopDistancePct || 0) / 100;
  const deepestDip =
    order.signalPrice > 0 && stopFraction > 0
      ? (order.signalPrice - order.lowestPrice) / (order.signalPrice * stopFraction)
      : null;
  return {
    symbol: order.symbol,
    signalPrice: order.signalPrice,
    triggerPrice: order.triggerPrice,
    breakdownPrice: order.breakdownPrice,
    depthOfStop: order.depthOfStop,
    trailFromHigh: !!order.trailFromHigh,
    windowMinutes: order.windowMinutes,
    armedAt: new Date(order.armedAtMs).toISOString(),
    minutesWaited: Math.round((nowMs - order.armedAtMs) / 60000),
    lowestPrice: order.lowestPrice,
    highestPrice: order.highestPrice,
    lastPrice: order.lastPrice,
    deepestDipOfStop: deepestDip != null ? Number(deepestDip.toFixed(2)) : null,
    moveFromSignalPct:
      order.signalPrice > 0 ? Number(((order.lastPrice / order.signalPrice - 1) * 100).toFixed(2)) : null,
    // v8.6: how far the stock ran while the order waited. On an EXPIRED order
    // this is the size of the move the bot stood and watched - the one number
    // the two-week review needs to judge the dip rule.
    runUpFromSignalPct:
      order.signalPrice > 0
        ? Number(((order.highestPrice / order.signalPrice - 1) * 100).toFixed(2))
        : null,
    stopDistancePct: order.plan.stopDistancePct,
    atrPercent: order.plan.atrPercent != null ? order.plan.atrPercent : null,
    score: order.plan.score != null ? order.plan.score : null,
    source: order.plan.source || null,
    quoteMisses: order.quoteMisses || 0,
    checkFailures: order.checkFailures || 0,
    // What the stock looked like when approved — answers "what do the
    // rockets we skipped have in common?" without joining other records.
    approval: {
      plannedAt: order.plan.plannedAt || null,
      priceChangePercent: order.plan.priceChangePercent != null ? order.plan.priceChangePercent : null,
      moveToAtrRatio: order.plan.moveToAtrRatio != null ? order.plan.moveToAtrRatio : null,
      rsi: order.plan.rsi != null ? order.plan.rsi : null,
      relativeStrength: order.plan.relativeStrength != null ? order.plan.relativeStrength : null,
      aboveVwap: order.plan.aboveVwap != null ? order.plan.aboveVwap : null,
      setup: order.plan.setup || null,
      archetype: order.plan.archetype || null,
      catalystLabel: order.plan.catalystLabel || null,
      volatilityBucket: order.plan.volatilityBucket || null,
      regime: order.plan.regime || null,
      spyChangePercent: order.plan.spyChangePercent != null ? order.plan.spyChangePercent : null,
      aiConfidence: order.aiResult && order.aiResult.confidence != null ? order.aiResult.confidence : null,
    },
  };
}

// v10.2: the eToro-held safety stop for a plan — config multiplier × the
// plan's own stop distance below the entry. null (no broker stop) when
// switched off or the plan has no usable stop. Rounded DOWN so it never
// lands closer than intended: 2 decimals at $1+, 4 below.
function computeBrokerStopRate(plan, multiplier = config.brokerStopDistanceMultiplier) {
  if (!config.brokerStopEnabled) return null;
  const entry = Number(plan && plan.entryPrice);
  const stop = Number(plan && plan.stopPrice);
  if (!(entry > 0) || !(stop > 0) || stop >= entry) return null;
  const raw = entry - (entry - stop) * multiplier;
  if (!(raw > 0)) return null;
  const factor = entry >= 1 ? 100 : 10000;
  return Math.floor(raw * factor) / factor;
}

module.exports = {
  computeBrokerStopRate, // v10.2
  buildTradePlan,
  buildDipEntryOrder,
  evaluateDipEntry,
  rebasePlanToFill,
  describeDipEntryOrder,
  computeStopDistancePct, // v8.1: the shadow log records the planner's own stop distance
  classifyTradeType,
  classifyVolatility,
  classifyTrend,
  formatPlanForTelegram,
};
