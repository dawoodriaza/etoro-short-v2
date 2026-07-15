// src/strategies/risk-manager.js
//
// v5 (2026-07-04) — THREE REVIEW FIXES:
//
//   F1. DAILY LOSS LIMIT NOW USES EFFECTIVE (COMPOUNDED) CAPITAL.
//       It was sized off the static DT_CAPITAL env value while sizing used
//       capital-manager's compounding effectiveCapital — two different
//       bases. Callers now pass effectiveCapital; the limit scales with
//       the real account, not the day-one number.
//
//   F2. DYNAMIC CORRELATION BUCKETS. The hardcoded SECTOR_BUCKETS map
//       moved to sector-map.js and is now backed by a Finnhub industry
//       lookup (disk-cached forever), so DISCOVERED tickers — which used
//       to fall through to "other" and silently BYPASS the guard — are now
//       protected too. checkPreTradeSafety is therefore ASYNC (await it).
//
//   F3. sectorBucketFor() kept as a SYNC export (static map only) for the
//       AI screener prompt, which just labels the sector in text.
//
// v4 exit engine (DAY + SWING with partial ladders) unchanged below.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { logger } = require("../logger");
const config = require("../config");
const sectorMap = require("./sector-map");

// SYNC label helper (static map only — used for prompt text, not the guard)
function sectorBucketFor(symbol) {
  return sectorMap.getStaticBucket(symbol) || "other";
}

const dailyLossFilePath = path.join(
  __dirname,
  "../../data/daily-loss-tracker.json",
);
const dataDirectory = path.dirname(dailyLossFilePath);
if (!fs.existsSync(dataDirectory))
  fs.mkdirSync(dataDirectory, { recursive: true });

function loadDailyLoss() {
  try {
    if (!fs.existsSync(dailyLossFilePath))
      return { date: null, realizedLoss: 0 };
    return JSON.parse(fs.readFileSync(dailyLossFilePath, "utf8"));
  } catch {
    return { date: null, realizedLoss: 0 };
  }
}
function saveDailyLoss(tracker) {
  try {
    fs.writeFileSync(dailyLossFilePath, JSON.stringify(tracker, null, 2));
  } catch (saveError) {
    logger.warn("Could not save daily loss tracker: " + saveError.message);
  }
}

// ET trading date, not the server's local (UTC) date. The server's UTC day
// rolls at 8 PM ET — with 24/5 trading that reset the daily loss limit
// mid-evening, letting the bot re-lever the same night after a max-loss day.
function todayEasternDateString() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

function recordClosedTradeResult(realizedPnlDollars) {
  const today = todayEasternDateString();
  let tracker = loadDailyLoss();
  if (tracker.date !== today) {
    tracker = { date: today, realizedLoss: 0, realizedWin: 0, tradesClosed: 0 };
  }
  tracker.tradesClosed = (tracker.tradesClosed || 0) + 1;
  if (realizedPnlDollars < 0) {
    tracker.realizedLoss =
      (tracker.realizedLoss || 0) + Math.abs(realizedPnlDollars);
  } else {
    tracker.realizedWin = (tracker.realizedWin || 0) + realizedPnlDollars;
  }
  saveDailyLoss(tracker);
  return tracker;
}

// Today's realized results (ET day) — used as context in the AI screener
// prompt so it can demand stronger setups on a day that's going badly.
function getDailyLossSnapshot() {
  const today = todayEasternDateString();
  const tracker = loadDailyLoss();
  if (tracker.date !== today) {
    return { realizedLoss: 0, realizedWin: 0, tradesClosed: 0 };
  }
  return {
    realizedLoss: tracker.realizedLoss || 0,
    realizedWin: tracker.realizedWin || 0,
    tradesClosed: tracker.tradesClosed || 0,
  };
}

// F1: pass capital-manager's effectiveCapital here, NOT the static env value.
function isDailyLossLimitHit(effectiveCapital) {
  const today = todayEasternDateString();
  const tracker = loadDailyLoss();
  if (tracker.date !== today) return false;
  const limitDollars = effectiveCapital * config.dailyLossLimitPct;
  const hit = (tracker.realizedLoss || 0) >= limitDollars;
  if (hit) {
    logger.warn(
      "🛑 DAILY LOSS LIMIT HIT: realized loss $" +
        (tracker.realizedLoss || 0).toFixed(2) +
        " >= limit $" +
        limitDollars.toFixed(2) +
        " (5% of effective capital $" +
        effectiveCapital.toFixed(2) +
        ") — no new positions until tomorrow",
    );
  }
  return hit;
}

// Legacy sizing kept for compatibility; v4+ sizing lives in trade-planner.
function calculatePositionSize(dayTradeCapital, confidence) {
  const convictionScale = Math.min(1, Math.max(0.5, confidence / 10));
  const dollarAmount =
    dayTradeCapital * config.maxPositionPct * convictionScale;
  return Math.round(dollarAmount / 10) * 10;
}

// F2: ASYNC — correlation guard now resolves buckets dynamically so
// discovered tickers are covered. Callers must await.
async function checkPreTradeSafety(
  symbol,
  openPositions,
  effectiveCapital,
  availableCash,
  dollarAmount,
  tradeType,
  positionMetaBySymbol,
  averageDollarVolume, // v5.1: null/undefined = unknown, never blocks
) {
  if (isDailyLossLimitHit(effectiveCapital)) {
    return {
      allowed: false,
      reason: "Daily loss limit hit — no new trades today",
    };
  }

  // v5.1: liquidity/spread floor — only enforced when actually known.
  if (
    averageDollarVolume != null &&
    averageDollarVolume < config.minAverageDollarVolume
  ) {
    return {
      allowed: false,
      reason:
        "Liquidity too thin: avg $" +
        Math.round(averageDollarVolume / 1000) +
        "k/day daily volume below the $" +
        Math.round(config.minAverageDollarVolume / 1000) +
        "k floor — spread risk too high for this position size",
    };
  }

  // Per-type slots (falls back to legacy total cap when meta unavailable)
  if (tradeType && positionMetaBySymbol) {
    const dayCount = Object.values(positionMetaBySymbol).filter(
      (positionMeta) => (positionMeta.tradeType || "DAY") === "DAY",
    ).length;
    const swingCount = Object.values(positionMetaBySymbol).filter(
      (positionMeta) => positionMeta.tradeType === "SWING",
    ).length;
    if (tradeType === "DAY" && dayCount >= config.maxDayPositions) {
      return {
        allowed: false,
        reason: "Max DAY positions reached (" + config.maxDayPositions + ")",
      };
    }
    if (tradeType === "SWING" && swingCount >= config.maxSwingPositions) {
      return {
        allowed: false,
        reason:
          "Max SWING positions reached (" + config.maxSwingPositions + ")",
      };
    }
  } else if (openPositions.length >= config.maxOpenPositions) {
    return {
      allowed: false,
      reason: "Max open positions reached (" + config.maxOpenPositions + ")",
    };
  }

  // No pyramiding — checked against BOTH the settled portfolio and the
  // bot's own meta (meta catches orders eToro hasn't settled into the
  // positions list yet; that lag caused real double-entries overnight).
  if (
    openPositions.some(
      (position) =>
        (position.symbol || "").toUpperCase() === symbol.toUpperCase(),
    ) ||
    (positionMetaBySymbol && positionMetaBySymbol[symbol.toUpperCase()])
  ) {
    return { allowed: false, reason: symbol + " already held — no pyramiding" };
  }
  if (dollarAmount > availableCash) {
    return {
      allowed: false,
      reason: "Insufficient cash for this position size",
    };
  }

  // Correlation guard — DYNAMIC buckets (static map → Finnhub industry →
  // "other" only when truly unknown)
  const candidateBucket = await sectorMap.getSectorBucket(symbol);
  if (candidateBucket !== "other") {
    let sameBucketCount = 0;
    for (const position of openPositions) {
      const heldBucket = await sectorMap.getSectorBucket(position.symbol);
      if (heldBucket === candidateBucket) sameBucketCount++;
    }
    if (sameBucketCount >= config.maxPerSectorBucket) {
      return {
        allowed: false,
        reason:
          "Correlation guard: already holding " +
          sameBucketCount +
          " '" +
          candidateBucket +
          "' names (max " +
          config.maxPerSectorBucket +
          ")",
      };
    }
  }
  return { allowed: true };
}

// Legacy level computation kept for compatibility.
function computeRiskLevels(entryPrice, aiStopPrice, aiTargetPrice) {
  const hardStop = entryPrice * (1 - config.stopLossPct);
  const hardTargetMin = entryPrice * (1 + config.takeProfitPct * 0.5);
  const hardTargetMax = entryPrice * (1 + config.takeProfitRunnerPct * 1.5);

  let stopPrice = aiStopPrice;
  if (!stopPrice || stopPrice < hardStop * 0.97 || stopPrice > entryPrice) {
    stopPrice = hardStop;
  }
  let targetPrice = aiTargetPrice;
  if (
    !targetPrice ||
    targetPrice < hardTargetMin ||
    targetPrice > hardTargetMax
  ) {
    targetPrice = entryPrice * (1 + config.takeProfitPct);
  }
  const slippageAdjustedStop = stopPrice * (1 + config.slippageBufferPct);
  const slippageAdjustedTarget = targetPrice * (1 + config.slippageBufferPct);
  return {
    stopPrice: slippageAdjustedStop,
    targetPrice: slippageAdjustedTarget,
  };
}

// ── Exit decision engine (v4: DAY + SWING) — unchanged ──────────────────────
function decidePositionAction(meta, currentPrice) {
  const peak = Math.max(meta.peakPrice || meta.entryPrice, currentPrice);
  const tradeType = meta.tradeType === "SWING" ? "SWING" : "DAY";

  if (tradeType === "SWING") {
    return decideSwingAction(meta, currentPrice, peak);
  }
  return decideDayAction(meta, currentPrice, peak);
}

// ── Whipsaw confirmation for stop/floor breaches ────────────────────────────
// Returns null when the breach should EXIT now; otherwise a HOLD decision
// that asks the caller to bump the consecutive-breach counter. A breach
// DEEPER than stopWickBandPct is a real breakdown — never held.
function confirmStopBreach(meta, currentPrice, stopLevel, peak, label) {
  const breachDepthPct = (stopLevel - currentPrice) / stopLevel;
  const ticksSoFar = (meta.stopBreachTicks || 0) + 1;
  if (
    breachDepthPct < config.stopWickBandPct &&
    ticksSoFar < config.stopConfirmTicks
  ) {
    return {
      action: "HOLD",
      reason:
        label +
        " touched — awaiting confirmation tick " +
        ticksSoFar +
        "/" +
        config.stopConfirmTicks,
      newPeak: peak,
      stopBreachTicks: ticksSoFar,
    };
  }
  return null; // confirmed (or deep) — caller exits
}

// ── DAY logic ────────────────────────────────────────────────────────────────
function decideDayAction(meta, currentPrice, peak) {
  const heldMinutes = (Date.now() - (meta.openedAt || Date.now())) / 60000;

  // BREAKEVEN RATCHET (pre-partial): once the position has covered 60% of
  // the way to Target 1 (measured on the persisted PEAK, so it stays armed
  // after a pullback), the stop rises to entry — a trade that got
  // meaningfully green can no longer round-trip into a loss. Directly fixes
  // the observed "was in profit, then sold at a loss" pattern (NVDA/HOOD/
  // QCOM on 2026-07-14 all peaked green and closed red).
  const breakevenArmed =
    !meta.partialDone &&
    meta.targetT1 &&
    peak >= meta.entryPrice + 0.6 * (meta.targetT1 - meta.entryPrice);
  const effectiveStop = breakevenArmed
    ? Math.max(meta.stopPrice, meta.entryPrice)
    : meta.stopPrice;

  // 1. Hard stop (pre-partial) — with whipsaw confirmation: a shallow poke
  // below the stop needs a second consecutive 1-min tick before exiting,
  // so a brief dip-and-bounce doesn't dump the position at the low.
  if (!meta.partialDone && currentPrice <= effectiveStop) {
    const holdDecision = confirmStopBreach(
      meta,
      currentPrice,
      effectiveStop,
      peak,
      breakevenArmed ? "breakeven stop" : "stop",
    );
    if (holdDecision) return holdDecision;
    return {
      action: "EXIT",
      reason: breakevenArmed ? "BREAKEVEN_STOP" : "STOP_LOSS",
      newPeak: peak,
    };
  }

  // 2. Trailing on the runner (post-partial), floored at breakeven.
  // AGED RUNNER TIGHTENING: the trail is a fixed 2.5% off peak with NO time
  // decay — under 24/5 DAY_KEEP_WINNERS a green runner can be held overnight
  // repeatedly (it stays tradeType DAY, never gets a swing-style max-hold
  // cap) and could drift for days on a wide 2.5% leash. Once the trade is
  // aged (same agedTradeMinutes threshold as the pre-partial guard), the
  // trail tightens to agedTrailPct — an old runner gets harvested on a much
  // smaller pullback instead of riding an unlimited-time wide stop.
  if (meta.partialDone) {
    const isAgedRunner = heldMinutes >= config.agedTradeMinutes;
    const trailPct = isAgedRunner ? config.agedTrailPct : config.trailingStopPct;
    const trailStop = peak * (1 - trailPct);
    const effectiveTrail = Math.max(trailStop, meta.entryPrice);
    if (currentPrice <= effectiveTrail) {
      return {
        action: "EXIT",
        reason: isAgedRunner ? "AGED_PROFIT_PROTECT" : "TRAILING_STOP",
        newPeak: peak,
      };
    }
    return { action: "HOLD", reason: "trailing runner", newPeak: peak };
  }

  // 3. Target 1 → sell half, trail rest
  const dayTarget = meta.targetT1 || meta.targetPrice;
  if (dayTarget && currentPrice >= dayTarget) {
    return {
      action: "PARTIAL",
      reason: "TARGET_1_HIT",
      newPeak: peak,
      fraction: config.partialExitFraction,
      flagOnSuccess: "partialDone",
    };
  }

  // 3b. AGED-TRADE PROFIT GUARD: an old position whose peak showed a real
  // gain must not round-trip into a loss while waiting for Target 1. Once
  // held agedTradeMinutes+, if peak >= agedMinPeakPct, exit when price
  // falls to peak×(1−agedTrailPct) — floored at breakeven. A trade still
  // making new highs is untouched (the trail hangs below the rising peak);
  // this only harvests OLD trades as they fade. Fixes the observed AVGO
  // pattern: peaked +0.43%, no mechanism below the breakeven-ratchet arm
  // level, time-exited -0.2% at minute 151.
  if (heldMinutes >= config.agedTradeMinutes) {
    const peakGainFraction = (peak - meta.entryPrice) / meta.entryPrice;
    if (peakGainFraction >= config.agedMinPeakPct) {
      const agedFloor = Math.max(
        meta.entryPrice,
        peak * (1 - config.agedTrailPct),
      );
      if (currentPrice <= agedFloor) {
        return { action: "EXIT", reason: "AGED_PROFIT_PROTECT", newPeak: peak };
      }
    }
  }

  // 4. Time-based exit: stale and not working
  if (
    heldMinutes >= config.maxHoldMinutes &&
    currentPrice < meta.entryPrice * 1.005
  ) {
    return { action: "EXIT", reason: "TIME_EXIT_STALE", newPeak: peak };
  }

  return { action: "HOLD", reason: "in trade", newPeak: peak };
}

// ── SWING logic ──────────────────────────────────────────────────────────────
function decideSwingAction(meta, currentPrice, peak) {
  const heldDays = (Date.now() - (meta.openedAt || Date.now())) / 86400000;

  const currentFloor = meta.lockedFloor || meta.stopPrice;

  // 1. Floor breach → full exit of whatever remains (same whipsaw
  // confirmation as the day stop: shallow pokes need a second tick)
  if (currentPrice <= currentFloor) {
    const holdDecision = confirmStopBreach(
      meta,
      currentPrice,
      currentFloor,
      peak,
      "floor",
    );
    if (holdDecision) return holdDecision;
    const reason = meta.partialT1Done ? "SWING_FLOOR_LOCK" : "SWING_STOP";
    return { action: "EXIT", reason, newPeak: peak };
  }

  // 2. T3 reached with ladder done → take the runner
  if (meta.partialT2Done && meta.targetT3 && currentPrice >= meta.targetT3) {
    return { action: "EXIT", reason: "SWING_T3_COMPLETE", newPeak: peak };
  }

  // 3. Post-T2 trail on the runner (ATR-based, never below T1)
  if (meta.partialT2Done) {
    const trailPct = meta.swingTrailPct || 0.03;
    const trailStop = peak * (1 - trailPct);
    const effectiveTrail = Math.max(trailStop, meta.targetT1 || currentFloor);
    if (currentPrice <= effectiveTrail) {
      return { action: "EXIT", reason: "SWING_TRAIL", newPeak: peak };
    }
    return { action: "HOLD", reason: "swing runner trailing", newPeak: peak };
  }

  // 4. T2 hit → sell half of the remainder, floor ratchets to T1
  if (meta.partialT1Done && meta.targetT2 && currentPrice >= meta.targetT2) {
    return {
      action: "PARTIAL",
      reason: "SWING_T2_HIT",
      newPeak: peak,
      fraction: 0.5,
      flagOnSuccess: "partialT2Done",
      floorOnSuccess: meta.targetT1,
    };
  }

  // 5. T1 hit → sell a third, floor ratchets to breakeven
  if (!meta.partialT1Done && meta.targetT1 && currentPrice >= meta.targetT1) {
    return {
      action: "PARTIAL",
      reason: "SWING_T1_HIT",
      newPeak: peak,
      fraction: 1 / 3,
      flagOnSuccess: "partialT1Done",
      floorOnSuccess: meta.entryPrice,
    };
  }

  // 6. Time exit: held too long (Friday close will usually fire first)
  if (heldDays >= config.swingMaxHoldDays) {
    return { action: "EXIT", reason: "SWING_TIME_EXIT", newPeak: peak };
  }

  return { action: "HOLD", reason: "swing developing", newPeak: peak };
}

module.exports = {
  recordClosedTradeResult,
  isDailyLossLimitHit,
  getDailyLossSnapshot,
  calculatePositionSize,
  checkPreTradeSafety,
  computeRiskLevels,
  decidePositionAction,
  sectorBucketFor,
};
