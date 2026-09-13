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
  // dayTradeCapital is the AGENT PORTFOLIO's capital — all sizing/risk/
  // safety math runs on this number, unchanged. realAccountCapital is
  // YOUR real eToro balance, which copies the agent portfolio proportionally
  // (realAccountCapital / dayTradeCapital = your copy ratio). It ONLY
  // affects display — Telegram messages show YOUR real dollars, computed
  // from this ratio, while every internal calculation still uses the
  // agent portfolio's real numbers. Defaults equal to dayTradeCapital
  // (ratio 1, no scaling) so this is a no-op until explicitly configured.
  dayTradeCapital: num("DT_CAPITAL", 100),
  realAccountCapital: num("DT_REAL_ACCOUNT_CAPITAL", num("DT_CAPITAL", 100)),
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

  // ── LIVE SPREAD GUARD AT ENTRY ────────────────────────────────────
  // Just before opening, the live bid/ask spread is checked; wider than
  // this fraction of price → entry blocked. A wide spread is an instant
  // loss on fill (BRAI: -2.9% stop but -4.0% realized in ONE minute — the
  // extra ~1% was spread). Fail-open if the rate can't be fetched.
  maxSpreadPct: num("DT_MAX_SPREAD_PCT", 0.01),

  // ── v5.1: LIQUIDITY / SPREAD FLOOR ────────────────────────────────
  // Reject entries where average daily dollar volume is below this floor —
  // thin names get wide spreads and bad fills on a small position. Only
  // enforced when the figure is actually known (never blocks on "unknown").
  // v7.7: raised from $2M to $15M. Discovery is a "% biggest gainers"
  // screen, so it structurally surfaces low-float micro-cap spikes — live
  // examples from the log: CBRS +14.2%, RCMT +12.9%, DUOT +10.8%, BUUU,
  // FXHO, CCXIU. None of those are companies anyone would choose to own;
  // they are the shape of stock that appears on a gainers list.
  //
  // Result of the old floor: 2 discovered trades ever executed, both
  // losers (-$1.42), while every scan spent quote and AI budget screening
  // the rest. $15M/day comfortably clears every real company on the
  // watchlist (the smallest, SOUN/IONQ/RKLB, trade far above it) while
  // removing most of the junk before it costs anything.
  minAverageDollarVolume: num("DT_MIN_AVG_DOLLAR_VOLUME", 15000000),

  // ── v5: SYSTEM ALERTS ─────────────────────────────────────────────
  // Same failure re-alerts at most once per this many minutes.
  alertThrottleMinutes: int("DT_ALERT_THROTTLE_MINUTES", 30),
  // Discovery failing this many CONSECUTIVE scans → Telegram alert
  // (discovery is fail-open by design, so without this it goes dark silently)
  discoveryFailureAlertThreshold: int("DT_DISCOVERY_FAIL_ALERT_AFTER", 3),

  // ── v4: Swing parameters ──────────────────────────────────────────
  // v8 (2026-09-12): DAY stop widened 0.5x -> 1.0x daily ATR, clamp 3% -> 5%.
  // Sizing is risk-based, so the SAME dollars are risked on a smaller
  // position. Replayed with src/replay-exits.js on the 210 real entries plus
  // 2,055 journal entries, split at 2026-08-22 (avgR per unit of risk):
  //
  //   stop       extended IS   extended OOS   real trades IS   real trades OOS
  //   0.5x ATR     -0.050         -0.080          +0.041           -0.149
  //   0.75x        -0.033         -0.042          +0.023           -0.048
  //   1.0x (5%)    -0.028         -0.027          +0.017           -0.032
  //   1.25x        -0.018         -0.022          +0.014           -0.028
  //
  // The curve is monotonic, so 1.0x is a middle point, not a fitted optimum.
  // Stopped-out trades rose a median +2.65% within 4h of the stop: a 0.5x ATR
  // stop sat inside normal intraday noise. Trade-off, stated plainly: winners
  // are smaller in dollars and capital utilization roughly halves. No
  // variant made the strategy profitable — this reduces the bleed per unit
  // of risk (and halves drawdown); it does not create an edge.
  dayAtrStopMultiple: num("DT_DAY_ATR_STOP_MULT", 1.0),
  swingAtrStopMultiple: num("DT_SWING_ATR_STOP_MULT", 1.5),
  dayStopClampMinPct: num("DT_DAY_STOP_MIN_PCT", 0.01),
  dayStopClampMaxPct: num("DT_DAY_STOP_MAX_PCT", 0.05),
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
  // Upper bound on the day's move for a DISCOVERED candidate. A stock
  // already up 40%+ is a pump top, not a momentum entry — BRAI (+45%)
  // stopped out in ONE MINUTE at -4% on 2026-07-14; VEEE showed +478%.
  discoveryMaxChangePct: num("DT_DISCOVERY_MAX_CHANGE_PCT", 25),
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

  // ── MFE GIVEBACK ENGINE (DAY exits) ───────────────────────────────
  // One volatility-adjusted profit-protection rule (replaces the breakeven
  // ratchet, the age-gated profit guard, and the tightened runner trail —
  // see risk-manager.js for the forensic evidence). Arms as soon as the
  // trade's best gain (MFE) reaches mfeArmAtrFraction of the stock's own
  // daily ATR (floored at mfeArmMinPct when ATR is small/unknown). Once
  // armed: allowed giveback from the peak =
  //   min((1 - mfeRetention) × MFE, mfeGivebackAtrCap × dailyATR)
  // and the exit floor never sits below breakeven.
  mfeArmAtrFraction: num("DT_MFE_ARM_ATR_FRACTION", 0.25),
  mfeArmMinPct: num("DT_MFE_ARM_MIN_PCT", 0.003),
  mfeRetention: num("DT_MFE_RETENTION", 0.6),
  mfeGivebackAtrCap: num("DT_MFE_GIVEBACK_ATR_CAP", 0.3),
  mfeGivebackFallbackPct: num("DT_MFE_GIVEBACK_FALLBACK_PCT", 0.005),

  // ── Stop-loss whipsaw confirmation ────────────────────────────────
  // A SHALLOW breach of the stop (within stopWickBandPct below it) must
  // persist for stopConfirmTicks consecutive 1-minute exit-monitor ticks
  // before exiting — filters the "brief dip below the stop, then bounces
  // right back" whipsaw. A DEEP breach (beyond the band) exits immediately:
  // that's a real breakdown, not noise. Worst-case cost of waiting: one
  // extra minute inside the band (~stopWickBandPct of position).
  stopConfirmTicks: int("DT_STOP_CONFIRM_TICKS", 2),
  stopWickBandPct: num("DT_STOP_WICK_BAND_PCT", 0.005),

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
  // v7.7: raised 8 -> 12. Candidates are sorted by score and sliced to this
  // cap, and the score rises with volatility — so with only 8 slots the
  // newly added calm, diversified names would rank below the semis and be
  // cut before ever reaching the AI. More slots + the ATR ceiling above is
  // what actually lets diversification reach the decision stage.
  maxCandidates: int("DT_MAX_CANDIDATES", 12),

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

  // ── v6 (2026-07-21, review-driven upgrade) ────────────────────────
  //
  // GHOST-POSITION RECONCILIATION: position-meta.json can silently diverge
  // from eToro's real portfolio (a position closes via stop/target/manual
  // action while the bot's own exit path never runs — e.g. a crash between
  // the eToro close call and the meta delete). A meta entry with NO
  // matching live eToro position, older than this grace window (protects
  // against genuine order-settlement lag on a JUST-opened position), is
  // cleared as a "ghost" — otherwise it permanently blocks re-entry (the
  // no-pyramiding guard) and inflates the day/swing slot count forever.
  ghostPositionGraceMinutes: int("DT_GHOST_GRACE_MINUTES", 5),

  // RECOVERY-AWARE TIME EXITS: TIME_EXIT_STALE (DAY) and SWING_TIME_EXIT
  // (SWING) used to fire purely on the clock, with no read on whether the
  // position was actually stabilizing/recovering. Both now check a short
  // recent-price trend before force-exiting a LOSING/flat position, and
  // grant ONE bounded grace extension if the trend looks like a recovery —
  // never unlimited, and the hard stop-loss/floor remains fully live and
  // unaffected throughout any extension.
  recoveryCheckEnabled: bool("DT_RECOVERY_CHECK_ENABLED", true),
  recoveryCheckMinSamples: int("DT_RECOVERY_MIN_SAMPLES", 3),
  recoveryCheckMinSlopePct: num("DT_RECOVERY_MIN_SLOPE_PCT", 0.05),
  dayStaleGraceExtensionMinutes: int("DT_DAY_STALE_GRACE_MINUTES", 45),
  swingTimeExitGraceExtensionDays: num("DT_SWING_TIME_GRACE_DAYS", 3),

  // PROFIT-STALL LOCK: if a DAY position is in profit but hasn't made a new
  // peak (high-water mark) in this many minutes, lock in gains with a
  // partial exit — UNLESS the short-term trend still looks like it's about
  // to make a new high, in which case the stall check just re-arms instead
  // of exiting. This is distinct from the existing MFE-giveback engine
  // (which reacts to giving back PRICE from the peak); this reacts to
  // flatlining WITHOUT necessarily giving anything back.
  profitStallEnabled: bool("DT_PROFIT_STALL_ENABLED", true),
  profitStallMinMinutes: int("DT_PROFIT_STALL_MIN_MINUTES", 45),
  profitStallMinProfitPct: num("DT_PROFIT_STALL_MIN_PROFIT_PCT", 0.4),
  profitStallLockFraction: num("DT_PROFIT_STALL_LOCK_FRACTION", 0.5),

  // VOLATILITY-SCALED TIME BUDGETS: a HIGH-ATR name should show its hand
  // fast; a LOW-ATR name legitimately needs longer to develop. Multiplies
  // config.maxHoldMinutes / swingMaxHoldDays by bucket before the
  // stale/time-exit checks apply. MEDIUM bucket is always ×1 (the
  // configured default values ARE the medium-bucket numbers).
  timeBudgetLowVolMultiplier: num("DT_TIME_BUDGET_LOW_VOL_MULT", 1.5),
  timeBudgetHighVolMultiplier: num("DT_TIME_BUDGET_HIGH_VOL_MULT", 0.7),

  // RE-ENTRY JUSTIFICATION (averaging-down / re-buy discipline): this bot
  // never pyramids (no scale-in on an OPEN position — held symbols are
  // always excluded from candidates), so "averaging down" in practice means
  // RE-ENTERING a symbol shortly after it closed for a LOSS. A loss-close
  // now gets a LONGER cooldown than a normal exit, and re-entry inside that
  // window requires a meaningfully STRONGER setup than the one that lost
  // (higher score), not just "a setup re-fired."
  lossCooldownMultiplier: num("DT_LOSS_COOLDOWN_MULTIPLIER", 2.0),
  lossReentryMinScoreImprovement: num(
    "DT_LOSS_REENTRY_MIN_SCORE_IMPROVEMENT",
    15,
  ),

  // PRE-OPEN / OPEN-VOLATILITY BUY BLACKOUT: blocks NEW entries only (never
  // exits/EOD closes) from (open - N min) to (open + M min) ET, but ONLY
  // when SPY/market conditions are actually weak — a strong tape trades
  // through the open just fine. Matters most in 24/5 mode (DT_TRADE_24_5),
  // which otherwise bypasses every session-timing gate entirely.
  preOpenBlackoutEnabled: bool("DT_PRE_OPEN_BLACKOUT_ENABLED", true),
  preOpenBlackoutMinutesBefore: int("DT_PRE_OPEN_BLACKOUT_BEFORE_MIN", 60),
  postOpenBlackoutMinutesAfter: int("DT_POST_OPEN_BLACKOUT_AFTER_MIN", 30),
  // "Weak" = SPY change at/below this, OR VIX-aware regime already read as
  // bearish-ish (reuses spyMinChangePctForLongs as the floor by default so
  // there's one source of truth for "SPY is weak").
  preOpenBlackoutSpyWeakPct: num(
    "DT_PRE_OPEN_BLACKOUT_SPY_WEAK_PCT",
    num("DT_SPY_MIN_CHANGE_PCT", -1.0),
  ),

  // LIVE CAPITAL RECONCILIATION: effectiveCapital was purely a local ledger
  // (base + cumulative realized P&L), never checked against the REAL eToro
  // agent-portfolio equity. If they drift beyond this tolerance (deposits,
  // withdrawals, a missed/ghost close, manual intervention), the ledger is
  // corrected to match the live account and the correction is logged/alerted
  // — never silent.
  capitalReconciliationTolerancePct: num(
    "DT_CAPITAL_RECONCILE_TOLERANCE_PCT",
    0.01,
  ),

  // REAL-TIME EXIT WATCHDOG (eToro WebSocket): the 1-minute exit-monitor
  // tick is already fast, but a live tick stream closes even that gap for
  // the disaster case — an estimated hard-stop-level breach triggers an
  // IMMEDIATE off-cycle exit-monitor run instead of waiting up to 60s.
  // Ticks only TRIGGER a check; eToro's own P&L via REST remains the source
  // of truth for the actual close decision (identical philosophy to the
  // sibling long-term bot's etoro-price-stream.js).
  priceStreamEnabled: bool("DT_PRICE_STREAM_ENABLED", true),
  priceStreamHardStopMultiplier: num("DT_PRICE_STREAM_HARD_STOP_MULT", 1.5),

  // ── v7 (2026-07-25, AI decision-layer rewrite) ────────────────────
  //
  // MARKET BRIEF (src/strategies/market-context.js): one compact macro
  // block, built once per scan and shared by BOTH AI prompts. Costs one
  // extra batched rates call per marketBriefIndexCacheMinutes plus a
  // 6h-cached FRED series. Disable to fall back to the v6 behaviour
  // (SPY % + regime word only) without touching code.
  marketBriefEnabled: bool("DT_MARKET_BRIEF_ENABLED", true),
  marketBriefIndexCacheMinutes: int("DT_MARKET_BRIEF_INDEX_CACHE_MIN", 10),
  // Below this many quoted names, watchlist breadth is reported as
  // unavailable rather than computed from a sample too small to mean
  // anything (3 names "60% advancing" is noise, not breadth).
  marketBriefMinBreadthSample: int("DT_MARKET_BRIEF_MIN_BREADTH_SAMPLE", 5),
  // Below this many available signals, risk tone is UNKNOWN rather than
  // guessed — an honest abstention beats a confident coin-flip.
  marketBriefMinToneSignals: int("DT_MARKET_BRIEF_MIN_TONE_SIGNALS", 3),

  // AI OUTPUT BUDGETS. Both prompts now emit short structured reasoning
  // fields BEFORE their verdict (the decision is generated last, so it is
  // conditioned on the evidence the model just wrote out). That costs more
  // output tokens than v6's bare verdict+reasoning, so the old max_tokens
  // of 300 would truncate mid-JSON and fail the parse.
  screenerMaxTokens: int("DT_SCREENER_MAX_TOKENS", 600),
  reviewerMaxTokens: int("DT_REVIEWER_MAX_TOKENS", 900),

  // SCREENER CONFIDENCE FLOOR: a TAKE carrying confidence below this is
  // downgraded to SKIP in code. Deliberately permissive by default (only
  // 1-3 of 10 blocked) — this bot has a documented history of the screener
  // rejecting nearly everything, and a tight floor here would recreate it.
  // Raise toward 6-7 only if the journal shows low-confidence TAKEs losing.
  screenerMinConfidenceToTake: int("DT_SCREENER_MIN_CONF_TAKE", 4),

  // REVIEWER — DYNAMIC TRADE MANAGEMENT. v6 gave the daily reviewer three
  // actions (EXTEND / HOLD / TIGHTEN); v7 adds banking a partial and
  // closing outright, each behind its own confidence floor and its own
  // deterministic guardrails in applyReviewDecision(). Every floor is
  // enforced in CODE, never trusted to the prompt.
  reviewerAllowTakePartial: bool("DT_REVIEWER_ALLOW_TAKE_PARTIAL", true),
  reviewerTakePartialFraction: num("DT_REVIEWER_TAKE_PARTIAL_FRACTION", 0.5),
  reviewerMinConfidenceToTakePartial: int("DT_REVIEWER_MIN_CONF_PARTIAL", 6),
  // CLOSE is the most destructive action the reviewer can request, so it
  // carries the highest bar. Every AI-initiated close is also registered
  // with the exit-shadow tracker, so "was the AI right to bail?" becomes
  // measurable evidence instead of an opinion.
  reviewerAllowClose: bool("DT_REVIEWER_ALLOW_CLOSE", true),
  reviewerMinConfidenceToClose: int("DT_REVIEWER_MIN_CONF_CLOSE", 7),
  // Floor for a TIGHTEN driven by the reviewer's own stated maximum
  // acceptable drawdown. Without it, a model that answers "0.3%" would
  // place the stop inside normal spread and guarantee an instant stop-out.
  reviewerTightenMinStopPct: num("DT_REVIEWER_TIGHTEN_MIN_STOP_PCT", 0.005),

  // ── v7.1 (2026-07-27) — production bug fixes found in live pm2 logs ──
  //
  // GROSS EXPOSURE CAP. Per-position caps cannot bound the book:
  // maxPositionPctDay 0.35 × maxDayPositions 3 = 105% of capital by
  // construction. On 2026-07-27 the bot opened 5 positions in one scan
  // totalling 125% of effective capital. This caps the SUM of everything
  // open. Set to 0 to disable.
  maxTotalExposurePct: num("DT_MAX_TOTAL_EXPOSURE_PCT", 0.9),

  // RE-ENTRY BAR CEILING. momentum-scanner caps scores at 100, so
  // "priorScore + 15" becomes unreachable above 85 and silently bans a
  // symbol forever (AMD lost at 88, needed 103, was rejected 13 times in
  // three hours). The bar is clamped to this reachable maximum.
  reentryMaxRequiredScore: num("DT_REENTRY_MAX_REQUIRED_SCORE", 90),

  // v7.12 — HOW LONG THE RE-ENTRY SCORE PENALTY LASTS.
  //
  // checkCooldown() has always respected `exitAtMs`, but
  // getReentryJustification() never read it, so the SCORE half of the
  // penalty was PERMANENT. Measured on the live server 2026-09-01: 26
  // symbols carrying a penalty, 24 of them requiring a score of 90, from
  // losses up to 41 DAYS old — AAPL (39d), MSFT (33d), AVGO (33d). The
  // whole watchlist peaked at 87 that day, so those names could not be
  // bought at all, and roughly half the watchlist was silently retired.
  //
  // A loss six weeks ago says nothing about today's setup. The penalty is
  // meant to stop revenge-trading the same broken idea within days, so it
  // now decays. 5 trading days is deliberately generous.
  reentryPenaltyExpiryHours: num("DT_REENTRY_PENALTY_EXPIRY_HOURS", 120),

  // SESSION-AWARE TIME BUDGETS. maxHoldMinutes is a REGULAR-SESSION
  // number; measuring it on the wall clock kills pre-market positions that
  // never got a single minute of the session they were sized for (SNAP,
  // RIVN and AVGO all died this way on the Monday pre-market of
  // 2026-07-27, and TIME_EXIT_STALE is 71% of all exits ever made).
  // When true, the DAY hold budget is spent in real trading minutes only.
  sessionAwareTimeBudgets: bool("DT_SESSION_AWARE_TIME_BUDGETS", true),
  // Absolute wall-clock backstop, as a multiple of maxHoldMinutes, so a
  // position opened before a weekend (when session minutes never accrue)
  // still cannot be held indefinitely. 90min × 8 = 12h by default.
  maxHoldWallClockCeilingMultiplier: num("DT_MAX_HOLD_CEILING_MULT", 8),

  // UNCONFIRMED-POSITION GRACE. eToro's portfolio feed often does not show
  // a position immediately after opening. The short ghost grace now
  // applies only to positions eToro has shown us at least once; a position
  // never confirmed gets this longer window before anything is cleared.
  unconfirmedPositionGraceMinutes: int("DT_UNCONFIRMED_GRACE_MINUTES", 30),

  // OWNER DEPOSITS / WITHDRAWALS. Money the owner moves in or out is not
  // trading P&L. Without this, withdrawing $3,000 from a $9,300 account
  // with a $10,032 peak reads as a 37% drawdown against a 15% limit and
  // halts the bot; and the capital floor (a fraction of the .env base)
  // would keep sizing against money no longer in the account.
  //
  // A drift beyond capitalTransferDetectPct is treated as a transfer: the
  // capital base moves with it and the peak is scaled PROPORTIONALLY,
  // which leaves the drawdown percentage unchanged — so a transfer can
  // neither trip the breaker nor hide an existing breach. Smaller drifts
  // keep the old conservative handling (correct the ledger, never lower
  // the peak), since those are more likely an untracked/ghost close.
  //
  // For an exact, declared transfer use:  node src/capital-adjust.js -3000
  capitalAutoDetectTransfers: bool("DT_CAPITAL_AUTO_DETECT_TRANSFERS", true),
  capitalTransferDetectPct: num("DT_CAPITAL_TRANSFER_DETECT_PCT", 0.05),
  // v7.3: how many CONSECUTIVE checks must show the same large drift before
  // the capital base is rewritten. Added after a single bad equity reading
  // (cash reserved for two queued orders) was converted into a $6,596.66
  // phantom withdrawal on 2026-07-31. A real transfer persists; an artefact
  // does not. Money movement is never urgent — waiting is free, acting on a
  // false positive destroys the capital baseline silently.
  capitalTransferConfirmCycles: int("DT_CAPITAL_TRANSFER_CONFIRM_CYCLES", 3),

  // ── v7.2 (2026-07-27) — LIVE POSITION INTEGRITY ────────────────────
  //
  // SELF-HEALING SYNC. dollarAmount and entryPrice were written once at
  // open and never re-checked. Measured live: META was tracked at $2,150
  // while eToro actually held $1,113.74 — 93% wrong, for four hours.
  // These tolerances decide when the bot corrects its own record against
  // the real account. Amount drift is common (partial fills), so it is a
  // straight correction; an entry-price drift additionally rescales the
  // stop/target geometry so the intended risk percentage is preserved.
  positionSyncAmountTolerancePct: num("DT_POSITION_SYNC_AMOUNT_TOL", 0.02),
  // 0.05%. Deliberately tight: the largest entry drift measured on the live
  // account was QCOM at 0.097% (tracked $170.735 vs a real $170.90), which
  // put the derived price $0.16 away from the truth against a stop only
  // $3.80 wide. A 0.2% threshold would have ignored every real case seen.
  // eToro's openRate is static once filled, so correcting it cannot churn.
  positionSyncEntryTolerancePct: num("DT_POSITION_SYNC_ENTRY_TOL", 0.0005),

  // UNTRACKED POSITIONS. A live position with no meta entry used to be
  // skipped silently by both the exit monitor and the EOD closer — no
  // stop, no exit, no alert, forever. If the bot previously ghost-cleared
  // that symbol and it reappears within this window, its saved plan is
  // restored automatically (that is the RIVN scenario).
  readoptWindowMinutes: int("DT_READOPT_WINDOW_MINUTES", 720), // 12h

  // Positions the bot never opened (a manual trade, say) are ALERTED on
  // but not touched, because closing someone else's deliberate trade is
  // not the bot's business. Turn this on to have it adopt and protect
  // them instead, using the percentage stop below.
  adoptForeignPositions: bool("DT_ADOPT_FOREIGN_POSITIONS", false),
  adoptedPositionStopPct: num("DT_ADOPTED_POSITION_STOP_PCT", 0.03),

  // ── v7.4 (2026-08-06) — EDGE FILTERS FROM THE 114-TRADE AUDIT ──────
  //
  // MINIMUM ENTRY SCORE. Measured across 114 closed trades, every score
  // band below 80 lost money and the three of them cost $476.24 combined:
  //
  //     score  0-49 : 27 trades  48% win  -$97.01
  //     score 50-64 : 24 trades  38% win  -$218.92
  //     score 65-79 : 18 trades  50% win  -$160.31
  //     score 80+   : 45 trades  60% win  +$166.68   <- the only profitable band
  //
  // Note the score correlates only 0.157 with P&L as a CONTINUOUS value
  // but behaves strongly as a THRESHOLD — it carries information at its
  // extreme and noise everywhere else. So it is used as a gate here, not
  // as a ranking. Set to 0 to disable.
  //
  // CAVEAT worth remembering: 80 is defensible because the effect is
  // monotonic across four bands and the mechanism is plausible, NOT
  // because the number is precise. It is fitted to 114 observations
  // against ~135 tunables. Re-derive it once the replay harness exists.
  minEntryScore: num("DT_MIN_ENTRY_SCORE", 80),

  // OVERNIGHT DEAD ZONE (Eastern time). The audit tested whether the
  // score gate alone rescues 24/5 trading. It rescues every session
  // EXCEPT this one:
  //
  //     00:00-04:00 ET, score 80+ :  3 trades   0% win  -$27.07/trade
  //     04:00-09:00 ET, score 80+ :  5 trades  80% win  +$12.25/trade
  //     09:00-16:00 ET, score 80+ : 32 trades  59% win   +$3.46/trade
  //     16:00-24:00 ET, score 80+ :  5 trades  80% win  +$15.17/trade
  //
  // All 16 overnight trades lost money regardless of score; high-score
  // ones lost FASTEST. Deep overnight has no liquidity to move a position
  // in your favour, volume data is unavailable, and the regime classifier
  // is definitionally blind. So 24/5 stays ON — only this window closes.
  //
  // Blocks NEW ENTRIES only. Exits, stops and EOD closes are untouched.
  overnightDeadZoneEnabled: bool("DT_OVERNIGHT_DEAD_ZONE", true),
  overnightDeadZoneStartHourET: int("DT_DEAD_ZONE_START_ET", 0),
  overnightDeadZoneEndHourET: int("DT_DEAD_ZONE_END_ET", 4),

  // LIVE VOLATILITY via VXX (eToro instrumentId 3163), replacing the
  // 1-3 day stale FRED VIX close as the real-time volatility read. VXX
  // rising while SPY falls = volatility genuinely expanding right now,
  // which is actionable in a way that a two-day-old VIX print is not.
  // FRED is retained as the slow absolute-level reference.
  vxxExpansionPct: num("DT_VXX_EXPANSION_PCT", 3.0),
  // v7.6: VXX loses roughly 0.2-0.4%/day structurally to futures-roll
  // decay (contango), so its neutral baseline is NOT zero — it is slightly
  // negative. A "volatility collapsing" call must clear this drift before
  // it counts, otherwise ordinary decay reads as a genuine vol crush and
  // votes risk-on for no reason. Expansion is unaffected: decay biases
  // VXX downward, so an UP move is if anything understated.
  vxxContangoDriftPct: num("DT_VXX_CONTANGO_DRIFT_PCT", 0.4),

  // ── v7.7 (2026-08-06) — SELECTION-BIAS FIXES FROM THE FORENSIC AUDIT ──
  //
  // VOLATILITY CEILING. Set from a clean split in 172 closed trades
  // (ATR<5%: 56% win +$31.13 · ATR>=7%: 43% win -$280.88).
  //
  // HELD AT 7.0 FOR THE ONE-MONTH TEST — deliberately, despite contrary
  // evidence. The replay harness tested this against 7,197 historical
  // scored candidates (~34x the evidence) and 5% looked materially better:
  //
  //     ceiling   trades   avg/trade
  //     any        7197     +$1.17
  //     9%         6228     -$0.28
  //     8%         5858     -$0.38
  //     7%         5153     -$0.57   <- current
  //     6%         4337     +$1.13
  //     5%         2678     +$2.28
  //
  // It was briefly changed to 5.0 and reverted the same day. Two reasons:
  //
  //   1. The curve is NON-MONOTONIC — tightening from "any" to 9% makes
  //      things WORSE before improving below 6%. A structural signal
  //      improves steadily as it tightens; this dips and rebounds, which
  //      means some of the apparent edge is noise.
  //
  //   2. Changing it now would make the month test a setting chosen by the
  //      same evidence the month is supposed to validate. The month needs
  //      to be an INDEPENDENT sample, and 5% would also roughly halve
  //      trade count (5153 -> 2678) right when sample size matters most.
  //
  // Re-run `node src/replay-harness.js --sweep atr` after the month, on
  // data this setting did not help select. If 5% still wins on a genuinely
  // independent sample, change it then. Set to 0 to disable.
  maxEntryAtrPct: num("DT_MAX_ENTRY_ATR_PCT", 7.0),

  // PRE-FILTER MOVE GATE. Previously hardcoded at 1.0% in
  // momentum-scanner.js; now configurable, but the value is deliberately
  // left AT 1.0.
  //
  // REVERTED FROM 0.6 (2026-08-28). Lowering it looked right in theory —
  // mega-caps (3.57% avg ATR) clear a 1% bar far less often than semis
  // (7.58%), which is why the most profitable bucket was only 11% of
  // trades. But testing it against history showed the opposite:
  //
  //     move at entry   trades  win%   net P&L    avg
  //     1% to 2%          44     50%   -$77.33   -$1.76
  //     2% to 3%          31     48%  -$368.16  -$11.88
  //     3% to 5%          31     39%  -$220.26   -$7.11
  //     5%+               66     52%  +$156.29   +$2.37
  //
  // The 0.6-1.0% band has ZERO historical trades, so history is silent on
  // it — and the adjacent 1-2% band already loses money. Lowering the gate
  // would have manufactured weaker setups, not better access to good ones.
  prefilterMinMovePct: num("DT_PREFILTER_MIN_MOVE_PCT", 1.0),
  momentumSurgeMinMovePct: num("DT_MOMENTUM_SURGE_MIN_MOVE_PCT", 1.0),

  // VOLATILITY-NORMALIZED MOVE GATE (optional, OFF by default).
  //
  // The real lesson from the test above: what predicts a good trade is not
  // the raw size of the move, but its size RELATIVE TO THAT STOCK'S OWN
  // normal daily range. A 0.6% move means something very different on a
  // 3.5% ATR mega-cap than on a 7.5% ATR semiconductor.
  //
  //     move/ATR ratio  trades  win%   net P&L    avg
  //     0    to 0.3       35     46%  -$126.07   -$3.60
  //     0.3  to 0.6       51     41%  -$440.42   -$8.64
  //     0.6  to 1.0       41     44%  -$258.45   -$6.30
  //     1.0+              45     62%  +$315.48   +$7.01   <- the only
  //                                                          profitable band
  //
  // Set to 1.0 to require a move at least as large as the stock's average
  // daily range. On history that produced 62% wins and +$315.48 — the
  // strongest single filter found anywhere in this system.
  //
  // Left DISABLED (0) by default because it would have cut trade count by
  // roughly 74%, which runs directly against the stated goal of trading
  // MORE. That is a genuine strategy trade-off and belongs to the operator,
  // not to a default. Enable with DT_MIN_MOVE_TO_ATR_RATIO=1.0.
  minMoveToAtrRatio: num("DT_MIN_MOVE_TO_ATR_RATIO", 0),

  // ── v8 (2026-09-12) — AUDIT FIXES ─────────────────────────────────
  //
  // STALE QUOTE GATE. eToro's batched rates carry the timestamp of the last
  // price update, and nothing read it. After the Friday 2026-09-04 close the
  // bot re-planned AMD 24 times at an identical frozen $477.385 and sent
  // every copy to the AI screener; across the journal 1,553 of 7,015 plans
  // were identical-price re-plans within 30 minutes. A candidate whose quote
  // is older than this is dropped before enrichment.
  maxQuoteAgeMinutes: num("DT_MAX_QUOTE_AGE_MINUTES", 15),

  // ENTRY CUTOFFS AROUND THE EOD FORCE-CLOSE (Eastern time).
  // No new entry after the Friday force-close: four positions were opened
  // on a Friday after 15:45 ET (META 07-10, META + GOOGL 07-31, PLTR 08-07)
  // and carried into a weekend with no exit monitor running. That block is
  // unconditional. The pre-close windows are the evidence-sized part:
  // Mon-Thu entries in the last 30 min before the force-close went 2/7,
  // -$113 (true P&L incl. partials). A longer Friday window was considered
  // and NOT adopted — only 2 trades ever landed in it (+$3).
  fridayNoEntryMinutesBeforeClose: int("DT_FRIDAY_NO_ENTRY_MINUTES", 30),
  eodNoEntryMinutesBeforeClose: int("DT_EOD_NO_ENTRY_MINUTES", 30),

  // AI SCREENER DEDUPE. An identical plan (same symbol, entry price and
  // rounded score) is not re-sent within this window; the previous verdict
  // is reused. Saves Haiku calls and keeps verdicts consistent.
  screenerDedupeMinutes: int("DT_SCREENER_DEDUPE_MINUTES", 30),

  // POSITION STATUS LOG. Every Nth exit-monitor tick logs one line per open
  // position (state, P&L, peak, stop, next trim, exit conditions).
  positionStatusEveryTicks: int("DT_POSITION_STATUS_EVERY_TICKS", 10),

  // ── v8.1 (2026-09-13) ─────────────────────────────────────────────
  // EQUITY DRIFT TRAIL. Since v8 the reconciliation compares REALIZED equity
  // with the REALIZED ledger, so any remaining gap is money the bot cannot
  // account for (a position closed outside the bot, a manual close, fees).
  // An EQUITY_DRIFT journal record is written when the gap reaches this many
  // dollars and has moved since the last record; crossing the 1%
  // reconciliation tolerance also raises a Telegram alert.
  equityDriftJournalDollars: num("DT_EQUITY_DRIFT_JOURNAL_DOLLARS", 25),
};

module.exports = config;
