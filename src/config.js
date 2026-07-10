// src/config.js
//
// Single source of truth for every tunable parameter.
//
// v5 (2026-07-04): review-driven upgrade. New sections:
//   - System alerts (Telegram alert throttle for failing components)
//   - Earnings blackout (skip entries with earnings inside the hold window)
//   - Daily AI position reviewer (EXTEND / HOLD / TIGHTEN on open positions)
//   - Rolling drawdown circuit breaker (peak-to-trough, beyond the daily limit)
// v4 (2026-07-03): DAY + SWING upgrade (risk-based sizing, ATR stops,
//   volatility buckets, autonomous discovery, API optimization).
require("dotenv").config();

function num(envName, fallback) {
  const value = parseFloat(process.env[envName]);
  return isNaN(value) ? fallback : value;
}
function int(envName, fallback) {
  const value = parseInt(process.env[envName]);
  return isNaN(value) ? fallback : value;
}
function bool(envName, fallbackTrue) {
  if (fallbackTrue) return process.env[envName] !== "false";
  return process.env[envName] === "true";
}

const config = {
  // ── Capital & sizing ──────────────────────────────────────────────
  dayTradeCapital: num("DT_CAPITAL", 100),
  maxPositionPct: num("DT_MAX_POSITION_PCT", 0.08), // legacy cap (kept for compat)
  maxOpenPositions: int("DT_MAX_OPEN_POSITIONS", 3), // legacy overall cap
  minimumPositionDollars: num("MINIMUM_POSITION_DOLLARS", 10),

  // ── v4: RISK-BASED SIZING ─────────────────────────────────────────
  riskPctDay: num("DT_RISK_PCT_DAY", 0.01),
  riskPctSwing: num("DT_RISK_PCT_SWING", 0.015),
  maxPositionPctDay: num("DT_MAX_POSITION_PCT_DAY", 0.35),
  maxPositionPctSwing: num("DT_MAX_POSITION_PCT_SWING", 0.3),
  maxDayPositions: int("DT_MAX_DAY_POSITIONS", 3),
  maxSwingPositions: int("DT_MAX_SWING_POSITIONS", 2),
  minRiskRewardRatio: num("DT_MIN_RRR", 1.5),

  // ── v4: Drawdown de-risking & compounding ─────────────────────────
  deriskAfterLosingDays: int("DT_DERISK_AFTER_LOSING_DAYS", 2),
  deriskMultiplier: num("DT_DERISK_MULTIPLIER", 0.5),
  capitalFloorPctOfBase: num("DT_CAPITAL_FLOOR_PCT", 0.4),

  // ── v5: ROLLING DRAWDOWN CIRCUIT BREAKER ──────────────────────────
  // The daily loss limit only catches a bad DAY. This catches a slow bleed:
  // if effective capital falls more than this % below its recorded peak,
  // the bot writes data/halt.flag, alerts Telegram, and blocks ALL new
  // entries until you delete the flag file (exits keep running as normal).
  maxDrawdownFromPeakPct: num("DT_MAX_DRAWDOWN_FROM_PEAK_PCT", 0.15),

  // ── v5: EARNINGS BLACKOUT (needs FINNHUB_API_KEY; skipped without it) ─
  // DAY trades: block if earnings TODAY/TOMORROW (window 1 day).
  // SWING trades: block if earnings within this many days.
  earningsBlackoutEnabled: bool("DT_EARNINGS_BLACKOUT_ENABLED", true),
  earningsBlackoutSwingDays: int("DT_EARNINGS_BLACKOUT_SWING_DAYS", 5),
  earningsBlackoutDayDays: int("DT_EARNINGS_BLACKOUT_DAY_DAYS", 1),

  // ── v5: DAILY AI POSITION REVIEWER (Tier 2) ───────────────────────
  // Once per day (Mon-Thu, before the EOD close routine) every open
  // position is re-evaluated: EXTEND (DAY→SWING, ride it), HOLD, or
  // TIGHTEN (deterministic stop pull-in). This is the mechanism that lets
  // a working DAY trade hold 2-3 more days instead of force-closing.
  reviewerEnabled: bool("DT_REVIEWER_ENABLED", true),
  reviewerHourET: int("DT_REVIEWER_HOUR_ET", 15),
  reviewerMinuteET: int("DT_REVIEWER_MINUTE_ET", 0),
  // EXTEND guardrails (deterministic — the AI only picks the action):
  reviewerExtendRequiresProfit: bool("DT_REVIEWER_EXTEND_NEEDS_PROFIT", true),
  reviewerMinConfidenceToExtend: int("DT_REVIEWER_MIN_CONF_EXTEND", 7),
  // TIGHTEN: new stop = currentPrice × (1 − stopDistance × this factor)
  reviewerTightenStopFactor: num("DT_REVIEWER_TIGHTEN_FACTOR", 0.5),

  // ── v5.1: LIQUIDITY / SPREAD FLOOR ────────────────────────────────
  // Reject entries where average daily dollar volume is below this floor —
  // thin names get wide spreads and bad fills on a small position. Only
  // enforced when the figure is actually known (never blocks on "unknown").
  minAverageDollarVolume: num("DT_MIN_AVG_DOLLAR_VOLUME", 2000000),

  // ── v5: SYSTEM ALERTS ─────────────────────────────────────────────
  // Same failure re-alerts at most once per this many minutes.
  alertThrottleMinutes: int("DT_ALERT_THROTTLE_MINUTES", 30),
  // Discovery failing this many CONSECUTIVE scans → Telegram alert
  // (discovery is fail-open by design, so without this it goes dark silently)
  discoveryFailureAlertThreshold: int("DT_DISCOVERY_FAIL_ALERT_AFTER", 3),

  // ── v4: Swing parameters ──────────────────────────────────────────
  dayAtrStopMultiple: num("DT_DAY_ATR_STOP_MULT", 0.5),
  swingAtrStopMultiple: num("DT_SWING_ATR_STOP_MULT", 1.5),
  dayStopClampMinPct: num("DT_DAY_STOP_MIN_PCT", 0.01),
  dayStopClampMaxPct: num("DT_DAY_STOP_MAX_PCT", 0.03),
  swingStopClampMinPct: num("DT_SWING_STOP_MIN_PCT", 0.03),
  swingStopClampMaxPct: num("DT_SWING_STOP_MAX_PCT", 0.08),
  swingMaxHoldDays: int("DT_SWING_MAX_HOLD_DAYS", 10),
  swingEntryDaysET: (process.env.DT_SWING_ENTRY_DAYS || "1,2,3")
    .split(",")
    .map((dayString) => parseInt(dayString.trim()))
    .filter((dayNumber) => !isNaN(dayNumber)),
  // FIRST-MONTH RULE: ALL positions force-close before Friday's US close.
  fridayCloseAll: bool("DT_FRIDAY_CLOSE_ALL", true),

  // ── v4: Volatility buckets (ATR as % of price) ───────────────────
  lowVolAtrPct: num("DT_LOW_VOL_ATR_PCT", 2.5),
  highVolAtrPct: num("DT_HIGH_VOL_ATR_PCT", 5.0),
  highVolSizeMultiplier: num("DT_HIGH_VOL_SIZE_MULT", 0.7),

  // ── v4: Autonomous discovery ──────────────────────────────────────
  discoveryEnabled: bool("DT_DISCOVERY_ENABLED", true),
  discoveryMaxCandidates: int("DT_DISCOVERY_MAX_CANDIDATES", 6),
  discoveryMinChangePct: num("DT_DISCOVERY_MIN_CHANGE_PCT", 3.0),
  discoveryMinPrice: num("DT_DISCOVERY_MIN_PRICE", 2),
  discoveryMaxPrice: num("DT_DISCOVERY_MAX_PRICE", 500),
  discoveryMinRelVolume: num("DT_DISCOVERY_MIN_REL_VOLUME", 2.0),
  discoveryFirstTradeSizeMultiplier: num("DT_DISCOVERY_FIRST_SIZE_MULT", 0.5),

  // ── v4: API optimization ──────────────────────────────────────────
  enrichCacheMinutes: int("DT_ENRICH_CACHE_MINUTES", 25),
  enrichCacheMaxPriceMovePct: num("DT_ENRICH_CACHE_MAX_MOVE_PCT", 0.3),
  adaptiveChopScanMinutes: int("DT_ADAPTIVE_CHOP_SCAN_MINUTES", 20),
  volatilitySpikeSpyPct: num("DT_VOL_SPIKE_SPY_PCT", 1.0),
  dailyAtrCacheHours: int("DT_DAILY_ATR_CACHE_HOURS", 20),

  // ── Risk levels (legacy day-trade %s — still used as clamps/fallbacks) ─
  stopLossPct: num("DT_STOP_LOSS_PCT", 0.02),
  takeProfitPct: num("DT_TAKE_PROFIT_PCT", 0.03),
  takeProfitRunnerPct: num("DT_TAKE_PROFIT_RUNNER_PCT", 0.05),
  dailyLossLimitPct: num("DT_DAILY_LOSS_LIMIT_PCT", 0.05),

  // ── Partial scaling & trailing ────────────────────────────────────
  partialExitFraction: num("DT_PARTIAL_EXIT_FRACTION", 0.5),
  trailingStopPct: num("DT_TRAILING_STOP_PCT", 0.025),
  maxHoldMinutes: int("DT_MAX_HOLD_MINUTES", 90),

  // ── Momentum scanner thresholds ───────────────────────────────────
  minVolumeRatio: num("DT_MIN_VOLUME_RATIO", 1.5),
  gapThresholdPct: num("DT_GAP_THRESHOLD_PCT", 2.0),
  breakoutLookbackDays: int("DT_BREAKOUT_LOOKBACK_DAYS", 5),
  rsiMomentumMin: num("DT_RSI_MOMENTUM_MIN", 55),
  rsiOverextendedMax: num("DT_RSI_OVEREXTENDED_MAX", 78),
  maxCandidates: int("DT_MAX_CANDIDATES", 8),

  // ── Filters ───────────────────────────────────────────────────────
  // v5.5: was -0.3 — too strict. This hard gate BLOCKED EVERY STOCK
  // regardless of individual strength any time SPY was mildly red, which
  // duplicated (and preempted) the per-candidate relative-strength filter
  // in momentum-scanner.js that already does this judgment correctly.
  spyMinChangePctForLongs: num("DT_SPY_MIN_CHANGE_PCT", -1.0),
  requireAboveVwap: bool("DT_REQUIRE_ABOVE_VWAP", true),
  maxPerSectorBucket: int("DT_MAX_PER_SECTOR_BUCKET", 2),

  // ── Time-of-day rules (ET) ────────────────────────────────────────
  // 24/5 mode: trade eToro's overnight-eligible stocks around the clock
  // (Sun 8 PM ET → Fri 8 PM ET). When ON, the session-timing gate stops
  // blocking pre-market/overnight entries entirely — see session-timing.js
  // and market-hours.js. Must be paired with DT_TRADE_24_5 there (same env).
  trade24_5: bool("DT_TRADE_24_5", false),
  // 24/5 overnight holds: when ON (and trade24_5 is ON), the Mon–Thu EOD
  // close keeps PROFITABLE DAY positions running overnight instead of
  // force-closing them — the 24/5 exit engine (stops/targets/trailing) keeps
  // managing them live. Losers/flat DAY positions still close at EOD, and
  // Friday still closes EVERYTHING for the weekend. A DAY position must be at
  // least overnightHoldMinProfitPct in the green at EOD to be held over.
  hold24_5Overnight: bool("DT_HOLD_24_5_OVERNIGHT", false),
  overnightHoldMinProfitPct: num("DT_OVERNIGHT_HOLD_MIN_PROFIT_PCT", 0),
  // Pre-market entries: OFF by default. ON = allow new entries during the
  // pre-market window (from premarketStartHourET ET) instead of blocking
  // until 9:30. (24/5 mode above already implies this and more.)
  allowPremarketEntries: bool("DT_ALLOW_PREMARKET", false),
  premarketStartHourET: int("DT_PREMARKET_START_HOUR_ET", 4),
  skipLunchChop: bool("DT_SKIP_LUNCH_CHOP", true),
  lunchStartHourET: int("DT_LUNCH_START_HOUR_ET", 11),
  lunchStartMinET: int("DT_LUNCH_START_MIN_ET", 30),
  lunchEndHourET: int("DT_LUNCH_END_HOUR_ET", 14),
  lunchEndMinET: int("DT_LUNCH_END_MIN_ET", 0),
  skipFirstMinutesAfterOpen: int("DT_SKIP_FIRST_MINUTES", 5),
  sectorRotationMinChangePct: num("DT_SECTOR_ROTATION_MIN_PCT", 0.5),
  sectorRotationMaxBonus: num("DT_SECTOR_ROTATION_MAX_BONUS", 8),
  // ── Scan & EOD ────────────────────────────────────────────────────
  scanIntervalMinutes: int("DT_SCAN_INTERVAL_MINUTES", 10),
  forceCloseMinutesBeforeClose: int("DT_FORCE_CLOSE_MINUTES_BEFORE_CLOSE", 15),

  // ── v3: cooldown, relative strength, regime, slippage ─────────────
  tradeCooldownMinutes: int("DT_TRADE_COOLDOWN_MINUTES", 30),
  minRelativeStrengthVsSpyPct: num("DT_MIN_RS_VS_SPY_PCT", 0.5),
  chopRangeThresholdPct: num("DT_CHOP_RANGE_THRESHOLD_PCT", 0.5),
  chopRegimeScoreBonus: num("DT_CHOP_REGIME_SCORE_PENALTY", 15),
  slippageBufferPct: num("DT_SLIPPAGE_BUFFER_PCT", 0.001),
};

module.exports = config;
