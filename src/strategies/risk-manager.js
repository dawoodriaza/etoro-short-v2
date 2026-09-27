// src/strategies/risk-manager.js
//
// v6 (2026-07-21, review-driven upgrade) — TIME-BASED EXIT LOGIC OVERHAUL:
//
//   R1. RECOVERY-AWARE TIME EXITS. TIME_EXIT_STALE (DAY) and SWING_TIME_EXIT
//       (SWING) used to force-close purely on the clock, with NO read on
//       whether the position was actually recovering — exactly the "closes
//       just because a time limit was reached" behavior flagged in review.
//       Both now check a short recent-price trend before exiting a
//       losing/flat position; a genuine up-trend earns ONE bounded grace
//       extension (never unlimited — the hard stop-loss/floor stays fully
//       live and unaffected the entire time, so this never increases the
//       position's actual downside risk).
//   R2. PROFIT-STALL LOCK. New rule: a DAY position sitting in modest,
//       non-MFE-armed profit that hasn't made a new high in a while now
//       locks in a partial gain — UNLESS the short-term trend still looks
//       like it's pushing toward a new high, in which case it re-arms
//       instead of exiting. Distinct from the existing MFE-giveback engine
//       (which reacts to GIVING BACK price from the peak) — this reacts to
//       flatlining without necessarily giving anything back yet.
//   R3. VOLATILITY-SCALED TIME BUDGETS. maxHoldMinutes/swingMaxHoldDays are
//       now multiplied by the position's OWN volatility bucket (already
//       computed at entry by trade-planner.classifyVolatility — reused
//       here, not re-derived): a HIGH-ATR name gets a SHORTER time budget
//       (it should show its hand fast), a LOW-ATR name gets a LONGER one
//       (it legitimately needs more time to develop).
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
const tradePlanner = require("./trade-planner"); // v6: reuse classifyVolatility (no cycle — trade-planner has no risk-manager require)

// ── v6: short-term trend read (recovery check + profit-stall check) ───────
// recentPrices: [{price, atMs}, ...] oldest-first, small rolling window
// maintained by the caller (index.js) on every exit-monitor tick. Returns
// "RISING" | "FALLING" | "FLAT" | "UNKNOWN" (not enough samples yet — an
// UNKNOWN read never grants a grace extension and never suppresses a lock,
// it just means "no opinion," which is the safe default in both directions).
function computeRecentTrend(recentPrices) {
  if (
    !Array.isArray(recentPrices) ||
    recentPrices.length < config.recoveryCheckMinSamples
  ) {
    return "UNKNOWN";
  }
  const oldest = recentPrices[0].price;
  const newest = recentPrices[recentPrices.length - 1].price;
  if (!oldest || oldest <= 0) return "UNKNOWN";
  const changePct = ((newest - oldest) / oldest) * 100;
  if (changePct >= config.recoveryCheckMinSlopePct) return "RISING";
  if (changePct <= -config.recoveryCheckMinSlopePct) return "FALLING";
  return "FLAT";
}

// v6: the same ATR-lookup decideDayAction already does, factored out so
// decideSwingAction can use it too (for volatility-scaled time budgets)
// without duplicating the meta-shape knowledge.
function getAtrPercentFromMeta(meta) {
  if (meta.entryConditions && meta.entryConditions.atrPercent != null) {
    return meta.entryConditions.atrPercent;
  }
  if (meta.plan && meta.plan.atrPercent != null) {
    return meta.plan.atrPercent;
  }
  return null;
}

// v6: volatility-scaled time-budget multiplier — reuses the SAME LOW/
// MEDIUM/HIGH thresholds trade-planner used at entry, so a position's time
// budget and its stop/target geometry are governed by one consistent
// volatility read, never two different opinions of "how volatile is this."
function getTimeBudgetMultiplier(meta) {
  const bucket = tradePlanner.classifyVolatility(getAtrPercentFromMeta(meta));
  if (bucket === "HIGH") return config.timeBudgetHighVolMultiplier;
  if (bucket === "LOW") return config.timeBudgetLowVolMultiplier;
  return 1;
}

// ═══════════════════════════════════════════════════════════════════════
// v7.1 — SESSION-AWARE TIME BUDGETS.
//
// maxHoldMinutes (90) is a REGULAR-SESSION number: "give this setup 90
// minutes of live trading to work." Measured against the wall clock it
// means something completely different overnight, where the clock runs at
// full speed and the market does not move at all.
//
// Live evidence, 2026-07-27 (a Monday, the thinnest tape of the week):
// SNAP was opened at 01:00 ET — eight and a half hours BEFORE the open —
// sized at 35% of capital, and force-closed by TIME_EXIT_STALE having
// never seen a single minute of the session it was sized for. RIVN and
// AVGO died the same way the same night. Across all history,
// TIME_EXIT_STALE is 71% of every exit this bot has ever made.
//
// The fix is to measure the budget in the units it was written in:
// REGULAR-SESSION minutes actually elapsed since entry. A position opened
// pre-market accrues zero budget until 09:30 ET, then burns it at real
// time. An absolute wall-clock ceiling still applies so nothing can be
// held forever (e.g. over a weekend, when session minutes never accrue).
//
// The hard stop-loss is completely unaffected by any of this and remains
// immediate and unconditional throughout — same principle as the v6
// recovery grace.
// ═══════════════════════════════════════════════════════════════════════
const SESSION_OPEN_MINUTE_OF_DAY = 9 * 60 + 30; // 09:30 ET
const SESSION_CLOSE_MINUTE_OF_DAY = 16 * 60; // 16:00 ET
const MINUTES_PER_DAY = 24 * 60;

// One reusable formatter — constructing Intl objects in a loop is the
// single most expensive thing this file could do, and this runs on every
// exit-monitor tick for every open position.
const ET_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});

function easternInfo(ms) {
  const parts = ET_PARTS_FORMATTER.formatToParts(new Date(ms));
  const part = (type) => parts.find((p) => p.type === type)?.value;
  const dateString = part("year") + "-" + part("month") + "-" + part("day");
  const weekday = part("weekday");
  return {
    dateString,
    weekday,
    minuteOfDay: (Number(part("hour")) % 24) * 60 + Number(part("minute")),
    isTradingDay:
      weekday !== "Sat" && weekday !== "Sun" && !isUSMarketHoliday(dateString),
  };
}

// Minutes of [fromMinute, toMinute) that fall inside the 09:30-16:00 window.
function sessionOverlap(fromMinute, toMinute) {
  return Math.max(
    0,
    Math.min(toMinute, SESSION_CLOSE_MINUTE_OF_DAY) -
      Math.max(fromMinute, SESSION_OPEN_MINUTE_OF_DAY),
  );
}

// How many REGULAR-SESSION minutes fall between two instants. Pure and
// timezone-correct: intersects each ET calendar day's 09:30-16:00 window
// with [startMs, endMs]. Weekends and US market holidays contribute zero,
// so a Friday-evening entry accrues nothing until Monday's open.
//
// Day arithmetic rather than a minute-by-minute walk: a 10-day swing would
// otherwise mean ~14,000 Intl formats per position per tick.
function computeRegularSessionMinutesBetween(startMs, endMs) {
  if (!startMs || !endMs || endMs <= startMs) return 0;

  // Guard against pathological inputs.
  if (endMs - startMs > 30 * MINUTES_PER_DAY * 60000) {
    return (endMs - startMs) / 60000; // >30 days: treat as fully elapsed
  }

  const start = easternInfo(startMs);
  const end = easternInfo(endMs);

  // Same ET calendar day — one intersection settles it.
  if (start.dateString === end.dateString) {
    return start.isTradingDay
      ? sessionOverlap(start.minuteOfDay, end.minuteOfDay)
      : 0;
  }

  // First (partial) day, from entry to midnight.
  let total = start.isTradingDay
    ? sessionOverlap(start.minuteOfDay, MINUTES_PER_DAY)
    : 0;

  // Whole days in between contribute a full session each, or nothing.
  // Stepping 24h from a midday anchor always lands on the next calendar
  // day, including across DST transitions (which shift by one hour).
  const FULL_SESSION_MINUTES =
    SESSION_CLOSE_MINUTE_OF_DAY - SESSION_OPEN_MINUTE_OF_DAY; // 390
  let cursorMs = startMs + (12 * 60 - start.minuteOfDay) * 60000; // ~noon ET
  for (let dayIndex = 0; dayIndex < 31; dayIndex += 1) {
    cursorMs += MINUTES_PER_DAY * 60000;
    const day = easternInfo(cursorMs);
    if (day.dateString === end.dateString) break;
    if (cursorMs > endMs) break;
    if (day.isTradingDay) total += FULL_SESSION_MINUTES;
  }

  // Last (partial) day, from midnight to now.
  if (end.isTradingDay) total += sessionOverlap(0, end.minuteOfDay);

  return total;
}

// Minimal holiday check kept local so risk-manager stays free of a require
// on market-hours (which loads dotenv and reads 24/5 env at module load).
const US_MARKET_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
]);
function isUSMarketHoliday(etDateString) {
  return US_MARKET_HOLIDAYS.has(etDateString);
}

// The elapsed figure the DAY stale-exit should judge against, plus the
// wall-clock figure used for the absolute ceiling.
function getDayHoldElapsed(meta) {
  const openedAt = meta.openedAt || Date.now();
  const wallClockMinutes = (Date.now() - openedAt) / 60000;
  if (!config.sessionAwareTimeBudgets) {
    return { effectiveMinutes: wallClockMinutes, wallClockMinutes, mode: "WALL_CLOCK" };
  }
  return {
    effectiveMinutes: computeRegularSessionMinutesBetween(openedAt, Date.now()),
    wallClockMinutes,
    mode: "SESSION_MINUTES",
  };
}

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
    tracker = {
      date: today,
      realizedLoss: 0,
      realizedWin: 0,
      tradesClosed: 0,
      losingTrades: 0,
    };
  }
  tracker.tradesClosed = (tracker.tradesClosed || 0) + 1;
  if (realizedPnlDollars < 0) {
    tracker.realizedLoss =
      (tracker.realizedLoss || 0) + Math.abs(realizedPnlDollars);
    // Loser COUNT, not just dollars — the AI screener's BAD-DAY RULE is
    // defined as "3+ losing trades AND net negative", and without this
    // count the rule's condition couldn't be evaluated by anyone.
    tracker.losingTrades = (tracker.losingTrades || 0) + 1;
  } else {
    tracker.realizedWin = (tracker.realizedWin || 0) + realizedPnlDollars;
  }
  saveDailyLoss(tracker);
  return tracker;
}

// Today's realized results (ET day) — used as context in the AI screener
// prompt so it can demand stronger setups on a day that's going badly.
// badDayRuleApplies is computed HERE, deterministically — the model was
// previously told the rule's threshold but not given the loser count, so
// it guessed (and misapplied the rule on a -$6 day with 1-2 closes).
function getDailyLossSnapshot() {
  const today = todayEasternDateString();
  const tracker = loadDailyLoss();
  if (tracker.date !== today) {
    return {
      realizedLoss: 0,
      realizedWin: 0,
      tradesClosed: 0,
      losingTrades: 0,
      badDayRuleApplies: false,
    };
  }
  const realizedLoss = tracker.realizedLoss || 0;
  const realizedWin = tracker.realizedWin || 0;
  const losingTrades = tracker.losingTrades || 0;
  return {
    realizedLoss,
    realizedWin,
    tradesClosed: tracker.tradesClosed || 0,
    losingTrades,
    badDayRuleApplies: losingTrades >= 3 && realizedWin - realizedLoss < 0,
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

// ⚠️ DEAD CODE — exported but called from nowhere in src/ or test/ (verified
// 2026-09-02). Left in place rather than deleted because it documents the
// pre-v4 level model, but DO NOT wire it back up without reading this:
//
// v7.13 BUG FIX — the slippage buffer was applied with the SAME sign to the
// stop and the target. For a long position those need OPPOSITE signs: a stop
// nudged UP triggers earlier (protective, correct), but a target nudged UP
// triggers LATER, making the trade harder to complete — the opposite of what
// a slippage allowance is for. Fixed below so that if this is ever revived
// it behaves correctly; the live path (buildTradePlan) was never affected.
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
  // Long target: nudge DOWN so it fills slightly earlier, mirroring the
  // stop's nudge UP. Was `1 +`, which pushed the target further away.
  const slippageAdjustedTarget = targetPrice * (1 - config.slippageBufferPct);
  return {
    stopPrice: slippageAdjustedStop,
    targetPrice: slippageAdjustedTarget,
  };
}

// ── Exit decision engine (v4: DAY + SWING) ─────────────────────────────────
//
// v7: the daily AI reviewer can now request TAKE_PARTIAL or CLOSE. Rather
// than executing orders itself, it queues a directive on the position meta
// and the ordinary 1-minute exit monitor carries it out through the SAME
// order + accounting path every other exit uses. That deliberately avoids a
// second implementation of close accounting (realized P&L, cooldown,
// performance record, journal, shadow tracking) — a duplicate of that on a
// live-money bot is a bug factory.
//
// PRECEDENCE: the deterministic engine runs FIRST and any EXIT it produces
// wins outright. A stop-loss, MFE giveback or target completion must never be
// displaced by a directive the AI queued hours earlier on stale prices. The
// directive only applies when the engine would otherwise HOLD or take its own
// partial, and a queued PARTIAL is dropped if the tier was banked meanwhile.
function decidePositionAction(meta, currentPrice) {
  const peak = Math.max(meta.peakPrice || meta.entryPrice, currentPrice);
  const tradeType = meta.tradeType === "SWING" ? "SWING" : "DAY";

  const baseDecision =
    tradeType === "SWING"
      ? decideSwingAction(meta, currentPrice, peak)
      : decideDayAction(meta, currentPrice, peak);

  // Hard risk always wins.
  if (baseDecision.action === "EXIT") return baseDecision;

  const pending = meta.pendingReviewerAction;
  if (!pending) return baseDecision;

  if (pending.type === "EXIT") {
    return {
      action: "EXIT",
      reason: pending.reason || "AI_REVIEW_CLOSE",
      newPeak: peak,
      fromReviewer: true,
    };
  }

  if (pending.type === "PARTIAL") {
    // The deterministic engine already banking a tier this tick takes
    // precedence — one partial per tick, and its floor logic is stricter.
    if (baseDecision.action === "PARTIAL") return baseDecision;
    // Tier already banked since the review — the directive is stale.
    if (meta.partialDone || meta.partialT1Done) return baseDecision;
    return {
      action: "PARTIAL",
      reason: pending.reason || "AI_REVIEW_PARTIAL",
      fraction: pending.fraction,
      // Bank at breakeven-or-better, mirroring every other partial path.
      floorOnSuccess: Math.max(meta.lockedFloor || 0, meta.entryPrice),
      flagOnSuccess: "partialDone",
      newPeak: peak,
      fromReviewer: true,
    };
  }

  return baseDecision;
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

// v8.3: the wait-for-breakeven rule was replay-tested only on DIP entries —
// with immediate entries it made results worse — so it applies only to
// positions actually bought on a dip (plan.dipEntry), never to adopted,
// manual or buy-immediately positions.
function breakevenWaitApplies(meta) {
  return config.staleWaitForBreakeven && !!(meta.plan && meta.plan.dipEntry);
}

// The MFE giveback floor for a DAY position. Factored out of decideDayAction
// (v8) so position diagnostics and the replay harness read the SAME level the
// exit engine enforces instead of re-deriving it and drifting from it.
function computeMfeProtection(meta, peak) {
  const entryPrice = meta.entryPrice;
  const atrPercent = getAtrPercentFromMeta(meta);
  const atrFraction = atrPercent != null ? atrPercent / 100 : null;
  const mfeGainFraction = (peak - entryPrice) / entryPrice;
  const armThreshold = Math.max(
    config.mfeArmMinPct,
    atrFraction != null ? atrFraction * config.mfeArmAtrFraction : 0,
  );
  const armed = mfeGainFraction >= armThreshold;
  let floor = null;
  let allowedGiveback = null;
  if (armed) {
    allowedGiveback = Math.min(
      mfeGainFraction * (1 - config.mfeRetention),
      atrFraction != null
        ? atrFraction * config.mfeGivebackAtrCap
        : config.mfeGivebackFallbackPct,
    );
    floor = Math.max(
      entryPrice,
      entryPrice * (1 + mfeGainFraction - allowedGiveback),
    );
  }
  return { armed, floor, armThreshold, atrFraction, mfeGainFraction, allowedGiveback };
}

// ── DAY logic ────────────────────────────────────────────────────────────────
function decideDayAction(meta, currentPrice, peak) {
  // NOTE: the DAY stale-exit no longer reads a raw wall-clock figure — it
  // uses getDayHoldElapsed(meta) further down, which spends the budget in
  // regular-session minutes. SWING is deliberately left on wall-clock days:
  // its budget is denominated in DAYS, where spanning a weekend is normal
  // and expected rather than a distortion.
  const entryPrice = meta.entryPrice;

  // ── MFE GIVEBACK ENGINE ──────────────────────────────────────────────
  // Replaces three overlapping mechanisms (breakeven ratchet, age-gated
  // profit guard, dual runner trail) with ONE volatility-adjusted rule.
  // Forensic evidence that drove this redesign (2026-07-16/17 journal):
  //   - SNAP exited -1.7% via the age-gated guard: it peaked green early,
  //     but protection lay DORMANT until minute 75 while the profit decayed
  //     into a loss. Arming must be MFE-based, not age-based.
  //   - AAPL runner captured +2.4% of a +2.92% peak (82% retention) — the
  //     retention concept works; it just needs to scale with the stock's
  //     own volatility instead of a fixed trail.
  // Rule: once the position's best gain (MFE, from persisted peakPrice)
  // reaches an ATR-scaled arming threshold, an exit floor tracks the peak:
  //   allowed giveback = min((1-retention) × MFE, givebackCap × dailyATR)
  //   floor = entry + (MFE - allowed giveback), never below breakeven.
  // A trade making new highs lifts its own floor; a fading trade gets
  // harvested while most of its best profit still exists. No fixed
  // percentages: both the arming bar and the giveback cap scale with the
  // stock's daily ATR (fallbacks apply only when ATR was unavailable).
  const { armed: mfeArmed, floor: mfeFloor } = computeMfeProtection(meta, peak);

  // 1. Hard stop (pre-partial) — with whipsaw confirmation: a shallow poke
  // below the stop needs a second consecutive 1-min tick before exiting,
  // so a brief dip-and-bounce doesn't dump the position at the low.
  if (!meta.partialDone && currentPrice <= meta.stopPrice) {
    const holdDecision = confirmStopBreach(
      meta,
      currentPrice,
      meta.stopPrice,
      peak,
      "stop",
    );
    if (holdDecision) return holdDecision;
    return { action: "EXIT", reason: "STOP_LOSS", newPeak: peak };
  }

  // 2. MFE floor breach — applies pre- AND post-partial, immediately on
  // arming (no age gate). Exits the position (or the runner) while most of
  // its best profit is still intact.
  if (mfeFloor != null && currentPrice <= mfeFloor) {
    return { action: "EXIT", reason: "MFE_GIVEBACK", newPeak: peak };
  }

  // 3. Runner fallback trail (post-partial): only matters when the MFE
  // engine couldn't arm (ATR unknown AND peak under the minimum) — keeps
  // the runner from ever being fully unprotected. Floored at breakeven.
  if (meta.partialDone) {
    const fallbackTrail = Math.max(
      peak * (1 - config.trailingStopPct),
      entryPrice,
    );
    if (currentPrice <= fallbackTrail) {
      return { action: "EXIT", reason: "TRAILING_STOP", newPeak: peak };
    }
    return { action: "HOLD", reason: "trailing runner", newPeak: peak };
  }

  // 4. Target 1 → sell half, the MFE engine manages the rest
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

  // 4.5. PROFIT-STALL LOCK (v6). Applies to the gap the MFE engine and
  // Target 1 don't cover: a position sitting in modest REAL profit that
  // hasn't armed the MFE floor yet (arm threshold is ATR-scaled — often
  // well above where this fires) and hasn't reached Target 1 either, but
  // also hasn't made a new high in a while. Left alone, this position would
  // just sit in HOLD indefinitely (it's above the +0.5% floor the stale
  // check needs, so that never catches it either). Before locking, check
  // the short-term trend — if it still looks like it's pushing toward a new
  // high, re-arm silently instead of exiting (the "intelligent extend"
  // half of the ask). A rising peak naturally keeps resetting this clock
  // on its own — no separate grace-used flag needed here.
  if (
    config.profitStallEnabled &&
    !meta.partialDone &&
    !mfeArmed &&
    currentPrice > entryPrice * (1 + config.profitStallMinProfitPct / 100)
  ) {
    const peakSetAt = meta.peakSetAt || meta.openedAt || Date.now();
    const minutesSincePeak = (Date.now() - peakSetAt) / 60000;
    if (minutesSincePeak >= config.profitStallMinMinutes) {
      const trend = computeRecentTrend(meta.recentPrices);
      if (trend === "RISING") {
        return {
          action: "HOLD",
          reason: "profit-stall check: still rising, extending",
          newPeak: peak,
        };
      }
      return {
        action: "PARTIAL",
        reason: "PROFIT_STALL_LOCK",
        newPeak: peak,
        fraction: config.profitStallLockFraction,
        flagOnSuccess: "partialDone",
      };
    }
  }

  // 5. Time-based exit: stale and not working (loser cleanup — winners are
  // the MFE engine's job). RECOVERY-AWARE (v6) and VOLATILITY-SCALED (v6):
  // the time budget itself scales with the position's own ATR bucket, and
  // before force-exiting a losing/flat position purely on the clock, the
  // short-term trend gets ONE chance to earn a bounded grace extension. The
  // hard stop above is completely unaffected by any of this — it remains
  // immediate and unconditional regardless of grace state.
  // v7.1: the budget is now spent in REGULAR-SESSION minutes (see
  // getDayHoldElapsed above) so a position opened pre-market is not killed
  // by a clock running while the market is shut. An absolute WALL-CLOCK
  // ceiling still applies, so a position opened on a Friday evening — when
  // session minutes would not accrue until Monday — cannot be held
  // indefinitely.
  const effectiveMaxHoldMinutes =
    config.maxHoldMinutes * getTimeBudgetMultiplier(meta);
  const holdElapsed = getDayHoldElapsed(meta);
  const absoluteCeilingMinutes =
    config.maxHoldMinutes * config.maxHoldWallClockCeilingMultiplier;
  const budgetSpent = holdElapsed.effectiveMinutes >= effectiveMaxHoldMinutes;
  const ceilingHit = holdElapsed.wallClockMinutes >= absoluteCeilingMinutes;

  // v8.3 WAIT FOR BREAKEVEN: a position whose time ran out while red is held
  // (see below) and sold as soon as it is back to breakeven + a small margin.
  if (
    breakevenWaitApplies(meta) &&
    meta.waitingForBreakevenSince &&
    !ceilingHit &&
    currentPrice >= entryPrice * (1 + config.staleBreakevenExitPct / 100)
  ) {
    return { action: "EXIT", reason: "STALE_RECOVERED", newPeak: peak };
  }

  if ((budgetSpent || ceilingHit) && currentPrice < entryPrice * 1.005) {
    if (config.recoveryCheckEnabled && !meta.staleGraceUsedAt) {
      const trend = computeRecentTrend(meta.recentPrices);
      if (trend === "RISING") {
        return {
          action: "HOLD",
          reason:
            "stale-exit check: recovery signal detected, granting a " +
            config.dayStaleGraceExtensionMinutes +
            "min grace extension before re-evaluating",
          newPeak: peak,
          grantStaleGrace: true,
        };
      }
    }
    const graceStillActive =
      meta.staleGraceUsedAt &&
      Date.now() - meta.staleGraceUsedAt <
        config.dayStaleGraceExtensionMinutes * 60000;
    if (graceStillActive) {
      return {
        action: "HOLD",
        reason: "in stale-exit recovery grace window",
        newPeak: peak,
      };
    }
    // v8.3: red at the end of the session budget — do not sell at a loss on
    // the clock. The hard stop above, the MFE floor, the Mon-Thu end-of-day
    // loser close and Friday close-all still apply; the wall-clock ceiling
    // still force-exits. Replay-tested together with the dip entry.
    if (breakevenWaitApplies(meta) && !ceilingHit && currentPrice < entryPrice) {
      return {
        action: "HOLD",
        reason: "time budget spent while red — waiting to get back to breakeven (stop stays active)",
        newPeak: peak,
        startBreakevenWait: !meta.waitingForBreakevenSince,
      };
    }
    return {
      action: "EXIT",
      reason: "TIME_EXIT_STALE",
      newPeak: peak,
      // Which limit actually fired — the session budget or the wall-clock
      // backstop. Recorded so the journal can separate "had its trading
      // time and did nothing" from "sat through a closed market".
      timeExitTrigger: budgetSpent ? "SESSION_BUDGET" : "WALL_CLOCK_CEILING",
      sessionMinutesHeld: Math.round(holdElapsed.effectiveMinutes),
      wallClockMinutesHeld: Math.round(holdElapsed.wallClockMinutes),
    };
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

  // 6. Time exit: held too long (Friday's mandatory close-ALL in eod-closer.js
  // still fires unconditionally regardless of anything below — this is only
  // the routine Mon-Thu day-count exit). VOLATILITY-SCALED (v6) and, when
  // the position is currently a LOSER, RECOVERY-AWARE (v6): force-closing a
  // loser purely because N days passed, with no read on whether it's
  // stabilizing, is exactly the "closes solely on a time limit" behavior
  // flagged in review. A position current in PROFIT at the day limit is NOT
  // gated here — the T1/T2/T3 floor ladder above already protects it, so
  // there's no blind-exit-on-a-winner problem to fix.
  const effectiveMaxHoldDays =
    config.swingMaxHoldDays * getTimeBudgetMultiplier(meta);
  if (heldDays >= effectiveMaxHoldDays) {
    const isLosing = currentPrice < meta.entryPrice;
    if (isLosing && config.recoveryCheckEnabled) {
      if (!meta.swingTimeGraceUsedAt) {
        const trend = computeRecentTrend(meta.recentPrices);
        if (trend === "RISING") {
          return {
            action: "HOLD",
            reason:
              "swing time-exit check: recovery signal detected in a loss, " +
              "granting a " +
              config.swingTimeExitGraceExtensionDays +
              "-day grace extension before re-evaluating",
            newPeak: peak,
            grantSwingTimeGrace: true,
          };
        }
      } else {
        const graceStillActiveDays =
          (Date.now() - meta.swingTimeGraceUsedAt) / 86400000 <
          config.swingTimeExitGraceExtensionDays;
        if (graceStillActiveDays) {
          return {
            action: "HOLD",
            reason: "in swing time-exit recovery grace window",
            newPeak: peak,
          };
        }
      }
    }
    return { action: "EXIT", reason: "SWING_TIME_EXIT", newPeak: peak };
  }

  return { action: "HOLD", reason: "swing developing", newPeak: peak };
}

// ═══════════════════════════════════════════════════════════════════════
// v8 — WHAT IS THE BOT DOING WITH THIS POSITION, AND WHAT HAPPENS NEXT?
//
// Pure read of the live engine's own state for one position, for the
// periodic status line and the POSITION_STATUS journal record. It calls the
// real decidePositionAction() and computeMfeProtection(), so the stop and
// triggers it prints are exactly the ones being enforced.
//
// state: EXIT | TRIM (the engine is acting this tick) · RUNNER (partial
// banked, remainder trailing) · WEAKENING (giving back a protected gain, or
// a loser burning its time budget) · HOLD. "ADD" is never produced: adding
// to winners is not enabled, because the replay did not support it
// (ADD_AT_1R was mixed in-sample and flat out-of-sample).
// ═══════════════════════════════════════════════════════════════════════
function describePositionState(meta, currentPrice) {
  const entryPrice = meta.entryPrice;
  const peak = Math.max(meta.peakPrice || entryPrice, currentPrice);
  const percentFromEntry = (price) => ((price / entryPrice - 1) * 100);
  const decision = decidePositionAction(meta, currentPrice);
  const round = (value) => (value == null ? null : Number(value.toFixed(4)));

  const status = {
    tradeType: meta.tradeType === "SWING" ? "SWING" : "DAY",
    state: "HOLD",
    pnlPct: Number(percentFromEntry(currentPrice).toFixed(2)),
    peakPct: Number(percentFromEntry(peak).toFixed(2)),
    stopPrice: null,
    stopKind: null,
    nextTrim: null,
    nextAdd: "not enabled (replay did not support adding to winners)",
    exitConditions: [],
    realizedPartialPnl: Number(meta.realizedPartialPnl || 0),
    reason: decision.reason,
  };

  if (status.tradeType === "SWING") {
    const floor = meta.lockedFloor || meta.stopPrice;
    status.stopPrice = round(floor);
    status.stopKind = meta.lockedFloor ? "LOCKED_FLOOR" : "STOP";
    status.nextTrim = !meta.partialT1Done
      ? "T1 $" + round(meta.targetT1)
      : !meta.partialT2Done && meta.targetT2
        ? "T2 $" + round(meta.targetT2)
        : "ladder done — runner trailing";
    status.exitConditions.push("exit at or below $" + round(floor));
  } else {
    const protection = computeMfeProtection(meta, peak);
    const levels = [];
    if (!meta.partialDone) levels.push({ level: meta.stopPrice, kind: "STOP" });
    if (protection.floor != null) levels.push({ level: protection.floor, kind: "PROFIT_FLOOR" });
    if (meta.partialDone) {
      levels.push({ level: Math.max(peak * (1 - config.trailingStopPct), entryPrice), kind: "RUNNER_TRAIL" });
    }
    const effective = levels.reduce((best, item) => (item.level > best.level ? item : best), levels[0]);
    status.stopPrice = round(effective.level);
    status.stopKind = effective.kind;
    status.exitConditions.push(
      "exit at or below $" + round(effective.level) + " (" + effective.kind.toLowerCase().replace("_", " ") + ")",
    );

    const target = meta.targetT1 || meta.targetPrice;
    status.nextTrim = meta.partialDone
      ? "none — " + Math.round(config.partialExitFraction * 100) + "% banked, runner trailing"
      : target
        ? "T1 $" + round(target) + " (+" + percentFromEntry(target).toFixed(2) + "%) sells " +
          Math.round(config.partialExitFraction * 100) + "%"
        : "none";

    const budgetMinutes = config.maxHoldMinutes * getTimeBudgetMultiplier(meta);
    const elapsed = getDayHoldElapsed(meta).effectiveMinutes;
    const budgetLeft = Math.max(0, Math.round(budgetMinutes - elapsed));
    if (!meta.partialDone) {
      status.exitConditions.push(
        budgetLeft > 0
          ? "time exit in " + budgetLeft + " session-min if still under +0.5%" +
            (breakevenWaitApplies(meta) ? " (if red then, waits for breakeven)" : "")
          : meta.waitingForBreakevenSince
            ? "time spent while red — sells at breakeven $" +
              round(entryPrice * (1 + config.staleBreakevenExitPct / 100)) +
              " if it recovers; still-red losers close at end of day"
            : "time budget spent — exits if under +0.5%" +
              (breakevenWaitApplies(meta) ? " (waits for breakeven if red)" : ""),
      );
    }

    if (decision.action === "EXIT") status.state = "EXIT";
    else if (decision.action === "PARTIAL") status.state = "TRIM";
    else if (meta.partialDone) status.state = "RUNNER";
    else if (
      protection.armed &&
      protection.allowedGiveback != null &&
      currentPrice <= peak * (1 - protection.allowedGiveback * 0.5)
    ) {
      status.state = "WEAKENING";
    } else if (currentPrice < entryPrice && elapsed >= budgetMinutes * 0.5) {
      status.state = "WEAKENING";
    }
  }

  // v8.3: a red position past its time budget, held for breakeven.
  if (status.tradeType === "DAY" && meta.waitingForBreakevenSince && decision.action === "HOLD" && !meta.partialDone) {
    status.state = "WAITING_BREAKEVEN";
  }
  if (decision.action === "EXIT") status.state = "EXIT";
  return status;
}

module.exports = {
  describePositionState,
  recordClosedTradeResult,
  isDailyLossLimitHit,
  getDailyLossSnapshot,
  calculatePositionSize,
  checkPreTradeSafety,
  computeRiskLevels,
  decidePositionAction,
  computeMfeProtection,
  sectorBucketFor,
  // v7.1: exported for tests — the session-minutes accounting behind the
  // session-aware DAY time budget.
  computeRegularSessionMinutesBetween,
  getDayHoldElapsed,
  getTimeBudgetMultiplier,
};
