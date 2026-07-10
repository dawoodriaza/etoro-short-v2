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

function recordClosedTradeResult(realizedPnlDollars) {
  const today = new Date().toDateString();
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

// F1: pass capital-manager's effectiveCapital here, NOT the static env value.
function isDailyLossLimitHit(effectiveCapital) {
  const today = new Date().toDateString();
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

  if (
    openPositions.some(
      (position) =>
        (position.symbol || "").toUpperCase() === symbol.toUpperCase(),
    )
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

// ── DAY logic ────────────────────────────────────────────────────────────────
function decideDayAction(meta, currentPrice, peak) {
  const heldMinutes = (Date.now() - (meta.openedAt || Date.now())) / 60000;

  // 1. Hard stop (pre-partial)
  if (!meta.partialDone && currentPrice <= meta.stopPrice) {
    return { action: "EXIT", reason: "STOP_LOSS", newPeak: peak };
  }

  // 2. Trailing on the runner (post-partial), floored at breakeven
  if (meta.partialDone) {
    const trailStop = peak * (1 - config.trailingStopPct);
    const effectiveTrail = Math.max(trailStop, meta.entryPrice);
    if (currentPrice <= effectiveTrail) {
      return { action: "EXIT", reason: "TRAILING_STOP", newPeak: peak };
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

  // 1. Floor breach → full exit of whatever remains
  if (currentPrice <= currentFloor) {
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
  calculatePositionSize,
  checkPreTradeSafety,
  computeRiskLevels,
  decidePositionAction,
  sectorBucketFor,
};
