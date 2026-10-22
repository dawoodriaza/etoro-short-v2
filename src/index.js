// src/index.js — eToro Day + Swing Trading Bot (v5)
//
// ═══════════════════════════════════════════════════════════════════════════
// v5 (2026-07-04) — REVIEW-DRIVEN UPGRADE. Changes in this file:
//
//   V1. P0 BUG FIXED (in momentum-scanner.js): a circular require made
//       prefilterCandidates() throw on EVERY scan — the entry pipeline was
//       completely dead. Scanner now imports from market-hours.js.
//   V2. DUPLICATE-POSITION GUARD WIRED UP. findDuplicatePositions existed
//       in etoro-client.js but was never called. Now it runs inside
//       manageOpenPositions on every tick: duplicate positions in a
//       TRACKED symbol are auto-closed (largest kept) + Telegram alert.
//       Untracked symbols are never touched.
//   V3. DAILY LOSS LIMIT NOW USES EFFECTIVE CAPITAL (capital-manager's
//       compounded number), matching what sizing uses — one base, not two.
//   V4. ROLLING DRAWDOWN CIRCUIT BREAKER + HALT FLAG. If effective capital
//       falls config.maxDrawdownFromPeakPct below its recorded peak, the
//       bot writes data/halt.flag, alerts Telegram, and blocks all NEW
//       entries until YOU delete the flag (rm data/halt.flag). Exits and
//       EOD closes keep running. The flag also works as a manual kill
//       switch: create it yourself to pause entries any time.
//   V5. EARNINGS BLACKOUT (needs FINNHUB_API_KEY; skipped without it).
//       Before opening, the bot checks the earnings calendar: SWING plans
//       are blocked if earnings fall within earningsBlackoutSwingDays;
//       DAY plans within earningsBlackoutDayDays.
//   V6. DAILY AI POSITION REVIEWER (Tier 2). Mon-Thu at 15:00 ET (before
//       the 15:45 EOD close) every open position gets one Haiku call:
//       EXTEND (DAY→SWING, holds overnight), HOLD, or TIGHTEN (stop pulled
//       in deterministically). This is the mechanism that lets a working
//       trade ride 2-3 more days instead of force-closing. Friday still
//       closes EVERYTHING (first-month rule).
//   V7. SYSTEM ALERTS EVERYWHERE. Every important function that gets no
//       response now fires a throttled Telegram alert (and a recovery
//       notice when it comes back): SPY quote, Twelve Data quotes, eToro
//       portfolio fetch, AI screener, AI reviewer, discovery (after N
//       consecutive failures), scan-cycle crashes, position open failures,
//       and repeated exit-monitor failures.
//
// v4 capabilities retained: trade-planner (DAY/SWING, ATR stops, T1/T2/T3,
// risk-based sizing), market-discovery, capital compounding + de-risking,
// decision journal, adaptive scanning, enrichment cache.
//
// Pipeline each scan:
//   1. Manage open positions (exits always run, gates never block them)
//      — now includes the duplicate-position reconciliation
//   2. Gates: halt flag / drawdown breaker → daily loss limit (effective
//      capital) → session timing → SPY (fail-closed)
//   3. Watchlist quotes (sequential) + Yahoo discovery merge
//   4. Prefilter → cooldown/held filter → enrich + daily ATR → score
//   5. Build trade PLANS (type, geometry, size, RRR) → AI veto screen
//   6. Open approved plans through pre-trade safety + earnings blackout
require("dotenv").config();
const { CronJob } = require("cron");
const fs = require("fs");
const path = require("path");

const { logger } = require("./logger");
const config = require("./config");
const marketHours = require("./market-hours");
const sectorRotation = require("./strategies/sector-rotation");
const etoroClient = require("./etoro-client");
const marketData = require("./market-data");
const marketDataStream = require("./market-data-stream"); // v5.3
const etoroMarketData = require("./data-sources/etoro-market-data"); // v5.4
const priceStream = require("./etoro-price-stream"); // v6: real-time exit watchdog

const momentumScanner = require("./strategies/momentum-scanner");
const aiScreener = require("./models/ai-screener");
const positionReviewer = require("./models/ai-position-reviewer");
const riskManager = require("./strategies/risk-manager");
const eodCloser = require("./strategies/eod-closer");
const sessionTiming = require("./strategies/session-timing");
const performance = require("./strategies/performance-tracker");
const selfEvaluation = require("./strategies/self-evaluation");
const cooldownTracker = require("./strategies/cooldown-tracker");
const marketRegime = require("./strategies/market-regime");
const marketContextBuilder = require("./strategies/market-context");
const sectorMap = require("./strategies/sector-map"); // v7.8: bucket at entry
const notifications = require("./notifications/telegram");
const alerts = require("./notifications/alerts");
const finnhub = require("./data-sources/finnhub");

const tradePlanner = require("./strategies/trade-planner");
const marketDiscovery = require("./discovery/market-discovery");
const capitalManager = require("./strategies/capital-manager");
const journal = require("./strategies/decision-journal");
const ethicsFilter = require("./strategies/ethics-filter");
const exitShadowTracker = require("./strategies/exit-shadow-tracker");
const { withPositionLock } = require("./position-lock"); // v8: serialises position-meta writers
const shadowSignals = require("./strategies/shadow-signals"); // v8.1: per-candidate shadow log
const {
  escapeHtml,
  humanize,
  describeExitReason,
  toRealDollars,
  formatDualAmount,
  // v8.8 session clock — every scheduled time is printed in ET and Bahrain
  formatSessionSchedule,
  formatMinutesUntil,
  scheduleMoment,
} = require("./notifications/format-helpers");

// v8.8: minutes since ET midnight, for "what is left of the session" lines.
function easternMinuteOfDay() {
  const et = marketHours.getEasternHourMinute();
  return et.hour * 60 + et.minute;
}

const TIMEZONE = "America/New_York";

let scanInProgress = false;
let exitCheckInProgress = false;
let reviewInProgress = false;

// v7: repeated exit-monitor failures must become visible — the exit monitor
// is the bot's only live protection between scans.
let consecutiveExitMonitorFailures = 0;
const EXIT_MONITOR_FAILURE_ALERT_THRESHOLD = 5; // 5 minutes of failures
// v8: passes through manageOpenPositions, for the periodic status line.
let managePositionsCallCount = 0;

// Adaptive-scan state (from the PREVIOUS scan)
let lastScanCompletedAtMs = 0;
let lastKnownRegime = "UNKNOWN";
let lastKnownSpyChangePercent = 0;
// v7: the most recent market brief, carried across cycles so the daily
// position reviewer (which runs on its own cron and does no scan of its own)
// sees the same macro picture the screener saw, rather than just SPY + a
// regime word from the previous scan.
let lastKnownBrief = null;
let lastKnownBriefText = null;

// -----------------------------
// POSITION META STORAGE
// -----------------------------
const positionMetaPath = path.join(__dirname, "../data/position-meta.json");

function loadPositionMeta() {
  try {
    if (!fs.existsSync(positionMetaPath)) return {};
    return JSON.parse(fs.readFileSync(positionMetaPath, "utf8"));
  } catch {
    return {};
  }
}

function savePositionMeta(meta) {
  try {
    const directory = path.dirname(positionMetaPath);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(positionMetaPath, JSON.stringify(meta, null, 2));
  } catch (saveError) {
    logger.warn("Could not save position meta: " + saveError.message);
  }
}

function countOpenByType(meta) {
  let dayCount = 0;
  let swingCount = 0;
  for (const positionMeta of Object.values(meta)) {
    if (positionMeta.tradeType === "SWING") swingCount++;
    else dayCount++;
  }
  return { dayCount, swingCount };
}

// -----------------------------
// WATCHLIST
// -----------------------------
function loadWatchlistEntries() {
  try {
    const watchlistFilePath = path.join(
      __dirname,
      "../watchlist-daytrade.json",
    );
    const watchlistData = JSON.parse(
      fs.readFileSync(watchlistFilePath, "utf8"),
    );
    return (watchlistData.stocks || []).map((entry) => ({
      symbol: entry.symbol,
      bucket: entry.bucket,
      // 24/5 overnight-eligible only when explicitly flagged true.
      night: entry.night === true,
      // v7.7: optional per-symbol position-size multiplier. Lets a name be
      // KEPT but traded smaller, instead of the all-or-nothing choice of
      // leaving it at full size or deleting it. Absent/invalid → 1 (no
      // change), so every existing entry behaves exactly as before.
      sizeMultiplier:
        typeof entry.sizeMultiplier === "number" &&
        entry.sizeMultiplier > 0 &&
        entry.sizeMultiplier <= 1
          ? entry.sizeMultiplier
          : 1,
    }));
  } catch (loadError) {
    logger.error("Watchlist load error: " + loadError.message);
    return [];
  }
}

function loadWatchlist() {
  return loadWatchlistEntries().map((entry) => entry.symbol);
}

function getEasternWeekday() {
  const weekdayName = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  });
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[
    weekdayName
  ];
}

function getEasternWeekdayName() {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
  });
}

// -----------------------------
// V4: HALT FLAG + DRAWDOWN BREAKER GATE
// -----------------------------
// Returns true if new entries are blocked. Alerts ONCE when the breaker
// first trips (capital-manager writes the flag; deleting the file resumes).
async function isTradingHaltedForNewEntries() {
  const breakerCheck = capitalManager.checkDrawdownBreaker();

  if (breakerCheck.tripped) {
    // First trip — make it loud
    recordGateBlock(
      "DRAWDOWN_BREAKER",
      "effective capital " +
        (breakerCheck.drawdownPct * 100).toFixed(1) +
        "% below peak",
    );
    await notifications.sendTelegramMessage(
      "🛑 <b>DRAWDOWN CIRCUIT BREAKER TRIPPED</b>\n" +
        "Effective capital $" +
        breakerCheck.effective.toFixed(2) +
        " is " +
        (breakerCheck.drawdownPct * 100).toFixed(1) +
        "% below peak $" +
        breakerCheck.peak.toFixed(2) +
        " (limit " +
        config.maxDrawdownFromPeakPct * 100 +
        "%).\n\n" +
        "ALL NEW ENTRIES ARE HALTED. Exits and EOD closes keep running.\n" +
        "To resume after reviewing what went wrong:\n" +
        "SSH into the server → <code>rm ~/etoro-v2-short/data/halt.flag</code>",
    );
    return true;
  }

  if (breakerCheck.alreadyHalted) {
    logger.info("🛑 halt.flag present — new entries blocked (exits still run)");
    recordGateBlock("HALT_FLAG", "data/halt.flag exists");
    return true;
  }

  return false;
}

// -----------------------------
// v8: SCAN FUNNEL — why the bot did or did not trade
// -----------------------------
// Before v8 the only way to answer "why no trades today?" was to count
// tens of thousands of CANDIDATE_REJECTED lines by hand. Each scan now ends
// with one line (and one SCAN_FUNNEL journal record) showing how many
// candidates survived each stage, why the rest died, and which gate — if
// any — stopped the scan, e.g.:
//   🧮 Funnel: 54 quoted → 12 moving + 4 discovered → 13 eligible [HELD 2,
//   COOLDOWN 1] → 5 scored [below VWAP 6, weak RS 2] → 3 plans [score floor 2]
//   → AI 1/3 take → 1 opened
let currentScanFunnel = null;
// v8.1: SHADOW_SIGNAL records for the scan in progress (one per candidate).
let currentShadowBook = null;
// v8.1: last realized-equity-vs-ledger gap written to the journal.
let lastRecordedEquityDriftDollars = null;
// v8.2: approved stocks waiting to be bought on a dip (symbol -> order).
// In memory only: a restart drops them and the next scan re-approves.
const pendingDipEntries = new Map();
let dipEntryCheckCount = 0;
let lastCandidateRejection = null; // { symbol, stage, reason, atMs }
// v8.2: today's dip-order counts (New York date) for the EOD Telegram summary.
const dipEntryDayStats = { day: null, armed: 0, bought: 0, notBought: 0 };
function bumpDipEntryStat(key) {
  const today = new Date().toLocaleDateString("en-US", { timeZone: TIMEZONE });
  if (dipEntryDayStats.day !== today) {
    Object.assign(dipEntryDayStats, { day: today, armed: 0, bought: 0, notBought: 0 });
  }
  dipEntryDayStats[key]++;
}

function createScanFunnel() {
  currentScanFunnel = {
    startedAt: new Date().toISOString(),
    gate: null,
    quoted: 0,
    watchlistMovers: 0,
    discovered: 0,
    preEnrichRejects: {},
    eligible: 0,
    scoringRejects: {},
    scored: 0,
    reentryBlocked: 0,
    shortlisted: 0,
    planRejects: {},
    plans: 0,
    aiTake: 0,
    aiSkip: 0,
    armed: 0,
    executionBlocks: {},
    opened: 0,
  };
  return currentScanFunnel;
}

function bumpReason(bucket, key) {
  bucket[key] = (bucket[key] || 0) + 1;
}

function recordGateBlock(gate, reason) {
  if (currentScanFunnel) currentScanFunnel.gate = gate;
  journal.gateBlock(gate, reason);
}

const PRE_ENRICH_REJECT_STAGES = new Set([
  "ETHICS_FILTER",
  "HELD",
  "COOLDOWN",
  "STALE_QUOTE",
  "NOT_ON_ETORO",
]);

function classifyScoringReject(reason) {
  const text = String(reason || "");
  if (/VWAP/.test(text)) return "below VWAP";
  if (/relative strength/.test(text)) return "weak RS";
  if (/no gap\/breakout\/momentum/.test(text)) return "no setup";
  if (/volatility ceiling/.test(text)) return "ATR ceiling";
  if (/volumeRatio/.test(text)) return "low volume";
  if (/daily range/.test(text)) return "move/ATR";
  return "other";
}

function classifyPlanReject(reason) {
  const text = String(reason || "");
  if (/entry floor/.test(text)) return "score floor";
  if (/slots full/.test(text)) return "slots full";
  return "other";
}

// Every candidate rejection goes through here so the funnel counts it.
function recordCandidateRejection(symbol, stage, reason, snapshot) {
  // v8.2: a dip buy that is refused reports this exact stage and reason.
  lastCandidateRejection = { symbol: String(symbol).toUpperCase(), stage, reason, atMs: Date.now() };
  if (currentScanFunnel) {
    if (stage === "SCORING") {
      bumpReason(currentScanFunnel.scoringRejects, classifyScoringReject(reason));
    } else if (stage === "REENTRY_JUSTIFICATION") {
      currentScanFunnel.reentryBlocked++;
    } else if (PRE_ENRICH_REJECT_STAGES.has(stage)) {
      bumpReason(currentScanFunnel.preEnrichRejects, stage);
    } else {
      bumpReason(currentScanFunnel.executionBlocks, stage);
    }
  }
  if (stage === "REENTRY_JUSTIFICATION") {
    shadowSignals.markShadowOutcome(currentShadowBook, symbol, "REENTRY_BLOCKED", reason);
  } else if (stage !== "SCORING" && !PRE_ENRICH_REJECT_STAGES.has(stage)) {
    shadowSignals.markShadowOutcome(currentShadowBook, symbol, "BLOCKED", stage + ": " + reason);
  }
  journal.candidateRejected(symbol, stage, reason, snapshot);
}

// ═══════════════════════════════════════════════════════════════════════
// v8.1 — EQUITY DRIFT TRAIL + ALERT.
//
// Since v8 the reconciliation compares REALIZED equity with the REALIZED
// ledger, so a gap is money the bot cannot account for. The 2026-09 audit
// found ~$506 of such change after 07-22 with no trail. Every material,
// moving gap is now journaled (EQUITY_DRIFT); a gap large enough for the
// reconciliation to correct the ledger raises a Telegram alert that says
// what it means, instead of a neutral "capital reconciled" note.
// ═══════════════════════════════════════════════════════════════════════
async function recordEquityDrift(portfolio, ledgerEffective, reconciliation) {
  const unrealizedPnl = portfolio.totalUnrealizedProfitLoss || 0;
  const drift = capitalManager.describeEquityDrift({
    liveEquity: portfolio.totalEquity,
    unrealizedPnl,
    ledgerEffective,
    lastRecordedDriftDollars: lastRecordedEquityDriftDollars,
    recordThresholdDollars: config.equityDriftJournalDollars,
  });
  if (drift.shouldRecord || reconciliation.reconciled) {
    journal.equityDrift({
      liveEquity: Number(portfolio.totalEquity.toFixed(2)),
      unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
      realizedEquity: drift.realizedEquity,
      ledgerEffective: Number(ledgerEffective.toFixed(2)),
      driftDollars: drift.driftDollars,
      driftPct: Number((drift.driftPct * 100).toFixed(3)),
      openPositions: portfolio.positionCount || 0,
      pendingOrders: portfolio.pendingOrderCount || 0,
      reconciled: !!reconciliation.reconciled,
      treatedAsTransfer: !!reconciliation.treatedAsTransfer,
      blockedByPending: !!reconciliation.blockedByPending,
    });
    logger.info(
      "💵 Equity drift: realized equity $" +
        drift.realizedEquity.toFixed(2) +
        " vs ledger $" +
        ledgerEffective.toFixed(2) +
        " (gap " +
        (drift.driftDollars >= 0 ? "+" : "") +
        drift.driftDollars.toFixed(2) +
        ")" +
        (reconciliation.reconciled ? " — ledger corrected" : ""),
    );
    lastRecordedEquityDriftDollars = reconciliation.reconciled ? 0 : drift.driftDollars;
  }
  if (!reconciliation.reconciled) return;

  const driftPercentText = (reconciliation.driftPct * 100).toFixed(1) + "%";
  if (reconciliation.treatedAsTransfer) {
    await notifications.sendTelegramMessage(
      "🏦 <b>Owner transfer detected</b>\nAccount equity moved " +
        formatDualAmount(reconciliation.driftDollars, { signed: true }) +
        " (" +
        driftPercentText +
        ") with no trade to explain it, confirmed over several checks — treated " +
        "as a deposit/withdrawal. Base capital and the drawdown peak were " +
        "rescaled; nothing was booked as trading P&L.",
    );
    return;
  }
  await alerts.systemAlert(
    "UNEXPLAINED_EQUITY_CHANGE",
    "Realized account equity and the bot's ledger disagreed by " +
      formatDualAmount(reconciliation.driftDollars, { signed: true }) +
      " (" +
      driftPercentText +
      ") — money moved without a recorded trade. Likely causes: a position " +
      "closed outside the bot (a manual close in the app, a ghost or untracked " +
      "position) or fees. The ledger was corrected to the real account; check " +
      "eToro's closed-position history around now (journal: EQUITY_DRIFT).",
  );
}

function formatReasonBucket(bucket) {
  const entries = Object.entries(bucket).sort((a, b) => b[1] - a[1]);
  return entries.length
    ? " [" + entries.map(([key, count]) => key + " " + count).join(", ") + "]"
    : "";
}

function logScanFunnel(funnel) {
  if (!funnel) return;
  logger.info(
    "🧮 Funnel: " +
      funnel.quoted +
      " quoted → " +
      funnel.watchlistMovers +
      " moving" +
      (funnel.discovered ? " + " + funnel.discovered + " discovered" : "") +
      " → " +
      funnel.eligible +
      " eligible" +
      formatReasonBucket(funnel.preEnrichRejects) +
      " → " +
      funnel.scored +
      " scored" +
      formatReasonBucket(funnel.scoringRejects) +
      (funnel.reentryBlocked ? " (" + funnel.reentryBlocked + " re-entry blocked)" : "") +
      " → " +
      funnel.plans +
      " plans" +
      formatReasonBucket(funnel.planRejects) +
      " → AI " +
      funnel.aiTake +
      "/" +
      (funnel.aiTake + funnel.aiSkip) +
      " take → " +
      (funnel.armed ? funnel.armed + " waiting for a dip, " : "") +
      funnel.opened +
      " opened" +
      formatReasonBucket(funnel.executionBlocks) +
      (funnel.gate ? " · stopped at gate " + funnel.gate : ""),
  );
  journal.scanFunnel(funnel);
}

// -----------------------------
// MAIN SCAN CYCLE
// -----------------------------
async function runScanCycle() {
  if (scanInProgress) return;

  if (!marketHours.shouldRunAnalysisCycle()) {
    logger.info(
      "Market closed — skipping scan (" +
        marketHours.getCurrentBahrainTime() +
        " Bahrain)",
    );
    return;
  }

  // ── ADAPTIVE SCANNING (zero-cost skip decision) ──
  const trackedMetaForSkip = loadPositionMeta();
  const minutesSinceLastScan = (Date.now() - lastScanCompletedAtMs) / 60000;
  if (
    lastScanCompletedAtMs > 0 &&
    lastKnownRegime === "CHOP" &&
    Object.keys(trackedMetaForSkip).length === 0 &&
    Math.abs(lastKnownSpyChangePercent) < config.volatilitySpikeSpyPct &&
    minutesSinceLastScan < config.adaptiveChopScanMinutes
  ) {
    logger.info(
      "😴 Adaptive skip: CHOP + flat book + calm SPY — next full scan in ~" +
        Math.ceil(config.adaptiveChopScanMinutes - minutesSinceLastScan) +
        " min (saving API credits)",
    );
    journal.scanSkipped("ADAPTIVE_CHOP", {
      minutesSinceLastScan: Math.round(minutesSinceLastScan),
      lastKnownRegime,
      lastKnownSpyChangePercent,
    });
    return;
  }

  // ══════════════════════════════════════════════════════════════════════
  // v7.2 — OVERNIGHT SCAN FREEZE (operator quiet hours, cost control).
  //
  // Requested window: 23:30 -> 09:30 in the LOG timezone (Bahrain by
  // default). Freezes NEW-TRADE SCANNING ONLY — no quotes fetched, no
  // candidates scored, no AI screener call, saving both market-data and
  // Anthropic API cost. Placed here, alongside the "market closed" check
  // and BEFORE scanInProgress is set, so it behaves identically to every
  // other free pre-flight skip in this function: no lock taken, no API
  // calls made, and it does not disturb lastScanCompletedAtMs (which the
  // adaptive-CHOP skip below reads to mean "since the last REAL scan").
  //
  // Exit management is completely unaffected: the 1-minute exit-monitor
  // tick (runExitMonitorTick) calls manageOpenPositions() on its OWN
  // independent cron and never touches this check, so stops/targets/
  // time-exits keep running exactly as if this freeze did not exist.
  // ══════════════════════════════════════════════════════════════════════
  if (marketHours.isInOvernightFreezeWindow()) {
    const window = marketHours.getOvernightFreezeWindow();
    // v7.10: the window is ANCHORED to whichever clock it is configured in
    // (ET, so it tracks the US session through DST), but it is DISPLAYED in
    // the operator's timezone. When the two differ, the ET anchor is shown
    // in brackets so the log stays truthful about what is configured while
    // still being readable without mental arithmetic.
    const freezeIsEtAnchored = window.timeZone === "America/New_York";
    const windowText = freezeIsEtAnchored
      ? marketHours.easternClockToLogZone(window.startHour, window.startMinute) +
        "-" +
        marketHours.easternClockToLogZone(window.endHour, window.endMinute) +
        " " +
        marketHours.getLogTimeZoneLabel() +
        ", tracks " +
        String(window.startHour).padStart(2, "0") +
        ":" +
        String(window.startMinute).padStart(2, "0") +
        "-" +
        String(window.endHour).padStart(2, "0") +
        ":" +
        String(window.endMinute).padStart(2, "0") +
        " ET"
      : String(window.startHour).padStart(2, "0") +
        ":" +
        String(window.startMinute).padStart(2, "0") +
        "-" +
        String(window.endHour).padStart(2, "0") +
        ":" +
        String(window.endMinute).padStart(2, "0") +
        " " +
        marketHours.getFreezeTimeZoneLabel();

    logger.info(
      "🌙 Overnight freeze active (" +
        windowText +
        ") — skipping new-trade scan (" +
        marketHours.getCurrentLocalTime() +
        " " +
        marketHours.getLogTimeZoneLabel() +
        "). Exit management is unaffected — stops/exits keep " +
        "running on the 1-minute tick.",
    );
    journal.scanSkipped("OVERNIGHT_FREEZE", {
      local: marketHours.getCurrentLocalTime(),
    });
    return;
  }

  scanInProgress = true;
  const startTime = Date.now();
  const funnel = createScanFunnel();
  currentShadowBook = shadowSignals.createShadowBook();

  try {
    logger.info(
      "═══ Scan start (" +
        marketHours.getCurrentBahrainTime() +
        " Bahrain) ═══",
    );
    journal.scanStart({ bahrain: marketHours.getCurrentBahrainTime() });

    // 1. Always manage open positions first — exits are never gated.
    // v8: under the position lock only for this step, so the 1-minute exit
    // monitor keeps running through the rest of the scan (~133s on average)
    // instead of skipping it entirely.
    await withPositionLock("scan-manage", () => manageOpenPositions());

    // v5.3: cheap check for a silently-dead Alpaca stream (no-op if not
    // configured) — mirrors the alerting pattern for every other data source
    marketDataStream.checkStreamHealth();

    // v6: LIVE CAPITAL RECONCILIATION — before any gate/sizing reads
    // capitalState this cycle, make sure the ledger matches the REAL eToro
    // equity.
    // v8: always a FRESH fetch. The portfolio manageOpenPositions returns was
    // read BEFORE its exits ran, so any P&L those exits just booked showed up
    // as ledger drift against a stale equity figure.
    try {
      const equitySourcePortfolio = etoroClient.parsePortfolioFromRawData(
        await etoroClient.fetchRawPortfolio(),
      );
      const liveEquity = equitySourcePortfolio.totalEquity;
      const ledgerEffectiveBeforeReconcile =
        capitalManager.getCapitalState().effectiveCapital;
      // v7.3: the transfer detector needs to know whether orders are in
      // flight. Cash reserved against a queued order is the classic source
      // of a large, temporary, entirely fake equity drift — it produced a
      // $6,596.66 phantom withdrawal on 2026-07-31.
      // v8: and open positions' unrealized P&L is not realized capital.
      const reconciliation = capitalManager.reconcileWithLiveEquity(
        liveEquity,
        {
          pendingOrderCount: equitySourcePortfolio.pendingOrderCount || 0,
          unrealizedPnl: equitySourcePortfolio.totalUnrealizedProfitLoss || 0,
        },
      );
      // v8.1: journal material gaps; alert when the ledger had to be corrected.
      await recordEquityDrift(
        equitySourcePortfolio,
        ledgerEffectiveBeforeReconcile,
        reconciliation,
      );
    } catch (reconcileError) {
      logger.warn(
        "Capital reconciliation skipped (equity fetch failed): " +
          reconcileError.message,
      );
    }

    // 2. Risk gates for NEW entries
    // V4: halt flag / drawdown breaker first — the hardest gate
    if (await isTradingHaltedForNewEntries()) {
      return;
    }

    // V3: daily loss limit sized off EFFECTIVE capital, same base as sizing
    const capitalState = capitalManager.getCapitalState();
    if (riskManager.isDailyLossLimitHit(capitalState.effectiveCapital)) {
      logger.info("Daily loss limit hit — exits only");
      recordGateBlock("DAILY_LOSS_LIMIT", "realized losses at limit");
      return;
    }

    const sessionCheck = sessionTiming.isNewEntryAllowed();
    if (!sessionCheck.allowed) {
      logger.info("Entry blocked: " + sessionCheck.reason);
      recordGateBlock("SESSION_TIMING", sessionCheck.reason);
      return;
    }

    // v8: no entries after the Friday force-close (a weekend with no exit
    // monitor) or in the short window before any day's force-close.
    const entryCutoff = sessionTiming.getEntryCutoffStatus();
    if (entryCutoff.blocked) {
      logger.info("Entry blocked: " + entryCutoff.reason);
      recordGateBlock(entryCutoff.gate, entryCutoff.reason);
      return;
    }

    // 3. SPY filter (fail-closed, alerts on failure inside market-data)
    const spyQuote = await marketData.fetchSpyQuote();
    if (!spyQuote) {
      logger.warn("SPY unavailable — blocking entries");
      recordGateBlock("SPY_DATA", "SPY quote unavailable (fail-closed)");
      return;
    }
    const spyChange = spyQuote.changePercent;
    lastKnownSpyChangePercent = spyChange;

    // v5.1: VIX-aware regime (falls back to SPY-range-only automatically
    // if FRED_API_KEY isn't set — see market-regime.js)
    const regime = await marketRegime.classifyRegimeWithVix(spyQuote);
    lastKnownRegime = regime.regime;

    if (spyChange < config.spyMinChangePctForLongs) {
      logger.info("SPY weak (" + spyChange.toFixed(2) + "%) — no longs");
      recordGateBlock(
        "SPY_DIRECTION",
        "SPY " + spyChange.toFixed(2) + "% below floor",
      );
      return;
    }

    // v6 (2026-07-21): PRE-OPEN / OPEN-VOLATILITY BUY BLACKOUT. Blocks ONLY
    // new entries (exits/EOD closes above and below are entirely unaffected)
    // in the window around the regular-session open, but ONLY when SPY is
    // actually weak — a strong tape trades through the open just fine.
    // Matters most in 24/5 mode (config.trade24_5), which otherwise bypasses
    // every session-timing check entirely — this is checked independently
    // of that bypass, right here, using the SPY quote already fetched above
    // (zero extra API calls). Independent of, and layered on top of, the
    // general SPY_DIRECTION floor just above — its own threshold
    // (preOpenBlackoutSpyWeakPct) can be tuned separately for extra caution
    // specifically in the open's wide-spread/noisy window.
    if (
      config.preOpenBlackoutEnabled &&
      sessionTiming.isInPreOpenBlackoutWindow() &&
      spyChange <= config.preOpenBlackoutSpyWeakPct
    ) {
      logger.info(
        "Pre-open blackout: SPY " +
          spyChange.toFixed(2) +
          "% (weak) inside the open window — no new entries " +
          "(existing positions unaffected)",
      );
      recordGateBlock(
        "PRE_OPEN_BLACKOUT",
        "SPY " + spyChange.toFixed(2) + "% weak inside the open window",
      );
      return;
    }

    // ══════════════════════════════════════════════════════════════════
    // v7.4 — OVERNIGHT DEAD ZONE. Blocks NEW ENTRIES between 00:00 and
    // 04:00 ET, the one window the conviction-score filter could not
    // rescue: all 16 audited trades there lost money (-$170.05, 31% win),
    // and the high-score ones lost fastest (-$27.07/trade, 0% win).
    //
    // Placed here — after the exit monitor and capital reconciliation have
    // already run, before any quote/AI spend — so open positions stay
    // fully managed while no new risk is taken and no API budget is spent.
    // ══════════════════════════════════════════════════════════════════
    if (sessionTiming.isInOvernightDeadZone()) {
      // v7.10: shown in the operator's own clock first. The window is
      // ANCHORED to ET (it tracks the US session), but printing raw ET
      // forced DST-aware mental arithmetic twice a year. The Bahrain
      // figures below are computed live, so they shift themselves.
      logger.info(
        "🌑 Overnight dead zone (" +
          marketHours.easternClockToLogZone(config.overnightDeadZoneStartHourET) +
          "-" +
          marketHours.easternClockToLogZone(config.overnightDeadZoneEndHourET) +
          " " +
          marketHours.getLogTimeZoneLabel() +
          ", tracks " +
          String(config.overnightDeadZoneStartHourET).padStart(2, "0") +
          ":00-" +
          String(config.overnightDeadZoneEndHourET).padStart(2, "0") +
          ":00 ET) — no new entries. Every audited trade in this window " +
          "lost money regardless of score. Exits remain fully active.",
      );
      recordGateBlock(
        "OVERNIGHT_DEAD_ZONE",
        "inside the 00:00-04:00 ET window where all 16 audited trades lost",
      );
      return;
    }

    // 4. Watchlist quotes + autonomous discovery
    // 24/5: outside the US regular session, restrict to night-eligible names
    // (watchlist "night": true) — non-eligible tickers just reject on eToro
    // overnight. During regular hours the full watchlist is used.
    const overnightMode =
      config.trade24_5 && !marketHours.isRegularMarketHours();
    const watchlistEntries = loadWatchlistEntries();
    const watchlist = (
      overnightMode
        ? watchlistEntries.filter((entry) => entry.night)
        : watchlistEntries
    ).map((entry) => entry.symbol);
    if (!watchlist.length) {
      logger.warn(
        overnightMode
          ? "No night-eligible (24/5) watchlist names for this overnight scan"
          : "Empty watchlist",
      );
      recordGateBlock(
        "WATCHLIST",
        overnightMode
          ? "no night-eligible names for overnight session"
          : "watchlist file missing or empty",
      );
      return;
    }
    if (overnightMode) {
      logger.info(
        "🌙 Overnight (24/5): scanning " +
          watchlist.length +
          " night-eligible name(s); discovery paused until the regular session",
      );
    }

    const quotes = await marketData.fetchIntradayQuotes(watchlist);
    const watchlistCandidates = momentumScanner.prefilterCandidates(quotes);
    funnel.quoted = Object.keys(quotes || {}).length;
    funnel.watchlistMovers = watchlistCandidates.length;
    const sectorProxyChanges = await sectorRotation.getSectorProxyChanges();
    // Discovery: movers OUTSIDE watchlist + holdings (zero TD credits).
    // Paused overnight in 24/5 mode — discovered movers can't be checked for
    // overnight eligibility, so they'd only add reject noise.
    const trackedMeta = loadPositionMeta();
    const excludeFromDiscovery = new Set([
      ...watchlist.map((symbol) => symbol.toUpperCase()),
      ...Object.keys(trackedMeta),
    ]);
    const discoveredCandidates = overnightMode
      ? []
      : await marketDiscovery.discoverOpportunities(excludeFromDiscovery);
    funnel.discovered = discoveredCandidates.length;
    journal.discoveryResult(
      discoveredCandidates.map((candidate) => candidate.symbol),
    );

    const prefiltered = [...watchlistCandidates, ...discoveredCandidates];
    if (!prefiltered.length) {
      logger.info("📡 Nothing moving enough (watchlist or discovered)");
      return;
    }

    // 5. Filter held + cooldown, then enrich + ATR + score
    const rawPortfolio = await etoroClient.fetchRawPortfolio();
    const portfolio = etoroClient.parsePortfolioFromRawData(rawPortfolio);
    await etoroClient.labelPositionsWithTickers(portfolio);

    // Held = eToro's SETTLED positions ∪ the bot's own meta. The portfolio
    // list alone is not enough: overnight/pre-market orders can take minutes
    // to settle into positions[], and during that lag the same symbol was
    // re-bought on the next scan (confirmed: AVGO/MRVL/MU all double-entered
    // on 2026-07-14, band-aided after the fact by the duplicate closer).
    // Meta is written the moment an order is placed, so it can't lag.
    const heldSymbols = new Set([
      ...(portfolio.openPositions || []).map((position) =>
        (position.symbol || "").toUpperCase(),
      ),
      ...Object.keys(trackedMeta).map((symbol) => symbol.toUpperCase()),
    ]);

    const toEnrich = [];
    for (const candidate of prefiltered) {
      const upperSymbol = candidate.symbol.toUpperCase();
      // Excluded industries (gambling/betting, alcohol, adult) are never
      // bought — cheap static check here saves the enrichment API spend;
      // the async industry-based check runs again in tryOpenPosition.
      if (ethicsFilter.isBlockedStatic(upperSymbol)) {
        recordCandidateRejection(
          upperSymbol,
          "ETHICS_FILTER",
          "excluded industry (gambling/alcohol/adult)",
        );
        continue;
      }
      if (heldSymbols.has(upperSymbol)) {
        recordCandidateRejection(upperSymbol, "HELD", "already holding");
        continue;
      }
      const cooldown = cooldownTracker.checkCooldown(candidate.symbol);
      if (cooldown.onCooldown) {
        logger.info(
          candidate.symbol +
            " on cooldown (" +
            cooldown.minutesRemaining +
            "min) — skipping",
        );
        recordCandidateRejection(
          upperSymbol,
          "COOLDOWN",
          cooldown.minutesRemaining + " min remaining",
        );
        continue;
      }
      // v8: STALE QUOTE GATE. eToro's rate carries the time of its last
      // price update. After the 2026-09-04 close AMD was re-planned and
      // re-screened 24 times at a frozen $477.385 — a dead tape that looked
      // live. Only eToro-sourced quotes carry a timestamp; discovery rows
      // (Yahoo/FMP) are unaffected.
      if (config.maxQuoteAgeMinutes > 0 && candidate.quoteTimestamp) {
        const quoteAgeMinutes =
          (Date.now() - new Date(candidate.quoteTimestamp).getTime()) / 60000;
        if (
          Number.isFinite(quoteAgeMinutes) &&
          quoteAgeMinutes > config.maxQuoteAgeMinutes
        ) {
          recordCandidateRejection(
            upperSymbol,
            "STALE_QUOTE",
            "last eToro price update " +
              Math.round(quoteAgeMinutes) +
              " min ago (max " +
              config.maxQuoteAgeMinutes +
              ")",
          );
          continue;
        }
      }
      // ══════════════════════════════════════════════════════════════════
      // v7.11 — TRADABILITY GATE, MOVED TO THE FRONT OF THE PIPELINE.
      //
      // resolveTickerToInstrumentId() used to run inside tryOpenPosition,
      // i.e. AFTER enrichment, AFTER plan construction and AFTER the paid
      // AI screener call. Discovery routinely surfaces small US names that
      // eToro simply does not list, so on 2026-09-01 the bot spent a full
      // session enriching, planning and screening RDIB / FGL / NIPG /
      // FCUV / WFCF / LEXX — every one of them unbuyable. All 31 plans
      // that reached the screener that day were of this kind.
      //
      // Watchlist candidates arrive from eToro's own quote path with
      // instrumentId already set, so they cost nothing here; only
      // discovered names trigger a lookup, and the negative cache in
      // etoro-client keeps that to one call per symbol per TTL.
      //
      // A lookup FAILURE (network/HTTP) returns null the same as "not
      // listed", so this deliberately does not treat null as permanent —
      // the negative cache is what makes it cheap, and it expires.
      // ══════════════════════════════════════════════════════════════════
      if (!candidate.instrumentId && etoroMarketData.isConfigured()) {
        const resolvedId = await etoroClient.resolveTickerToInstrumentId(
          upperSymbol,
        );
        if (!resolvedId) {
          recordCandidateRejection(
            upperSymbol,
            "NOT_ON_ETORO",
            "no tradable eToro instrument — dropped before enrichment",
          );
          continue;
        }
        candidate.instrumentId = resolvedId;
      }

      toEnrich.push(candidate);
    }
    funnel.eligible = toEnrich.length;
    if (!toEnrich.length) {
      logger.info("All movers held or cooling down");
      return;
    }

    const scoredCandidates = [];
    // v8.4: SPY's 5-minute bars once per scan, for the logged trend score V2.
    const spyIntradayBars = config.scoreV2LoggingEnabled
      ? await marketData.fetchSpyIntradayBars()
      : null;
    for (const candidate of toEnrich) {
      const enrichment = await marketData.enrichCandidate(
        candidate.symbol,
        candidate.currentPrice,
        candidate.instrumentId, // v5.4: already resolved if this came from eToro's quote path
      );
      if (enrichment) {
        // v8.4: the raw bars ride along NON-enumerable, so they never end up
        // in a plan, the journal or Telegram — only the trend score reads them.
        const { intradayBars, ...enrichmentFields } = enrichment;
        Object.assign(candidate, enrichmentFields);
        Object.defineProperty(candidate, "intradayBars", {
          value: intradayBars || null,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      }

      // Daily ATR for volatility bucket + stop geometry (cached ~20h).
      // v5.4: the 8s sleep below only matters for Twelve Data's rate limit
      // — eToro's own rate limiter (90/60s self-imposed) is handled inside
      // etoro-market-data.js itself, so this sleep is skipped when eToro is
      // configured (it would otherwise slow down enrichment for no reason).
      if (!etoroMarketData.isConfigured()) {
        await marketData.sleep(8000);
      }
      candidate.atrPercent = await marketData.fetchDailyAtrPercent(
        candidate.symbol,
        candidate.instrumentId,
      );

      const scored = momentumScanner.scoreEnrichedCandidate(
        candidate,
        spyChange,
        regime,
        sectorProxyChanges,
      );
      shadowSignals.recordShadowCandidate(currentShadowBook, candidate, scored, {
        regime: regime.regime,
        spyChangePercent: spyChange,
        // v8.4: trend score V2, logged beside the live score (not traded on)
        scoreV2: config.scoreV2LoggingEnabled,
        spyBars: spyIntradayBars,
        spyPrice: spyQuote.currentPrice,
        nowMs: Date.now(),
      });
      if (!scored.rejected) {
        scored.atrPercent = candidate.atrPercent;
        // v7.7: carry the per-symbol size multiplier through to sizing.
        // Discovered (non-watchlist) names have no entry, so default to 1.
        scored.sizeMultiplier =
          (watchlistEntries.find(
            (entry) => entry.symbol === candidate.symbol,
          ) || {}).sizeMultiplier || 1;
        scored.source = candidate.source || "WATCHLIST";
        scored.priceChangePercent = candidate.priceChangePercent;

        // v6: RE-ENTRY JUSTIFICATION. Now that the candidate is scored, check
        // whether it's re-entering a symbol that recently closed for a LOSS
        // (its raw time-cooldown may have already expired — checkCooldown()
        // above only gates the TIME window; this gates the SETUP QUALITY).
        // "The setup re-fired" alone doesn't justify re-buying a stock that
        // just cost money — it must score meaningfully higher than the
        // setup that lost.
        const justification = cooldownTracker.getReentryJustification(
          candidate.symbol,
        );
        if (justification.requiresJustification && scored.score < justification.minScore) {
          recordCandidateRejection(
            candidate.symbol,
            "REENTRY_JUSTIFICATION",
            "score " +
              scored.score.toFixed(0) +
              " below required " +
              justification.minScore.toFixed(0) +
              " (prior losing setup scored " +
              justification.priorScore.toFixed(0) +
              ") — not enough improvement to justify re-buying a recent loser",
          );
          // v7.9: state the bar ACTUALLY applied, not the raw improvement
          // figure. When the bar is clamped (prior score > 75, which is 72%
          // of all blocks) the old wording said "the required 15 points",
          // implying a bar of prior+15 — directly contradicting the clamp
          // line logged immediately above it. The journal already recorded
          // the real number; only the console line was wrong.
          logger.info(
            candidate.symbol +
              " re-entry blocked: score " +
              scored.score.toFixed(0) +
              " is below the required " +
              justification.minScore.toFixed(0) +
              (justification.wasClamped ? " (clamped)" : "") +
              " — prior losing setup scored " +
              justification.priorScore.toFixed(0),
          );
          await marketData.sleep(1500);
          continue;
        }

        scoredCandidates.push(scored);
        journal.candidateScored(scored);
      } else {
        recordCandidateRejection(
          candidate.symbol,
          "SCORING",
          scored.rejectReason,
          {
            aboveVwap: candidate.vwap
              ? candidate.currentPrice >= candidate.vwap
              : null,
            rsi: candidate.rsi,
            volumeRatio: candidate.volumeRatio,
          },
        );
      }
      await marketData.sleep(1500);
    }
    funnel.scored = scoredCandidates.length;
    if (!scoredCandidates.length) {
      logger.info("No candidates passed scoring");
      return;
    }

    scoredCandidates.sort((a, b) => b.score - a.score);
    const topCandidates = scoredCandidates.slice(0, config.maxCandidates);
    funnel.shortlisted = topCandidates.length;
    for (const leftOut of scoredCandidates.slice(config.maxCandidates)) {
      shadowSignals.markShadowOutcome(
        currentShadowBook,
        leftOut.symbol,
        "NOT_SHORTLISTED",
        "ranked below the top " + config.maxCandidates,
      );
    }

    // 6. Build trade PLANS
    logger.info(
      "💰 Capital: effective $" +
        capitalState.effectiveCapital +
        " (base $" +
        capitalState.baseCapital +
        (capitalState.cumulativeRealizedPnl >= 0 ? " +" : " ") +
        "$" +
        capitalState.cumulativeRealizedPnl +
        " realized, peak $" +
        capitalState.peakEffectiveCapital +
        ") · risk ×" +
        capitalState.riskMultiplier,
    );

    const easternWeekday = getEasternWeekday();
    const openCounts = countOpenByType(trackedMeta);
    const plans = [];
    for (const candidate of topCandidates) {
      const isFirstTimeDiscovered =
        candidate.source === "DISCOVERED" &&
        !marketDiscovery.hasTradedBefore(candidate.symbol);

      const planResult = tradePlanner.buildTradePlan(
        candidate,
        {
          regime: regime.regime,
          spyChangePercent: spyChange,
          easternWeekday,
        },
        capitalState,
        openCounts,
        isFirstTimeDiscovered,
      );

      if (planResult.accepted) {
        plans.push(planResult.plan);
        journal.planBuilt(planResult.plan);
        shadowSignals.markShadowOutcome(
          currentShadowBook,
          candidate.symbol,
          "PLANNED",
          "stop -" + planResult.plan.stopDistancePct + "% · $" + planResult.plan.positionDollars,
        );
      } else {
        // v7.11: record the numbers, not just the sentence. Price + ts are
        // what let a later analysis compute the forward return this
        // rejection gave up, so a quiet month still produces evidence.
        bumpReason(funnel.planRejects, classifyPlanReject(planResult.rejectReason));
        shadowSignals.markShadowOutcome(
          currentShadowBook,
          candidate.symbol,
          "PLAN_REJECTED",
          planResult.rejectReason,
        );
        journal.planRejected(candidate.symbol, planResult.rejectReason, {
          score: candidate.score != null ? candidate.score : null,
          price: candidate.currentPrice != null ? candidate.currentPrice : null,
          atrPercent: candidate.atrPercent != null ? candidate.atrPercent : null,
          priceChangePercent:
            candidate.priceChangePercent != null
              ? candidate.priceChangePercent
              : null,
          rsi: candidate.rsi != null ? candidate.rsi : null,
          relativeStrength:
            candidate.relativeStrength != null
              ? candidate.relativeStrength
              : null,
          aboveVwap: candidate.aboveVwap === true,
          setup: candidate.setup || null,
          source: candidate.source || "WATCHLIST",
          sectorBucket: sectorMap.getStaticBucket(candidate.symbol) || null,
          regime: regime.regime,
          spyChangePercent: spyChange,
        });
        // v9.2: log-only paper copy of a floor reject (see config.paperScoreRejected)
        if (/entry floor/.test(planResult.rejectReason || "")) {
          try {
            paperScoreFloorReject(
              candidate,
              { regime: regime.regime, spyChangePercent: spyChange, easternWeekday },
              capitalState,
              openCounts,
              isFirstTimeDiscovered,
            );
          } catch (paperError) {
            logger.warn("Paper copy failed for " + candidate.symbol + ": " + paperError.message);
          }
        }
        logger.info(
          candidate.symbol + " plan rejected: " + planResult.rejectReason,
        );
      }
    }
    // v8.2: a stock already waiting for its dip keeps its original order —
    // no second plan, no second AI call.
    if (config.dipEntryEnabled && pendingDipEntries.size) {
      for (let k = plans.length - 1; k >= 0; k--) {
        const symbolKey = plans[k].symbol.toUpperCase();
        if (!pendingDipEntries.has(symbolKey)) continue;
        bumpReason(funnel.planRejects, "waiting for dip");
        shadowSignals.markShadowOutcome(currentShadowBook, symbolKey, "DIP_PENDING", "order from an earlier scan");
        plans.splice(k, 1);
      }
    }
    funnel.plans = plans.length;
    if (!plans.length) {
      logger.info("No plans survived geometry/slots/RRR checks");
      return;
    }

    // 7. AI veto screen → open approved plans
    //
    // v7: the market brief is built ONCE here and shared by every plan in
    // this scan (the screener runs one call per plan, so building it per
    // plan would repeat the same work N times). It also becomes the last
    // known brief for the daily position reviewer, which runs on its own
    // schedule and has no scan of its own to draw on.
    const brief = config.marketBriefEnabled
      ? await marketContextBuilder
          .buildMarketBrief({
            spyChangePercent: spyChange,
            regime: regime.regime,
            rangePct: regime.rangePct,
            vix: regime.vix,
            sectorProxyChanges,
            quotesBySymbol: quotes,
            session: marketHours.isRegularMarketHours()
              ? "REGULAR"
              : "OVERNIGHT/EXTENDED",
          })
          .catch((briefError) => {
            logger.warn(
              "Market brief failed (non-fatal, prompts fall back to SPY+regime): " +
                briefError.message,
            );
            return null;
          })
      : null;
    if (brief) {
      lastKnownBrief = brief;
      lastKnownBriefText = marketContextBuilder.formatBriefForPrompt(brief);
      logger.info("🧭 Market brief: " + brief.riskTone + " tone");
    }

    const marketContext = {
      regime: regime.regime,
      rangePct: regime.rangePct,
      spyChangePercent: spyChange,
      brief,
      briefText: brief
        ? marketContextBuilder.formatBriefForPrompt(brief)
        : null,
      // Session + today's results give the screener context it was blind
      // to: it approved 100% of watchlist plans overnight on 2026-07-14,
      // including RSI-76 entries in a SIDEWAYS/UNKNOWN tape, and 4 of them
      // closed red the same day.
      session: marketHours.isRegularMarketHours()
        ? "REGULAR"
        : "OVERNIGHT/EXTENDED",
      todayPnl: riskManager.getDailyLossSnapshot(),
    };
    const screenResults = await aiScreener.screenCandidates(
      plans,
      portfolio.openPositions,
      marketContext,
    );
    for (const screenResult of screenResults) {
      journal.aiDecision(
        screenResult.symbol,
        screenResult.decision,
        screenResult.confidence,
        screenResult.reasoning,
        screenResult.analysis,
      );
    }

    const approvedPlans = plans.filter((plan) =>
      screenResults.some(
        (result) => result.symbol === plan.symbol && result.decision === "TAKE",
      ),
    );
    funnel.aiTake = approvedPlans.length;
    funnel.aiSkip = plans.length - approvedPlans.length;
    for (const screenResult of screenResults) {
      shadowSignals.markShadowOutcome(
        currentShadowBook,
        screenResult.symbol,
        screenResult.decision === "TAKE" ? "AI_TAKE" : "AI_SKIP",
        "confidence " +
          screenResult.confidence +
          (screenResult.analysis && screenResult.analysis.disqualifier
            ? " · " + screenResult.analysis.disqualifier
            : ""),
      );
    }

    // ══════════════════════════════════════════════════════════════════
    // v7.2 — ROOT CAUSE OF THE FILL MISMATCHES.
    //
    // portfolio.availableCash is a snapshot taken ONCE at the top of this
    // scan. It used to be passed unchanged into every tryOpenPosition call,
    // so when several plans were approved together each one checked its
    // affordability against cash that the earlier opens had already spent.
    //
    // Measured live 2026-07-27: five positions opened in a single 54-second
    // scan, each individually "affordable" against the same stale figure,
    // collectively $11,612 against $9,323. eToro then partial-filled what it
    // could — AVGO took 49% of the requested amount, META 52% — and because
    // nothing re-checked afterwards the bot tracked the full requested size
    // for hours (META: $2,150 tracked vs $1,113.74 real).
    //
    // This ledger decrements the available cash as each open commits it, so
    // the Nth plan in a scan sees what is actually left. Costs no extra API
    // calls; the post-open verification and the per-tick sync remain as the
    // backstops that catch whatever eToro does differently anyway.
    const scanCashLedger = { committed: 0 };
    const armedThisScan = []; // v8.2: one grouped Telegram message after the loop
    for (const plan of approvedPlans) {
      const aiResult = screenResults.find(
        (result) => result.symbol === plan.symbol,
      );
      // v8.2: do not buy the spike — wait for a dip (checked every minute).
      if (config.dipEntryEnabled) {
        armedThisScan.push(armDipEntry(plan, aiResult));
        funnel.armed++;
        shadowSignals.markShadowOutcome(currentShadowBook, plan.symbol, "DIP_ARMED", "waiting to buy on a dip");
        continue;
      }
      // v8: each open runs under the position lock — it reads and writes
      // position meta, and the exit monitor may now run during the scan.
      const openOutcome = await withPositionLock(
        "scan-open:" + plan.symbol,
        () =>
          tryOpenPosition(plan, aiResult, portfolio, capitalState, scanCashLedger),
      );
      // Blocks are counted by recordCandidateRejection; only a real open
      // returns true.
      if (openOutcome === true) {
        funnel.opened++;
        shadowSignals.markShadowOutcome(currentShadowBook, plan.symbol, "OPENED", null);
      } else {
        const shadowEntry =
          currentShadowBook && currentShadowBook.get(plan.symbol.toUpperCase());
        if (shadowEntry && shadowEntry.outcome === "AI_TAKE") {
          shadowEntry.outcome = "OPEN_FAILED";
        }
      }
    }

    await notifyDipOrdersArmed(armedThisScan);

    logger.info(
      "═══ Scan done in " +
        ((Date.now() - startTime) / 1000).toFixed(1) +
        "s ═══",
    );
  } catch (scanError) {
    logger.error("Scan error: " + scanError.message);
    journal.error("SCAN", scanError.message);
    // V7: a crashing scan cycle means the ENTRY pipeline is not running —
    // exactly the class of failure that was previously invisible.
    await alerts.systemAlert(
      "SCAN_CYCLE",
      "The scan cycle CRASHED before completing: " +
        scanError.message +
        ". No new candidates were evaluated this scan. Exits are unaffected " +
        "(the 1-minute exit monitor runs separately). If this repeats, check " +
        "pm2 logs etoro-daytrade.",
    );
  } finally {
    scanInProgress = false;
    lastScanCompletedAtMs = Date.now();
    logScanFunnel(funnel);
    currentScanFunnel = null;
    if (currentShadowBook) {
      for (const signal of currentShadowBook.values()) journal.shadowSignal(signal);
    }
    currentShadowBook = null;
  }
}

// -----------------------------
// v8.2: DIP ENTRY — buy approved stocks on a pullback, not the spike
// -----------------------------
// Replay of 2,055 approved/skipped candidates (Jul 1 - Sep 11): buying the
// moment a scan approved a stock averaged -0.05R per trade in both halves;
// waiting up to 2 hours for a dip of one full stop distance and buying there
// averaged +0.05R and +0.13R, buying ~15% of approvals. An order that never
// fills is no trade. Every order journals DIP_ENTRY with the deepest dip it
// saw, so the depth can be re-tuned from live results.
const formatPrice = (value) => "$" + Number(value).toFixed(2);

function armDipEntry(plan, aiResult) {
  const nowMs = Date.now();
  const order = tradePlanner.buildDipEntryOrder(plan, {
    depthOfStop: config.dipEntryDepthOfStop,
    windowMinutes: config.dipEntryWindowMinutes,
    trailFromHigh: config.dipEntryTrailFromHigh, // v8.6
    nowMs,
  });
  order.aiResult = aiResult || null;
  pendingDipEntries.set(order.symbol, order);
  journal.dipEntry({ status: "ARMED", ...tradePlanner.describeDipEntryOrder(order, nowMs) });
  logger.info(
    "⏳ " +
      order.symbol +
      " approved at " +
      formatPrice(order.signalPrice) +
      " — not buying the spike: will buy only on a dip to " +
      formatPrice(order.triggerPrice) +
      " (-" +
      ((1 - order.triggerPrice / order.signalPrice) * 100).toFixed(2) +
      "%) within " +
      order.windowMinutes +
      " min" +
      (order.trailFromHigh
        ? " — buy level follows the high, never above " + formatPrice(order.signalPrice)
        : ""),
  );
  bumpDipEntryStat("armed");
  // v9.1: log-only — the same stock bought at once, for comparison.
  try {
    openPaperPosition(plan, nowMs);
  } catch (paperError) {
    logger.warn("Paper position failed for " + order.symbol + ": " + paperError.message);
  }
  return order;
}

// One Telegram message per scan for everything it approved (not one per stock).
async function notifyDipOrdersArmed(orders) {
  if (!orders.length) return;
  const lines = orders.map(
    (order) =>
      "• <b>" +
      order.symbol +
      "</b>: approved " +
      formatPrice(order.signalPrice) +
      " → buy at " +
      formatPrice(order.triggerPrice) +
      " (-" +
      ((1 - order.triggerPrice / order.signalPrice) * 100).toFixed(2) +
      "%)",
  );
  try {
    await notifications.sendTelegramMessage(
      "⏳ <b>Waiting to buy on a dip</b>\n" +
        "AI-approved, but the bot does not buy the spike. Each is bought only if it " +
        "dips to the price shown within " +
        orders[0].windowMinutes +
        " min (by " +
        marketHours.localClock(new Date(orders[0].expiresAtMs)) +
        ") — otherwise no trade.\n" +
        (orders[0].trailFromHigh
          ? "If it runs up first, the buy price rises with it but never goes above the " +
            "approval price — so a pullback later still counts (v8.6).\n"
          : "") +
        "\n" +
        lines.join("\n"),
    );
  } catch (telegramError) {
    logger.warn("Dip-order Telegram failed: " + telegramError.message);
  }
}

// One Telegram message per check for every order that ended without a buy.
async function notifyDipOrdersNotBought(entries) {
  if (!entries.length) return;
  const lines = entries.map(({ order, status, reason, record }) => {
    if (status === "EXPIRED") {
      return (
        "⌛ <b>" +
        order.symbol +
        "</b>: no dip to " +
        formatPrice(order.triggerPrice) +
        " in " +
        order.windowMinutes +
        " min · lowest " +
        formatPrice(order.lowestPrice) +
        " · now " +
        formatPrice(order.lastPrice) +
        " (" +
        (record.moveFromSignalPct >= 0 ? "+" : "") +
        record.moveFromSignalPct +
        "% vs approval) · ran to " +
        formatPrice(order.highestPrice) +
        " (" +
        (record.runUpFromSignalPct >= 0 ? "+" : "") +
        record.runUpFromSignalPct +
        "% at best)"
      );
    }
    if (status === "BLOCKED_AT_FILL") {
      return (
        "🚫 <b>" +
        order.symbol +
        "</b>: dipped to " +
        formatPrice(order.lastPrice) +
        " but the buy was blocked — " +
        escapeHtml(reason)
      );
    }
    return "✋ <b>" + order.symbol + "</b>: cancelled — " + escapeHtml(reason);
  });
  try {
    await notifications.sendTelegramMessage("<b>Dip orders — not bought</b>\n" + lines.join("\n"));
  } catch (telegramError) {
    logger.warn("Dip-order Telegram failed: " + telegramError.message);
  }
}

function finishDipEntry(order, status, reason) {
  pendingDipEntries.delete(order.symbol);
  bumpDipEntryStat("notBought");
  const record = tradePlanner.describeDipEntryOrder(order, Date.now());
  journal.dipEntry({ status, reason, ...record });
  logger.info(
    (status === "EXPIRED" ? "⌛ " : "✋ ") +
      order.symbol +
      " not bought — " +
      reason +
      " (approved " +
      formatPrice(order.signalPrice) +
      ", lowest " +
      formatPrice(order.lowestPrice) +
      ", now " +
      formatPrice(order.lastPrice) +
      " = " +
      (record.moveFromSignalPct >= 0 ? "+" : "") +
      record.moveFromSignalPct +
      "% vs approval)",
  );
  return record;
}

// The same new-entry gates a scan applies, re-checked while orders wait.
async function dipEntryBlockReason() {
  if (marketHours.isInOvernightFreezeWindow()) return "overnight freeze started";
  if (await isTradingHaltedForNewEntries()) return "new entries halted (halt flag / drawdown breaker)";
  if (riskManager.isDailyLossLimitHit(capitalManager.getCapitalState().effectiveCapital)) {
    return "daily loss limit hit";
  }
  const sessionCheck = sessionTiming.isNewEntryAllowed();
  if (!sessionCheck.allowed) return sessionCheck.reason;
  const entryCutoff = sessionTiming.getEntryCutoffStatus();
  if (entryCutoff.blocked) return entryCutoff.reason;
  return null;
}

async function openDipEntry(plan, aiResult) {
  const portfolio = etoroClient.parsePortfolioFromRawData(await etoroClient.fetchRawPortfolio());
  await etoroClient.labelPositionsWithTickers(portfolio);
  const outcome = await withPositionLock("dip-open:" + plan.symbol, () =>
    tryOpenPosition(plan, aiResult, portfolio, capitalManager.getCapitalState(), { committed: 0 }),
  );
  return outcome === true;
}

// ══════════════════════════════════════════════════════════════════════
// v9.1 — THE PAPER BOOK (data/shadow-log/paper-*.jsonl). LOGGING ONLY.
//
// Every time a dip order is armed, a PAPER position is opened at the price
// the AI approved — the trade the bot did NOT take — and marked every minute
// against the SAME risk engine until that engine says it would have exited.
// Nothing in here can place, size, hold or close a real order; it only
// writes files. It answers "the dip never came and it would have made money"
// from the log, instead of from a replay weeks later.
//
// The paper position deliberately carries NO plan.dipEntry, because it is
// the bought-immediately counterfactual — so the v8.3 breakeven wait, which
// is dip-buys-only, correctly does not apply to it.
// ══════════════════════════════════════════════════════════════════════
const paperPositions = new Map(); // symbol -> position meta (paper)

// v9.2: keyed REASON:SYMBOL, so the same stock can be paper-held once as a
// skipped dip (DIP_WAIT) and once as a score-floor reject (SCORE_FLOOR).
const lastPaperOpenMs = new Map(); // key -> ms, for the one-per-hour cap
function openPaperPosition(plan, nowMs, paperReason = "DIP_WAIT") {
  const symbol = String(plan.symbol).toUpperCase();
  const key = paperReason + ":" + symbol;
  if (paperPositions.has(key)) return; // one open paper position per reason+symbol
  if (nowMs - (lastPaperOpenMs.get(key) || 0) < config.paperRepeatMinutes * 60000) return;
  lastPaperOpenMs.set(key, nowMs);
  const meta = {
    tradeType: "DAY",
    entryPrice: plan.entryPrice,
    stopPrice: plan.stopPrice,
    targetT1: plan.targetT1,
    targetT2: plan.targetT2,
    lockedFloor: null,
    peakPrice: plan.entryPrice,
    peakSetAt: nowMs,
    recentPrices: [],
    partialDone: false,
    openedAt: nowMs,
    dollarAmount: plan.positionDollars,
    troughPrice: plan.entryPrice,
    plan: {
      symbol,
      stopDistancePct: plan.stopDistancePct,
      atrPercent: plan.atrPercent,
      score: plan.score,
      source: plan.source,
    },
    entryConditions: { atrPercent: plan.atrPercent },
    paperReason,
  };
  paperPositions.set(key, meta);
  journal.writePaperState(Object.fromEntries(paperPositions));
  journal.paperOpen({
    symbol,
    entryPrice: meta.entryPrice,
    stopPrice: meta.stopPrice,
    targetT1: meta.targetT1,
    stopDistancePct: plan.stopDistancePct,
    atrPercent: plan.atrPercent,
    sizeDollars: meta.dollarAmount,
    score: plan.score,
    source: plan.source,
    paperReason,
    note:
      paperReason === "SCORE_FLOOR"
        ? "bought when the score floor turned it down (score " + plan.score + ")"
        : "bought at the approval price — the trade the live bot skipped while waiting for a dip",
  });
}

function paperScoreFloorReject(candidate, context, capitalState, openCounts, isFirstTimeDiscovered) {
  if (!config.paperScoreRejected) return;
  const result = tradePlanner.buildTradePlan(
    candidate,
    context,
    capitalState,
    openCounts,
    isFirstTimeDiscovered,
    { ignoreScoreFloor: true, quiet: true },
  );
  // Rejected for another reason too (ATR, earnings, ...) = the bot would not
  // have bought it even without the floor, so there is nothing to paper-trade.
  if (result && result.accepted) openPaperPosition(result.plan, Date.now(), "SCORE_FLOOR");
}

// One batched rates call per minute for the paper book; nothing when empty.
// eodMode (v9.2): called by the force-close job so paper positions follow the
// same end-of-day rule as real ones — Friday/ALL closes everything, Mon-Thu
// keeps winners and closes the rest.
async function markPaperPositions(eodMode = null) {
  if (!paperPositions.size) return;
  const idBySymbol = {};
  for (const symbol of new Set([...paperPositions.values()].map((m) => m.plan.symbol))) {
    const id = await etoroClient.resolveTickerToInstrumentId(symbol);
    if (id) idBySymbol[symbol] = id;
  }
  const rates = await etoroMarketData.fetchBatchedRates(Object.values(idBySymbol));
  const nowMs = Date.now();

  for (const [key, meta] of [...paperPositions.entries()]) {
    const symbol = meta.plan.symbol;
    const paperReason = meta.paperReason || "DIP_WAIT";
    const rate = rates[idBySymbol[symbol]];
    const price = rate && rate.ask > 0 ? rate.ask : null;
    if (!price) continue;

    meta.recentPrices = [...(meta.recentPrices || []), price].slice(-20);
    if (price > (meta.peakPrice || meta.entryPrice)) {
      meta.peakPrice = price;
      meta.peakSetAt = nowMs;
    }
    if (price < (meta.troughPrice || meta.entryPrice)) meta.troughPrice = price;

    let decision;
    let status;
    try {
      decision = riskManager.decidePositionAction(meta, price);
      if (eodMode) {
        const eodPnlPct = (price / meta.entryPrice - 1) * 100;
        const keep = eodMode === "DAY_KEEP_WINNERS" && eodPnlPct > config.overnightHoldMinProfitPct;
        decision = keep
          ? { action: "HOLD", reason: "EOD: winner held overnight" }
          : { action: "EXIT", reason: eodMode === "ALL" ? "FRIDAY_FORCE_CLOSE" : "EOD_FORCE_CLOSE" };
      }
      status = riskManager.describePositionState(meta, price);
    } catch (engineError) {
      logger.warn("Paper engine failed for " + symbol + ": " + engineError.message);
      continue;
    }
    if (decision.newPeak && decision.newPeak !== meta.peakPrice) meta.peakPrice = decision.newPeak;
    if (decision.lockedFloor != null) meta.lockedFloor = decision.lockedFloor;

    const pnlPct = (price / meta.entryPrice - 1) * 100;
    const pnlDollars = (pnlPct / 100) * meta.dollarAmount;

    // Mirror the live partial handler (index.js, decision.action === "PARTIAL"):
    // bank the fraction, flip the flag, lift the floor and shrink the tracked
    // size, so the remainder behaves as a real runner would.
    if (decision.action === "PARTIAL" && decision.fraction) {
      const banked = Number(((pnlPct / 100) * meta.dollarAmount * decision.fraction).toFixed(2));
      if (!meta.originalDollarAmount) meta.originalDollarAmount = meta.dollarAmount;
      meta.realizedPartialPnl = Number(((meta.realizedPartialPnl || 0) + banked).toFixed(2));
      if (decision.flagOnSuccess) meta[decision.flagOnSuccess] = true;
      if (decision.floorOnSuccess != null) meta.lockedFloor = decision.floorOnSuccess;
      meta.dollarAmount = Number((meta.dollarAmount * (1 - decision.fraction)).toFixed(2));
      journal.paperMark({
        symbol,
        price,
        pnlPct: Number(pnlPct.toFixed(2)),
        action: "PARTIAL",
        fraction: decision.fraction,
        paperReason,
        bankedDollars: banked,
        realizedPartialPnl: meta.realizedPartialPnl,
        remainingDollars: meta.dollarAmount,
        reason: decision.reason,
        heldMinutes: Math.round((nowMs - meta.openedAt) / 60000),
      });
      journal.writePaperState(Object.fromEntries(paperPositions));
      continue;
    }

    if (decision.action === "EXIT") {
      journal.paperClose({
        symbol,
        paperReason,
        entryPrice: meta.entryPrice,
        exitPrice: price,
        exitReason: decision.reason || decision.exitReason || "EXIT",
        pnlPct: Number(pnlPct.toFixed(2)),
        pnlDollars: Number(pnlDollars.toFixed(2)),
        realizedPartialPnl: meta.realizedPartialPnl || 0,
        // the whole paper trade: the final leg plus anything banked at T1
        totalPnlDollars: Number((pnlDollars + (meta.realizedPartialPnl || 0)).toFixed(2)),
        peakPrice: meta.peakPrice,
        troughPrice: meta.troughPrice,
        mfePct: Number(((meta.peakPrice / meta.entryPrice - 1) * 100).toFixed(2)),
        maePct: Number(((meta.troughPrice / meta.entryPrice - 1) * 100).toFixed(2)),
        heldMinutes: Math.round((nowMs - meta.openedAt) / 60000),
      });
      paperPositions.delete(key);
    } else {
      journal.paperMark({
        symbol,
        paperReason,
        price,
        pnlPct: Number(pnlPct.toFixed(2)),
        pnlDollars: Number(pnlDollars.toFixed(2)),
        peakPct: Number(((meta.peakPrice / meta.entryPrice - 1) * 100).toFixed(2)),
        state: status.state,
        stopPrice: status.stopPrice,
        stopKind: status.stopKind,
        action: decision.action,
        reason: decision.reason || status.reason,
        exitConditions: status.exitConditions,
        heldMinutes: Math.round((nowMs - meta.openedAt) / 60000),
      });
    }
  }
  journal.writePaperState(Object.fromEntries(paperPositions));
}

// Runs on the 1-minute exit-monitor tick. One batched rates call for all
// waiting symbols; nothing at all when no order is waiting.
async function checkPendingDipEntries() {
  if (!pendingDipEntries.size) return;
  const blockReason = await dipEntryBlockReason();
  if (blockReason) {
    const cancelled = [...pendingDipEntries.values()].map((order) => ({
      order,
      status: "CANCELLED",
      reason: blockReason,
      record: finishDipEntry(order, "CANCELLED", blockReason),
    }));
    await notifyDipOrdersNotBought(cancelled);
    return;
  }

  const instrumentIdBySymbol = {};
  for (const symbol of pendingDipEntries.keys()) {
    const instrumentId = await etoroClient.resolveTickerToInstrumentId(symbol);
    if (instrumentId) instrumentIdBySymbol[symbol] = instrumentId;
  }
  const ratesByInstrumentId = await etoroMarketData.fetchBatchedRates(Object.values(instrumentIdBySymbol));
  const nowMs = Date.now();
  dipEntryCheckCount++;
  const notBought = [];

  for (const order of [...pendingDipEntries.values()]) {
    const rate = ratesByInstrumentId[instrumentIdBySymbol[order.symbol]];
    const quoteAgeMs = rate && rate.date ? nowMs - Date.parse(rate.date) : 0;
    const usableAsk =
      rate && rate.ask > 0 && !(quoteAgeMs > config.maxQuoteAgeMinutes * 60000) ? rate.ask : null;
    const decision = tradePlanner.evaluateDipEntry(order, usableAsk, nowMs);

    if (decision.action === "WAIT") {
      if (dipEntryCheckCount % 5 === 0) {
        logger.info(
          "⏳ Waiting to buy " +
            order.symbol +
            ": now " +
            formatPrice(order.lastPrice) +
            ", buy at " +
            formatPrice(order.triggerPrice) +
            ", lowest so far " +
            formatPrice(order.lowestPrice) +
            ", " +
            Math.max(0, Math.round((order.expiresAtMs - nowMs) / 60000)) +
            " min left",
        );
      }
      continue;
    }
    if (decision.action === "EXPIRE") {
      const reason = "no dip to " + formatPrice(order.triggerPrice) + " within " + order.windowMinutes + " min";
      notBought.push({ order, status: "EXPIRED", reason, record: finishDipEntry(order, "EXPIRED", reason) });
      continue;
    }
    if (decision.action === "CANCEL") {
      notBought.push({
        order,
        status: "CANCELLED",
        reason: decision.reason,
        record: finishDipEntry(order, "CANCELLED", decision.reason),
      });
      continue;
    }

    pendingDipEntries.delete(order.symbol);
    logger.info(
      "🎯 " +
        order.symbol +
        " dipped to " +
        formatPrice(decision.price) +
        " (approved at " +
        formatPrice(order.signalPrice) +
        ") — buying the dip",
    );
    const plan = {
      ...tradePlanner.rebasePlanToFill(order.plan, decision.price),
      dipEntry: {
        signalPrice: order.signalPrice,
        triggerPrice: order.triggerPrice,
        armedAt: new Date(order.armedAtMs).toISOString(),
        minutesWaited: Math.round((nowMs - order.armedAtMs) / 60000),
      },
    };
    let opened = false;
    let blockReason = null;
    const openStartedMs = Date.now();
    try {
      opened = await openDipEntry(plan, order.aiResult);
    } catch (openError) {
      logger.error("Dip entry for " + order.symbol + " failed: " + openError.message);
      blockReason = "error: " + openError.message;
    }
    if (!opened && !blockReason) {
      blockReason =
        lastCandidateRejection &&
        lastCandidateRejection.symbol === order.symbol &&
        lastCandidateRejection.atMs >= openStartedMs
          ? lastCandidateRejection.stage + ": " + lastCandidateRejection.reason
          : "order not placed (see logs)";
    }
    const record = tradePlanner.describeDipEntryOrder(order, nowMs);
    journal.dipEntry({
      status: opened ? "FILLED" : "BLOCKED_AT_FILL",
      fillPrice: decision.price,
      reason: blockReason,
      ...record,
    });
    if (opened) {
      bumpDipEntryStat("bought");
    } else {
      bumpDipEntryStat("notBought");
      notBought.push({ order, status: "BLOCKED_AT_FILL", reason: blockReason, record });
    }
  }
  await notifyDipOrdersNotBought(notBought);
}

// -----------------------------
// POSITION ENTRY (plan-driven)
// -----------------------------
async function tryOpenPosition(
  plan,
  aiResult,
  portfolio,
  capitalState,
  scanCashLedger,
) {
  const meta = loadPositionMeta();

  // v8: the exit monitor now runs during a scan, so since this plan was
  // built the symbol may have been bought, or closed and put on cooldown.
  // Re-check both here, under the position lock, at execution time.
  if (meta[plan.symbol.toUpperCase()]) {
    recordCandidateRejection(
      plan.symbol,
      "HELD_AT_EXECUTION",
      "already held when the order was about to be placed",
    );
    return false;
  }
  const executionCooldown = cooldownTracker.checkCooldown(plan.symbol);
  if (executionCooldown.onCooldown) {
    recordCandidateRejection(
      plan.symbol,
      "COOLDOWN_AT_EXECUTION",
      executionCooldown.minutesRemaining + " min remaining (closed during this scan)",
    );
    return false;
  }

  // v7.2: cash already committed by earlier opens in THIS scan. Without
  // this, every plan in a batch sees the same pre-scan cash and the batch
  // collectively overspends — the documented cause of the partial fills.
  const cashCommittedThisScan = scanCashLedger ? scanCashLedger.committed : 0;

  // ══════════════════════════════════════════════════════════════════════
  // P0 FIX (2026-07-27) — POSITION CAPS ENFORCED AT EXECUTION TIME.
  //
  // The day/swing caps were checked ONLY inside buildTradePlan(), against
  // an openCounts snapshot taken once at the top of the scan. Every plan
  // in a scan therefore evaluated the cap against the SAME stale count.
  // With six plans built while dayCount was 0, all six passed a "< 3"
  // check, all six were screened, and the open loop then executed them
  // one after another without ever re-counting.
  //
  // Observed live 2026-07-27, 01:00 ET: DT_MAX_DAY_POSITIONS=3 and the
  // bot opened FIVE positions in 54 seconds — MU $2250, SNAP $3265,
  // RIVN $2250, AVGO $1597, HOOD $2250 = $11,612 against $9,323 of
  // effective capital, or 125% allocated in a single scan. The next three
  // hours were spent logging "Insufficient cash" on every subsequent plan.
  //
  // This is the last line of defence and covers every entry path, in the
  // same spirit as the ethics gate below it. It re-reads the live meta on
  // every call, so it cannot be fooled by a stale snapshot.
  // ══════════════════════════════════════════════════════════════════════
  const liveCounts = countOpenByType(meta);
  const isSwingPlan = plan.tradeType === "SWING";
  const liveCount = isSwingPlan ? liveCounts.swingCount : liveCounts.dayCount;
  const liveCap = isSwingPlan
    ? config.maxSwingPositions
    : config.maxDayPositions;

  if (liveCount >= liveCap) {
    const reason =
      plan.tradeType +
      " slots full at execution time (" +
      liveCount +
      "/" +
      liveCap +
      ") — the cap was free when this plan was built earlier in the scan";
    logger.info(plan.symbol + " blocked: " + reason);
    recordCandidateRejection(plan.symbol, "POSITION_CAP_EXECUTION", reason);
    return;
  }

  // AGGREGATE GROSS EXPOSURE CAP. Per-position caps alone cannot bound the
  // book: maxPositionPctDay is 0.35, so three day slots permit 105% of
  // capital by construction, before any swing sleeve. This caps the SUM.
  if (config.maxTotalExposurePct > 0) {
    const committedDollars = Object.values(meta).reduce(
      (total, positionMeta) => total + (positionMeta.dollarAmount || 0),
      0,
    );
    const exposureCeiling =
      capitalState.effectiveCapital * config.maxTotalExposurePct;
    if (committedDollars + plan.positionDollars > exposureCeiling) {
      const reason =
        "gross exposure cap: $" +
        committedDollars.toFixed(0) +
        " already committed + $" +
        plan.positionDollars +
        " would exceed the $" +
        exposureCeiling.toFixed(0) +
        " ceiling (" +
        (config.maxTotalExposurePct * 100).toFixed(0) +
        "% of $" +
        capitalState.effectiveCapital.toFixed(0) +
        " capital)";
      logger.info(plan.symbol + " blocked: " + reason);
      recordCandidateRejection(plan.symbol, "GROSS_EXPOSURE_CAP", reason);
      return;
    }
  }

  // HARD GATE: never buy gambling/betting, alcohol, or adult-industry
  // stocks — static blocklist + Finnhub industry check. This is the last
  // line of defense and covers every entry path (watchlist + discovery).
  const ethicsCheck = await ethicsFilter.isBlocked(plan.symbol);
  if (ethicsCheck.blocked) {
    logger.info(plan.symbol + " blocked: " + ethicsCheck.reason);
    recordCandidateRejection(plan.symbol, "ETHICS_FILTER", ethicsCheck.reason);
    return;
  }

  // V5: EARNINGS BLACKOUT — never enter into a known earnings gap.
  // Unknown (no Finnhub key / API failure) → allow, but say so in the log.
  if (config.earningsBlackoutEnabled && finnhub.isConfigured()) {
    const blackoutWindowDays =
      plan.tradeType === "SWING"
        ? config.earningsBlackoutSwingDays
        : config.earningsBlackoutDayDays;
    const earningsCheck = await finnhub.checkEarningsWithinDays(
      plan.symbol,
      blackoutWindowDays,
    );
    if (earningsCheck.hasEarnings === true) {
      logger.info(
        plan.symbol +
          " blocked: earnings on " +
          earningsCheck.earningsDate +
          " within the " +
          blackoutWindowDays +
          "-day " +
          plan.tradeType +
          " window",
      );
      recordCandidateRejection(
        plan.symbol,
        "EARNINGS_BLACKOUT",
        "earnings " + earningsCheck.earningsDate,
      );
      return;
    }
    if (earningsCheck.hasEarnings === null) {
      logger.info(
        plan.symbol +
          ": earnings calendar unavailable — proceeding without the blackout check",
      );
    }
  }

  // v5: pre-trade safety is now ASYNC (dynamic sector buckets) and takes
  // EFFECTIVE capital (same base as sizing and the loss limit)
  const safety = await riskManager.checkPreTradeSafety(
    plan.symbol,
    portfolio.openPositions || [],
    capitalState.effectiveCapital,
    // v7.2: real remaining cash, net of what earlier opens in this same
    // scan have already committed.
    Math.max(0, (portfolio.availableCash || 0) - cashCommittedThisScan),
    plan.positionDollars,
    plan.tradeType,
    meta,
    plan.averageDollarVolume, // v5.1: liquidity/spread floor
  );
  if (!safety.allowed) {
    logger.info(plan.symbol + " blocked: " + safety.reason);
    recordCandidateRejection(plan.symbol, "PRE_TRADE_SAFETY", safety.reason);
    return;
  }

  try {
    const instrumentId = await etoroClient.resolveTickerToInstrumentId(
      plan.symbol,
    );
    if (!instrumentId) {
      logger.warn(plan.symbol + " not resolvable on eToro — skipping");
      recordCandidateRejection(
        plan.symbol,
        "ETORO_RESOLUTION",
        "instrument not found on eToro",
      );
      return;
    }

    // LIVE SPREAD GUARD: a wide bid/ask spread is an instant loss on fill
    // (BRAI realized -4.0% in one minute against a -2.9% stop — the extra
    // ~1% was spread). Check the live rate right before committing money.
    // Fail-open: if the rate can't be fetched, the trade proceeds — the
    // liquidity floor and discovery caps remain the outer defenses.
    if (etoroMarketData.isConfigured()) {
      try {
        const ratesByInstrumentId = await etoroMarketData.fetchBatchedRates([
          instrumentId,
        ]);
        const liveRate = ratesByInstrumentId[instrumentId];
        if (liveRate && liveRate.ask > 0 && liveRate.bid > 0) {
          const midPrice = (liveRate.ask + liveRate.bid) / 2;
          const spreadFraction = (liveRate.ask - liveRate.bid) / midPrice;
          if (spreadFraction > config.maxSpreadPct) {
            logger.info(
              plan.symbol +
                " blocked: live spread " +
                (spreadFraction * 100).toFixed(2) +
                "% exceeds the " +
                (config.maxSpreadPct * 100).toFixed(2) +
                "% cap — entering would start the trade at an instant loss",
            );
            recordCandidateRejection(
              plan.symbol,
              "SPREAD_GUARD",
              "live spread " + (spreadFraction * 100).toFixed(2) + "%",
            );
            return;
          }
        }
      } catch (spreadError) {
        logger.warn(
          plan.symbol +
            ": spread check failed (" +
            spreadError.message +
            ") — proceeding without it",
        );
      }
    }

    const openResult = await etoroClient.openBuyPosition(
      instrumentId,
      plan.positionDollars,
      plan.symbol,
    );
    // openBuyPosition returns null when it SKIPS (size below minimum) —
    // without this check the bot used to record a position that was never
    // opened: phantom meta entry, false OPEN Telegram, exit engine managing
    // a trade that doesn't exist.
    if (!openResult) {
      recordCandidateRejection(
        plan.symbol,
        "ETORO_OPEN_SKIPPED",
        "order not placed (below minimum size)",
      );
      return;
    }

    if (plan.source === "DISCOVERED") {
      marketDiscovery.recordTraded(plan.symbol);
    }

    // v5.7: VERIFY THE ACTUAL FILL. Before this, the bot trusted its own
    // plan.positionDollars for meta/Telegram/journal — it never checked what
    // eToro actually invested. Traced from a real case: SOFI was requested
    // at $70, eToro's account showed only $1.39 actually invested, and
    // nothing in the bot noticed or reported it. Re-fetch the portfolio and
    // read the REAL position back so tracking matches the real account, and
    // fire a loud alert if the fill is nowhere near what was requested.
    let actualDollarAmount = plan.positionDollars;
    let fillWasVerified = false;
    try {
      await etoroClient.sleep(3000); // give eToro a moment to settle the fill
      const rawPortfolioAfterOpen = await etoroClient.fetchRawPortfolio();
      const portfolioAfterOpen = etoroClient.parsePortfolioFromRawData(
        rawPortfolioAfterOpen,
      );
      const filledPosition = (portfolioAfterOpen.openPositions || []).find(
        (position) => position.instrumentId === instrumentId,
      );
      if (filledPosition && filledPosition.amountInvested > 0) {
        actualDollarAmount = filledPosition.amountInvested;
        fillWasVerified = true;
        const fillRatio = actualDollarAmount / plan.positionDollars;
        if (fillRatio < 0.9 || fillRatio > 1.1) {
          logger.warn(
            plan.symbol +
              ": FILL MISMATCH — requested $" +
              plan.positionDollars +
              " but eToro actually invested $" +
              actualDollarAmount.toFixed(2) +
              " (" +
              (fillRatio * 100).toFixed(0) +
              "% of requested)",
          );
          await alerts.systemAlert(
            "FILL_MISMATCH",
            plan.symbol +
              ": requested $" +
              plan.positionDollars +
              " but eToro actually invested $" +
              actualDollarAmount.toFixed(2) +
              " (" +
              (fillRatio * 100).toFixed(0) +
              "% of requested). Position tracking now uses the REAL amount — " +
              "check the eToro app to confirm.",
          );
        }
      } else {
        logger.warn(
          plan.symbol +
            ": could not find the position in the portfolio right after " +
            "opening — meta will use the PLANNED amount ($" +
            plan.positionDollars +
            "); verify manually in the eToro app",
        );
      }
    } catch (verifyError) {
      logger.warn(
        plan.symbol +
          ": could not verify actual fill amount (" +
          verifyError.message +
          ") — meta will use the planned amount",
      );
    }

    meta[plan.symbol.toUpperCase()] = {
      // Exit-engine fields
      tradeType: plan.tradeType,
      entryPrice: plan.entryPrice,
      stopPrice: plan.stopPrice,
      targetT1: plan.targetT1,
      targetT2: plan.targetT2,
      targetT3: plan.targetT3,
      swingTrailPct: plan.swingTrailPct,
      lockedFloor: null,
      peakPrice: plan.entryPrice,
      peakSetAt: Date.now(), // v6: profit-stall guard's "no new high since" clock
      recentPrices: [], // v6: short rolling window for the recovery/stall trend read
      partialDone: false, // day tier flag
      partialT1Done: false, // swing tier flags
      partialT2Done: false,
      // Bookkeeping
      setup: plan.setup,
      source: plan.source,
      confidence: aiResult ? aiResult.confidence : null,
      dollarAmount: actualDollarAmount, // REAL invested amount, not the plan
      plannedDollarAmount: plan.positionDollars, // kept for comparison/debugging
      // v8: partial-exit accounting. dollarAmount shrinks as partials sell;
      // these keep the whole trade's size and banked P&L for the final record.
      originalDollarAmount: actualDollarAmount,
      realizedPartialPnl: 0,
      partialFills: [],
      troughPrice: plan.entryPrice, // v8: lowest price seen while held (MAE)
      openedAt: Date.now(),
      // v7.2: null until eToro actually shows the position. The per-tick
      // sync uses this to know whether the amount above is a VERIFIED fill
      // or merely the requested figure standing in for one.
      fillVerifiedAt: fillWasVerified ? new Date().toISOString() : null,
      plan, // full plan echoed for the journal on close
      entryConditions: {
        tradeType: plan.tradeType, // v5.1: ORIGINAL type at entry — positionMeta.tradeType
        // mutates to SWING if the reviewer later extends it; this field lets
        // self-evaluation tell "born DAY, later extended" apart from "born SWING"
        // v7.12: TRUE when this cleared every SWING bar (TRENDING regime,
        // RSI < 70, relative strength >= 1.5, above VWAP) and was demoted to
        // DAY only because swing capacity was unavailable. Without this the
        // month's trade history cannot tell a swing-grade setup apart from
        // an ordinary DAY trade, and the question the v7.11 downgrade exists
        // to answer — "should swings be re-enabled?" — stays unanswerable.
        downgradedFromSwing: plan.downgradedFromSwing === true,
        score: plan.score,
        regime: plan.regime,
        spyChangePercent: plan.spyChangePercent,
        relativeStrength: plan.relativeStrength,
        rsi: plan.rsi,
        aboveVwap: plan.aboveVwap,
        atrPercent: plan.atrPercent,
        volatilityBucket: plan.volatilityBucket,
        entryHourET: sessionTiming.getEasternHourMinute().hour,
        // v7.8: fields the 2026-08-28 audit had to reconstruct by hand.
        // Recording them makes every future analysis direct instead of
        // inferential — and inference breaks silently when an input moves.
        priceChangePercent: plan.priceChangePercent, // raw move at entry
        moveToAtrRatio: plan.moveToAtrRatio, // strongest known predictor
        sectorBucket: sectorMap.getStaticBucket(plan.symbol) || null,
        sizeMultiplier:
          (plan.sizingBreakdown && plan.sizingBreakdown.symbolMultiplier) || 1,
        // Which selection filters were live when this trade was taken, so a
        // later analysis can tell a config change apart from a market change.
        filtersActive: {
          minEntryScore: config.minEntryScore,
          maxEntryAtrPct: config.maxEntryAtrPct,
          prefilterMinMovePct: config.prefilterMinMovePct,
          minMoveToAtrRatio: config.minMoveToAtrRatio,
          overnightDeadZone: config.overnightDeadZoneEnabled,
        },
      },
    };
    savePositionMeta(meta);

    // v7.2: record the cash this open just committed, so the NEXT plan in
    // the same scan checks affordability against what is actually left.
    // Uses the verified fill when eToro gave us one, otherwise the
    // requested amount — deliberately the more conservative of the two,
    // since assuming a smaller commitment is what caused the overspend.
    if (scanCashLedger) {
      scanCashLedger.committed += Math.max(
        actualDollarAmount,
        plan.positionDollars,
      );
    }

    journal.tradeOpened(plan);
    logger.info(
      "✅ OPEN " +
        plan.symbol +
        " [" +
        plan.tradeType +
        "/" +
        plan.source +
        "] $" +
        actualDollarAmount.toFixed(2) +
        (actualDollarAmount !== plan.positionDollars
          ? " (planned $" + plan.positionDollars + ")"
          : "") +
        " stop $" +
        plan.stopPrice.toFixed(2),
    );
    // Telegram shows the REAL invested amount eToro confirmed, not the plan.
    await notifications.sendTelegramMessage(
      tradePlanner.formatPlanForTelegram(
        { ...plan, positionDollars: actualDollarAmount },
        aiResult ? aiResult.reasoning : null,
      ),
    );
    return true;
  } catch (openError) {
    logger.error("Open error for " + plan.symbol + ": " + openError.message);
    journal.error("OPEN:" + plan.symbol, openError.message);
    // V7: a failed OPEN is an eToro execution problem — alert it.
    await alerts.systemAlert(
      "ETORO_OPEN",
      "eToro FAILED to open a position in " +
        plan.symbol +
        " ($" +
        plan.positionDollars +
        "): " +
        openError.message +
        ". No position meta was saved for it (nothing to clean up), but if " +
        "this repeats, check the eToro API key / rate limits.",
    );
  }
}

// -----------------------------
// V6: GHOST-POSITION RECONCILIATION (2026-07-21)
// -----------------------------
// position-meta.json can silently diverge from eToro's real portfolio: a
// position closes via stop/target/manual action outside the bot's own exit
// path (a crash between the eToro close call and the meta delete, an
// exit-monitor failure window, etc.) and the meta entry is never removed.
// CONFIRMED LIVE 2026-07-21: 4 of 5 tracked positions (MU/NBIS/ARM/HOOD)
// had no matching eToro position at all — MU's meta dated back 7 days as a
// "DAY" trade that should have force-closed daily. A ghost entry doesn't
// just show stale data: it PERMANENTLY blocks re-entry into that symbol
// (the no-pyramiding guard) and inflates the day/swing slot count forever,
// which can silently block ALL new entries once phantom count reaches the
// slot cap. Runs every tick (reuses the already-fetched portfolio — zero
// extra API calls). A grace window protects a JUST-opened position from
// eToro's own order-settlement lag.
// ══════════════════════════════════════════════════════════════════════
// v7.2 — SELF-HEALING POSITION SYNC.
//
// Corrects the bot's record against what eToro ACTUALLY holds. Returns true
// if anything changed (so the caller persists the meta).
//
// Two fields matter:
//   · dollarAmount — used by the gross-exposure cap, the performance record
//     and every P&L figure. A stale value here is silently wrong forever.
//   · entryPrice  — the basis for stop/target geometry. If eToro filled at a
//     different price than planned, the geometry must move WITH it so the
//     intended risk percentage is preserved; otherwise a -3% stop quietly
//     becomes a -4% stop.
//
// lockedFloor is never loosened by this: a ratcheted floor is a promise.
function syncPositionMetaWithLive(positionMeta, livePosition, symbol) {
  let changed = false;

  // ── Invested amount ──────────────────────────────────────────────────
  const liveAmount = livePosition.amountInvested;
  if (typeof liveAmount === "number" && liveAmount > 0) {
    const tracked = positionMeta.dollarAmount || 0;
    const driftPct = tracked > 0 ? Math.abs(liveAmount - tracked) / tracked : 1;
    if (driftPct > config.positionSyncAmountTolerancePct) {
      logger.warn(
        "🔧 " +
          symbol +
          ": tracked amount $" +
          tracked.toFixed(2) +
          " but eToro actually holds $" +
          liveAmount.toFixed(2) +
          " (" +
          (driftPct * 100).toFixed(0) +
          "% off) — correcting the bot's record to the REAL amount.",
      );
      positionMeta.dollarAmount = Number(liveAmount.toFixed(2));
      // v8: before any partial has sold, the live amount IS the trade's
      // original size — keep the whole-trade record consistent with it.
      if (!positionMeta.partialDone && !positionMeta.realizedPartialPnl) {
        positionMeta.originalDollarAmount = positionMeta.dollarAmount;
      }
      // Only alert once per position, not every minute.
      if (!positionMeta.amountCorrectedAt) {
        positionMeta.amountCorrectedAt = new Date().toISOString();
        alerts
          .systemAlert(
            "POSITION_AMOUNT_DRIFT",
            symbol +
              ": the bot was tracking " +
              formatDualAmount(tracked) +
              " but eToro actually holds " +
              formatDualAmount(liveAmount) +
              ". Tracking has been corrected to the real amount. A planned " +
              "50% partial exit is NOT this — that is accounted for " +
              "separately — so this indicates a genuine fill mismatch worth " +
              "checking in the eToro app.",
          )
          .catch(() => {});
      }
      changed = true;
    }
  }

  // ── Entry price, and the geometry derived from it ────────────────────
  const liveEntry = livePosition.openPrice;
  const trackedEntry = positionMeta.entryPrice;
  if (
    typeof liveEntry === "number" &&
    liveEntry > 0 &&
    typeof trackedEntry === "number" &&
    trackedEntry > 0
  ) {
    const entryDriftPct = Math.abs(liveEntry - trackedEntry) / trackedEntry;
    if (entryDriftPct > config.positionSyncEntryTolerancePct) {
      const scaleRatio = liveEntry / trackedEntry;
      logger.warn(
        "🔧 " +
          symbol +
          ": tracked entry $" +
          trackedEntry +
          " but eToro filled at $" +
          liveEntry +
          " (" +
          (entryDriftPct * 100).toFixed(2) +
          "% off) — rescaling stop/targets by ×" +
          scaleRatio.toFixed(5) +
          " so the intended risk percentage is preserved.",
      );

      positionMeta.entryPrice = liveEntry;
      // Scale the geometry so the planned risk/reward percentages hold.
      for (const field of ["stopPrice", "targetT1", "targetT2", "targetT3"]) {
        if (typeof positionMeta[field] === "number") {
          positionMeta[field] = Number(
            (positionMeta[field] * scaleRatio).toFixed(4),
          );
        }
      }
      // A ratcheted floor may rise with the entry but must NEVER fall.
      if (typeof positionMeta.lockedFloor === "number") {
        const scaledFloor = positionMeta.lockedFloor * scaleRatio;
        if (scaledFloor > positionMeta.lockedFloor) {
          positionMeta.lockedFloor = Number(scaledFloor.toFixed(4));
        }
      }
      positionMeta.entryCorrectedAt = new Date().toISOString();
      changed = true;
    }
  }

  return changed;
}

// ══════════════════════════════════════════════════════════════════════
// v7.3 — QUEUED-ORDER VISIBILITY ON TELEGRAM.
//
// An order eToro accepts but does not fill (placed outside its trading
// window, so it sits queued until the next open) was previously invisible:
// the bot sent a "🟢 OPEN" message the moment the order was accepted, and
// nothing ever said it had not actually filled. On 2026-07-31 two $3,275
// orders queued on Friday evening were reported as opened, reserved $6,550
// of cash all weekend, and never appeared as positions.
//
// Notifies only when the SET of queued orders CHANGES — a new one appears,
// or one clears — so it stays informative rather than repeating every
// minute. Fires once more on restart, which is useful rather than noisy.
let lastNotifiedPendingOrderKey = null;

async function notifyPendingOrderChanges(portfolio) {
  const pendingOrders = portfolio.pendingOrders || [];
  // Only orders that OPEN a position matter here; close-side orders are
  // already reported by the exit path that created them.
  const openSideOrders = pendingOrders.filter(
    (order) => order.source === "ordersForOpen" || order.source === "stockOrders",
  );

  const currentKey = openSideOrders
    .map((order) => String(order.orderId))
    .sort()
    .join(",");
  if (currentKey === lastNotifiedPendingOrderKey) return;

  const hadOrdersBefore =
    lastNotifiedPendingOrderKey !== null && lastNotifiedPendingOrderKey !== "";
  lastNotifiedPendingOrderKey = currentKey;

  if (openSideOrders.length === 0) {
    if (hadOrdersBefore) {
      await notifications.sendTelegramMessage(
        "✅ <b>Queued orders cleared</b>\nAll previously queued orders have " +
          "either filled or been cancelled. Reserved cash is released.",
      );
    }
    return;
  }

  const lines = [];
  let reservedTotal = 0;
  for (const order of openSideOrders) {
    let ticker = String(order.instrumentId);
    try {
      const resolved = await etoroClient.resolveInstrumentIdToTicker(
        order.instrumentId,
      );
      if (resolved) ticker = String(resolved).toUpperCase();
    } catch {
      /* fall back to the numeric id — never block a notification on a lookup */
    }
    reservedTotal += order.amount || 0;
    lines.push(
      "· <b>" +
        escapeHtml(ticker) +
        "</b> — " +
        formatDualAmount(order.amount || 0) +
        " (order " +
        order.orderId +
        ")",
    );
  }

  await notifications.sendTelegramMessage(
    "⏳ <b>Order(s) QUEUED, not yet filled</b>\n" +
      lines.join("\n") +
      "\n\n" +
      formatDualAmount(reservedTotal) +
      " of cash is reserved against these. eToro accepted them but has not " +
      "executed them — this normally means they were placed outside the " +
      "instrument's trading window and will fill at the next open.\n\n" +
      "They are NOT open positions yet, so no stop is active on them. The " +
      "bot will pick them up automatically once they fill.",
  );
  logger.info(
    "⏳ " +
      openSideOrders.length +
      " queued order(s) notified — $" +
      reservedTotal.toFixed(2) +
      " reserved.",
  );
}

// ══════════════════════════════════════════════════════════════════════
// v7.2 — UNTRACKED LIVE POSITIONS.
//
// Both manageOpenPositions and eod-closer used to `continue` past any live
// position with no meta entry, silently and forever: no stop enforcement,
// no exit management, no EOD close, and no alert telling anyone.
//
// That is exactly the state the RIVN incident produced — eToro's copy engine
// mirrored a $1,120 RIVN position while the account API never reported it,
// the ghost sweeper cleared the tracking after 30 minutes, and had that
// position surfaced later it would have run completely unmanaged.
//
// Policy:
//   · Reappearing after the bot ghosted it → RE-ADOPT the saved meta. This
//     is unambiguously the bot's own position coming back.
//   · Never seen before → alert (throttled). Adoption is opt-in via
//     DT_ADOPT_FOREIGN_POSITIONS, because a position the bot never opened
//     may be a deliberate manual trade and closing it is not its business.
async function handleUntrackedPositions(portfolio, meta) {
  let metaChanged = false;
  const clearedRecords = loadClearedPositions();

  for (const position of portfolio.openPositions || []) {
    const symbol = (position.symbol || "").toUpperCase();
    if (meta[symbol]) continue; // tracked — nothing to do

    // v8.5: eToro keeps listing a position for a few seconds after the bot
    // closes it. Every bot close starts a cooldown, so a symbol closed moments
    // ago is settling, not untracked — this raised false UNTRACKED_POSITION
    // alerts 4-8 s after the bot's own closes (ANET/NBIS 2026-09-17, ISRG
    // 2026-09-18, SMCI/AFRM 2026-09-11). Still listed after the grace → alert.
    const recentClose = cooldownTracker.checkCooldown(symbol);
    if (
      recentClose.minutesSinceExit != null &&
      recentClose.minutesSinceExit < config.closeSettleGraceMinutes
    ) {
      logger.info(
        symbol +
          " still listed by eToro " +
          Math.round(recentClose.minutesSinceExit * 60) +
          "s after the bot closed it — settling, not untracked",
      );
      continue;
    }

    const clearedRecord = clearedRecords[symbol];
    const withinReadoptWindow =
      clearedRecord &&
      Date.now() - new Date(clearedRecord.clearedAt).getTime() <
        config.readoptWindowMinutes * 60 * 1000;

    if (withinReadoptWindow && clearedRecord.meta) {
      meta[symbol] = clearedRecord.meta;
      meta[symbol].readoptedAt = new Date().toISOString();
      meta[symbol].confirmedInPortfolioAt = new Date().toISOString();
      delete clearedRecords[symbol];
      saveClearedPositions(clearedRecords);
      metaChanged = true;

      logger.warn(
        "♻️ " +
          symbol +
          " REAPPEARED on eToro after being cleared as a ghost — re-adopting " +
          "the saved plan so stops and exits apply again.",
      );
      await alerts.systemAlert(
        "POSITION_READOPTED",
        symbol +
          " reappeared in the eToro portfolio after the bot had cleared it as " +
          "a ghost. Its original plan (stop $" +
          (meta[symbol].lockedFloor || meta[symbol].stopPrice) +
          ") has been restored so it is managed again rather than running " +
          "unprotected. Verify the position looks right in the eToro app.",
      );
      continue;
    }

    if (config.adoptForeignPositions) {
      meta[symbol] = buildAdoptedMeta(position);
      metaChanged = true;
      logger.warn(
        "🪝 " +
          symbol +
          " is open on eToro but was never tracked — ADOPTING it with a " +
          "protective stop (DT_ADOPT_FOREIGN_POSITIONS is on).",
      );
      await alerts.systemAlert(
        "POSITION_ADOPTED",
        symbol +
          " was open on eToro with no bot tracking. It has been adopted with " +
          "a protective stop at $" +
          meta[symbol].stopPrice +
          " so it is no longer unmanaged.",
      );
      continue;
    }

    // Alert only — throttled by the alerts module's own key throttling.
    await alerts.systemAlert(
      "UNTRACKED_POSITION",
      symbol +
        " is OPEN on eToro (" +
        formatDualAmount(position.amountInvested || 0) +
        ", P&L " +
        formatDualAmount(position.unrealizedProfitLoss || 0, { signed: true }) +
        ") but the bot has NO record of it. It is running with NO stop-loss, " +
        "NO exit management and NO end-of-day close. Either close it manually " +
        "in the eToro app or set DT_ADOPT_FOREIGN_POSITIONS=true so the bot " +
        "protects it.",
    );
    logger.warn(
      "⚠️ " +
        symbol +
        " is open on eToro but UNTRACKED — no stop, no exit management.",
    );
  }

  return metaChanged;
}

// A conservative meta for a position the bot did not plan: an ATR-free
// percentage stop off the real fill price, treated as a DAY trade.
function buildAdoptedMeta(position) {
  const entryPrice = position.openPrice;
  const stopPrice = Number(
    (entryPrice * (1 - config.adoptedPositionStopPct)).toFixed(4),
  );
  return {
    tradeType: "DAY",
    entryPrice,
    stopPrice,
    targetT1: Number(
      (entryPrice * (1 + config.adoptedPositionStopPct * 2)).toFixed(4),
    ),
    targetT2: null,
    targetT3: null,
    lockedFloor: null,
    peakPrice: entryPrice,
    peakSetAt: Date.now(),
    recentPrices: [],
    partialDone: false,
    partialT1Done: false,
    partialT2Done: false,
    setup: "ADOPTED",
    source: "ADOPTED",
    confidence: 0,
    dollarAmount: position.amountInvested,
    openedAt: Date.now(),
    adoptedAt: new Date().toISOString(),
    confirmedInPortfolioAt: new Date().toISOString(),
    plan: null,
  };
}

// ── Cleared-position memory (feeds the re-adoption path above) ──────────
const clearedPositionsPath = path.join(
  __dirname,
  "../data/cleared-positions.json",
);

function loadClearedPositions() {
  try {
    if (!fs.existsSync(clearedPositionsPath)) return {};
    return JSON.parse(fs.readFileSync(clearedPositionsPath, "utf8"));
  } catch {
    return {};
  }
}

function saveClearedPositions(records) {
  try {
    const directory = path.dirname(clearedPositionsPath);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(clearedPositionsPath, JSON.stringify(records, null, 2));
  } catch (saveError) {
    logger.warn("Could not save cleared-position record: " + saveError.message);
  }
}

// Drop records older than the re-adoption window so the file stays small.
function pruneClearedPositions(records) {
  const cutoffMs = Date.now() - config.readoptWindowMinutes * 60 * 1000;
  let pruned = false;
  for (const [symbol, record] of Object.entries(records)) {
    if (new Date(record.clearedAt).getTime() < cutoffMs) {
      delete records[symbol];
      pruned = true;
    }
  }
  return pruned;
}

async function reconcileGhostPositions(portfolio, meta) {
  const liveSymbols = new Set(
    (portfolio.openPositions || []).map((position) =>
      (position.symbol || "").toUpperCase(),
    ),
  );

  // v7.2: a symbol with an order still in flight is NOT a ghost. eToro parks
  // orders across seven different arrays; the bot used to read only
  // `positions`, so a queued order was indistinguishable from "gone" and got
  // cleared. Resolve each pending order's instrumentId back to its ticker so
  // it can shield that symbol from the sweeper.
  const pendingSymbols = new Set();
  for (const pendingOrder of portfolio.pendingOrders || []) {
    if (pendingOrder.instrumentId == null) continue;
    try {
      const ticker = await etoroClient.resolveInstrumentIdToTicker(
        pendingOrder.instrumentId,
      );
      if (ticker) pendingSymbols.add(String(ticker).toUpperCase());
    } catch {
      /* best effort — a failed lookup must never block the sweeper */
    }
  }

  const clearedRecords = loadClearedPositions();
  let clearedChanged = pruneClearedPositions(clearedRecords);
  let metaChanged = false;

  for (const symbol of Object.keys(meta)) {
    const positionMeta = meta[symbol];

    // Seen in the live portfolio → stamp it. A position that has been
    // confirmed at least once is one the ghost sweeper can trust its own
    // absence for later.
    if (liveSymbols.has(symbol)) {
      if (!positionMeta.confirmedInPortfolioAt) {
        positionMeta.confirmedInPortfolioAt = new Date().toISOString();
        metaChanged = true;
      }
      continue;
    }

    // v7.2: an order still in flight for this symbol means it is NOT a
    // ghost — it is pending. Never clear tracking while eToro is still
    // holding an order for it.
    if (pendingSymbols.has(symbol)) {
      logger.info(
        "⏸ " +
          symbol +
          " has a PENDING order on eToro — not a ghost, leaving tracking intact.",
      );
      continue;
    }

    const ageMinutes = (Date.now() - (positionMeta.openedAt || 0)) / 60000;

    // ══════════════════════════════════════════════════════════════════
    // P1 FIX (2026-07-27) — NEVER-CONFIRMED POSITIONS GET A LONGER GRACE.
    //
    // eToro's portfolio feed routinely does not show a position straight
    // after opening: on 2026-07-27 four of five entries logged "could not
    // find the position in the portfolio right after opening", and the
    // one that WAS visible (AVGO) revealed a 49% fill mismatch — $3265
    // requested, $1597 actually invested.
    //
    // A 5-minute ghost grace against a feed that lags like that is a
    // false-positive generator. HOOD was opened at 01:00:50 ET and
    // declared a ghost five minutes later; the alert itself notes the
    // capital ledger was NOT adjusted because the real exit P&L is
    // unknown. If that position was in fact live, the bot walked away
    // from real money it had stopped tracking — and it then re-opened
    // HOOD later the same session.
    //
    // So: the short grace now applies only to positions eToro has
    // actually shown us at least once. A position never confirmed is
    // "unconfirmed", not "ghost", and gets a much longer window before
    // anything is cleared.
    // ══════════════════════════════════════════════════════════════════
    const wasEverConfirmed = !!positionMeta.confirmedInPortfolioAt;
    const graceMinutes = wasEverConfirmed
      ? config.ghostPositionGraceMinutes
      : config.unconfirmedPositionGraceMinutes;

    if (ageMinutes < graceMinutes) {
      if (!wasEverConfirmed && ageMinutes >= config.ghostPositionGraceMinutes) {
        logger.warn(
          "⏳ " +
            symbol +
            " has never appeared in the eToro portfolio since opening " +
            Math.round(ageMinutes) +
            " min ago. NOT clearing it yet — unconfirmed positions get " +
            config.unconfirmedPositionGraceMinutes +
            " min before the ghost sweeper touches them. Check the eToro " +
            "app: if this position is real, the portfolio feed is lagging; " +
            "if the order never filled, it will be cleared shortly.",
        );
      }
      continue; // still settling
    }

    const ageDescription =
      ageMinutes >= 1440
        ? (ageMinutes / 1440).toFixed(1) + " days"
        : Math.round(ageMinutes) + " min";
    logger.warn(
      "👻 GHOST POSITION: " +
        symbol +
        " is tracked in position-meta.json (opened " +
        ageDescription +
        " ago, entry $" +
        positionMeta.entryPrice +
        ", $" +
        positionMeta.dollarAmount +
        " invested, " +
        (positionMeta.tradeType || "DAY") +
        ") but eToro shows NO matching open position. It must have closed " +
        "outside the bot's own exit path. Clearing stale tracking now.",
    );
    try {
      await alerts.systemAlert(
        "GHOST_POSITION",
        symbol +
          " was tracked as OPEN (entered " +
          ageDescription +
          " ago, entry $" +
          positionMeta.entryPrice +
          ", " +
          formatDualAmount(positionMeta.dollarAmount) +
          " invested) but eToro no longer shows this position. It closed by " +
          "some path the bot didn't record — check eToro's trade history for " +
          "the real exit price/reason and reconcile manually if needed. " +
          "Clearing it from tracking now so it stops blocking re-entry and no " +
          "longer counts against your day/swing position slots. The capital " +
          "ledger was NOT adjusted (the real exit P&L is unknown) — please " +
          "verify effective capital is still accurate.",
      );
    } catch {
      // alerts.systemAlert never throws by design, but never let a ghost
      // sit un-cleared just because the alert path itself hiccupped.
    }
    // v7.2: remember what we cleared. If eToro later shows this position
    // again (its feed lagging, or an order that filled after we gave up),
    // handleUntrackedPositions() restores this exact plan instead of leaving
    // a live position running with no stop and no exit management.
    clearedRecords[symbol] = {
      clearedAt: new Date().toISOString(),
      meta: positionMeta,
    };
    clearedChanged = true;

    delete meta[symbol];
    metaChanged = true;
  }

  if (clearedChanged) saveClearedPositions(clearedRecords);

  return metaChanged;
}

// -----------------------------
// V2: DUPLICATE-POSITION RECONCILIATION
// -----------------------------
// Runs on every exit-monitor tick (reuses the already-fetched portfolio —
// zero extra API calls). ONLY acts on symbols this bot tracks in its meta
// file: duplicates are closed keeping the LARGEST, and a Telegram alert
// explains what happened. Untracked/manual positions are never touched.
async function reconcileDuplicatePositions(portfolio, meta) {
  try {
    const duplicatesToClose = etoroClient.findDuplicatePositions(portfolio);
    if (!duplicatesToClose.length) return;

    for (const duplicate of duplicatesToClose) {
      const upperSymbol = String(duplicate.symbol || "").toUpperCase();
      if (!meta[upperSymbol]) {
        logger.info(
          "Duplicate detected in UNTRACKED symbol " +
            upperSymbol +
            " — leaving it alone (not this bot's position)",
        );
        continue;
      }

      logger.warn(
        "🧹 Duplicate position in tracked symbol " +
          upperSymbol +
          " — closing extra positionId " +
          duplicate.positionId +
          " ($" +
          (duplicate.amount || 0).toFixed(2) +
          "), keeping the largest",
      );
      try {
        await etoroClient.closeExistingPosition(
          duplicate.positionId,
          duplicate.instrumentId,
          upperSymbol,
        );
        journal.error(
          "DUPLICATE_CLOSED:" + upperSymbol,
          "closed extra positionId " + duplicate.positionId,
        );
        await notifications.sendTelegramMessage(
          "🧹 <b>Duplicate position auto-closed</b>\n" +
            upperSymbol +
            " had multiple open positions (double-entry bug). Closed the " +
            "extra $" +
            (duplicate.amount || 0).toFixed(2) +
            " position, kept the largest. Position meta is unchanged.",
        );
        await etoroClient.sleep(2000);
      } catch (closeError) {
        logger.error(
          "Failed to close duplicate " +
            upperSymbol +
            ": " +
            closeError.message,
        );
        await alerts.systemAlert(
          "DUPLICATE_CLOSE",
          "Found a duplicate position in " +
            upperSymbol +
            " but FAILED to close the extra one: " +
            closeError.message +
            ". Check the eToro account manually.",
        );
      }
    }
  } catch (reconcileError) {
    logger.warn("Duplicate reconciliation failed: " + reconcileError.message);
  }
}

// -----------------------------
// EXIT / RISK MANAGEMENT (day + swing, partials)
// -----------------------------
async function manageOpenPositions() {
  const meta = loadPositionMeta();
  if (!Object.keys(meta).length) {
    // v6 FIX: this "zero-cost when flat" shortcut used to skip the price-
    // stream watchdog refresh entirely — so the LAST tracked position to
    // close (going from "tracked" to "flat book") never got unsubscribed:
    // it kept firing emergency ticks forever against its now-stale stop
    // level (harmless — it only ever triggers a check, never a trade — but
    // noisy and pointless). Clear the watch list before returning.
    priceStream.updateWatchedPositions([], {});
    return;
  }

  let portfolio;
  try {
    const raw = await etoroClient.fetchRawPortfolio();
    portfolio = etoroClient.parsePortfolioFromRawData(raw);
    await etoroClient.labelPositionsWithTickers(portfolio);
    // Portfolio responding → clear any prior alert
    await alerts.clearAlert(
      "ETORO_PORTFOLIO",
      "eToro portfolio endpoint is responding again — exit management is active.",
    );
  } catch (portfolioError) {
    // V7: with open positions and NO portfolio data, the bot is FLYING
    // BLIND — stops cannot be enforced. This is the single most dangerous
    // silent failure in the system. Alert it hard.
    logger.error(
      "Could not fetch portfolio while positions are OPEN: " +
        portfolioError.message,
    );
    await alerts.systemAlert(
      "ETORO_PORTFOLIO",
      "eToro portfolio fetch is FAILING while " +
        Object.keys(meta).length +
        " position(s) are OPEN (" +
        portfolioError.message +
        "). Stops CANNOT be enforced until this recovers — consider checking " +
        "the positions manually in the eToro app.",
    );
    return;
  }

  // V2: clean up any duplicate positions before exit logic runs
  await reconcileDuplicatePositions(portfolio, meta);

  let metaChanged = false;

  // V6: clear any tracked position that no longer exists on eToro at all —
  // must run AFTER duplicate reconciliation (which only trims extras of a
  // symbol still genuinely held) and BEFORE the exit loop below (which only
  // ever visits symbols eToro still reports, so a ghost would otherwise
  // never be revisited/cleared on its own).
  if (await reconcileGhostPositions(portfolio, meta)) metaChanged = true;

  // v7.2: must run AFTER the ghost sweeper (so a just-cleared record exists
  // to re-adopt from) and BEFORE the exit loop (so a re-adopted position is
  // managed on THIS tick rather than waiting for the next one).
  if (await handleUntrackedPositions(portfolio, meta)) metaChanged = true;

  // v7.3: tell Telegram when orders are queued but unfilled, and again when
  // they clear. Only fires on a CHANGE, so it never repeats every tick.
  try {
    await notifyPendingOrderChanges(portfolio);
  } catch (pendingNotifyError) {
    logger.warn(
      "Pending-order notification failed (non-fatal): " +
        pendingNotifyError.message,
    );
  }

  // v6: keep the real-time exit watchdog's subscription list + trigger
  // levels in sync with what's actually held and tracked — reuses this same
  // fetch, zero extra API calls. Also picks up a ratcheted floor/tightened
  // stop automatically since this runs every tick.
  priceStream.updateWatchedPositions(portfolio.openPositions, meta);

  // v8: every Nth pass logs one management-state line per open position.
  managePositionsCallCount++;
  const logPositionStatusThisPass =
    managePositionsCallCount % Math.max(1, config.positionStatusEveryTicks) === 0;

  for (const position of portfolio.openPositions || []) {
    const symbol = (position.symbol || "").toUpperCase();
    const positionMeta = meta[symbol];
    // v7.2: an untracked live position is no longer silently skipped — see
    // handleUntrackedPositions(), which runs before this loop and either
    // re-adopts it (if the bot ghosted it earlier) or alerts loudly.
    if (!positionMeta) continue;

    // ══════════════════════════════════════════════════════════════════
    // v7.2 — SELF-HEALING SYNC AGAINST THE REAL ACCOUNT.
    //
    // dollarAmount and entryPrice used to be written ONCE at open and never
    // checked again. Measured live on 2026-07-27: META was tracked at
    // $2,150 while eToro had actually invested $1,113.74 — a 93% error that
    // had been live for four hours, silently corrupting the exposure cap,
    // every risk figure and the eventual P&L record.
    //
    // The fill-verification at open only catches this when eToro shows the
    // position immediately, and it frequently does not (four of five entries
    // that morning logged "could not find the position right after
    // opening"). Reconciling every tick makes the correction inevitable
    // rather than dependent on one lucky lookup.
    // ══════════════════════════════════════════════════════════════════
    if (syncPositionMetaWithLive(positionMeta, position, symbol)) {
      metaChanged = true;
    }

    // eToro's own P&L gives us the live price for free (no API credit).
    // v7.2: derive from eToro's REAL openPrice, not the bot's recorded
    // entryPrice. When the two drifted, every stop and target comparison ran
    // against a phantom price — measured up to $0.16 off on a live position,
    // which is enough to trigger or miss a stop by itself.
    const priceBasis = position.openPrice || positionMeta.entryPrice;
    const currentPrice =
      priceBasis * (1 + (position.unrealizedProfitLossPercent || 0));
    if (!currentPrice) continue;

    // v6: maintain a small rolling window of recent prices EVERY tick,
    // regardless of decision — this is the recovery/profit-stall trend
    // signal risk-manager reads. Capped small (recoveryCheckMinSamples + 2)
    // so it's a SHORT-term read, not a long history.
    const recentPrices = Array.isArray(positionMeta.recentPrices)
      ? positionMeta.recentPrices
      : [];
    recentPrices.push({ price: currentPrice, atMs: Date.now() });
    const recentPricesCap = config.recoveryCheckMinSamples + 2;
    positionMeta.recentPrices =
      recentPrices.length > recentPricesCap
        ? recentPrices.slice(recentPrices.length - recentPricesCap)
        : recentPrices;
    metaChanged = true;

    const decision = riskManager.decidePositionAction(
      positionMeta,
      currentPrice,
    );

    if (decision.newPeak && decision.newPeak !== positionMeta.peakPrice) {
      positionMeta.peakPrice = decision.newPeak;
      // v6: stamp WHEN the high-water mark actually moved — this is the
      // clock the profit-stall guard reads ("no NEW peak in N minutes").
      positionMeta.peakSetAt = Date.now();
      metaChanged = true;
    }
    // v8: lowest price seen while held (MAE) for the closed-trade record.
    if (!(positionMeta.troughPrice <= currentPrice)) {
      positionMeta.troughPrice = currentPrice;
      metaChanged = true;
    }

    // v9.1: one line per open position per MINUTE into data/shadow-log, so
    // "why didn't it sell here" has no 10-minute holes in it. The console
    // line and the POSITION_STATUS journal event below stay on every 10th
    // tick — this is the same payload, just complete.
    try {
      const minuteStatus = riskManager.describePositionState(positionMeta, currentPrice);
      journal.positionMinute({
        symbol,
        price: currentPrice,
        pnlPct: minuteStatus.pnlPct,
        peakPct: minuteStatus.peakPct,
        state: minuteStatus.state,
        stopPrice: minuteStatus.stopPrice,
        stopKind: minuteStatus.stopKind,
        exitConditions: minuteStatus.exitConditions,
        nextTrim: minuteStatus.nextTrim,
        realizedPartialPnl: minuteStatus.realizedPartialPnl,
        reason: minuteStatus.reason,
        action: decision.action,
        heldMinutes: Math.round((Date.now() - (positionMeta.openedAt || Date.now())) / 60000),
      });
    } catch (minuteError) {
      logger.warn("Per-minute position log failed for " + symbol + ": " + minuteError.message);
    }

    // v8: what the bot is doing with this position and what happens next,
    // read from the engine's own levels (see describePositionState).
    if (logPositionStatusThisPass) {
      try {
        const status = riskManager.describePositionState(positionMeta, currentPrice);
        const signed = (value) => (value >= 0 ? "+" : "") + value.toFixed(2);
        logger.info(
          "📍 " +
            symbol +
            " [" +
            status.state +
            "] P&L " +
            signed(status.pnlPct) +
            "% (peak " +
            signed(status.peakPct) +
            "%) · " +
            status.exitConditions.join(" · ") +
            " · next trim: " +
            status.nextTrim +
            (status.realizedPartialPnl
              ? " · banked $" + status.realizedPartialPnl.toFixed(2)
              : "") +
            " · " +
            status.reason,
        );
        journal.positionStatus({ symbol, ...status });
      } catch (statusError) {
        logger.warn("Position status failed for " + symbol + ": " + statusError.message);
      }
    }

    // Whipsaw-confirmation state: risk-manager returns stopBreachTicks while
    // a shallow stop breach is being confirmed; any decision WITHOUT it
    // means price is back above the stop — reset the counter so the next
    // breach starts a fresh confirmation from tick 1.
    const breachTicks = decision.stopBreachTicks || 0;
    if ((positionMeta.stopBreachTicks || 0) !== breachTicks) {
      positionMeta.stopBreachTicks = breachTicks;
      metaChanged = true;
    }

    // v6: recovery-aware time-exit grace flags — stamped ONCE, the first
    // time risk-manager grants the extension; risk-manager itself checks
    // "is the (bounded) grace window still active" on every later tick.
    if (decision.grantStaleGrace && !positionMeta.staleGraceUsedAt) {
      positionMeta.staleGraceUsedAt = Date.now();
      metaChanged = true;
      logger.info(
        "🔄 " +
          symbol +
          ": stale-exit recovery grace granted (" +
          config.dayStaleGraceExtensionMinutes +
          " min)",
      );
      await notifications.sendTelegramMessage(
        "🔄 <b>" +
          symbol +
          "</b> — recovery signal detected, granting a one-time " +
          config.dayStaleGraceExtensionMinutes +
          "min extension instead of closing on the clock. The stop-loss " +
          "stays fully active throughout.",
      );
    }
    // v8.3: time ran out while red — the engine holds for breakeven instead
    // of selling at a loss on the clock. Stamped once; announced once.
    if (decision.startBreakevenWait && !positionMeta.waitingForBreakevenSince) {
      positionMeta.waitingForBreakevenSince = Date.now();
      metaChanged = true;
      const redPct = ((currentPrice / positionMeta.entryPrice - 1) * 100).toFixed(2);
      const breakevenPrice = positionMeta.entryPrice * (1 + config.staleBreakevenExitPct / 100);
      logger.info(
        "⏳ " + symbol + ": time budget spent at " + redPct + "% — not selling at a loss, waiting for breakeven $" +
          breakevenPrice.toFixed(2) + " (stop $" + Number(positionMeta.stopPrice).toFixed(2) + " stays active)",
      );
      await notifications.sendTelegramMessage(
        "⏳ <b>" + symbol + "</b> — time's up but it's red (" + redPct + "%). Not selling at a loss: " +
          "holding until it is back to breakeven ($" + breakevenPrice.toFixed(2) + "). The stop-loss ($" +
          Number(positionMeta.stopPrice).toFixed(2) + ") stays active, and if it is still red at the end of the " +
          "day it closes as usual.",
      );
    }
    if (decision.grantSwingTimeGrace && !positionMeta.swingTimeGraceUsedAt) {
      positionMeta.swingTimeGraceUsedAt = Date.now();
      metaChanged = true;
      logger.info(
        "🔄 " +
          symbol +
          ": swing time-exit recovery grace granted (" +
          config.swingTimeExitGraceExtensionDays +
          " days)",
      );
      await notifications.sendTelegramMessage(
        "🔄 <b>" +
          symbol +
          "</b> — recovery signal detected in a loss, granting a one-time " +
          config.swingTimeExitGraceExtensionDays +
          "-day extension instead of closing on the clock. The floor/stop " +
          "stays fully active throughout.",
      );
    }

    if (decision.action === "HOLD") continue;

    journal.exitDecision(
      symbol,
      decision.action,
      decision.reason,
      currentPrice,
      positionMeta,
    );

    // ── PARTIAL: sell a fraction, set the tier flag + floor on SUCCESS ──
    if (decision.action === "PARTIAL") {
      try {
        // v8: the P&L of the slice being sold, measured on the same snapshot
        // the decision used. Before v8 this cash was realized on eToro and
        // never recorded anywhere except, eventually, a noisy reconciliation.
        const partialRealizedPnl = Number(
          ((position.unrealizedProfitLoss || 0) * (decision.fraction || 0)).toFixed(2),
        );
        await etoroClient.closePartialPosition(
          position.positionId,
          position.instrumentId,
          symbol,
          decision.fraction,
        );
        if (!positionMeta.originalDollarAmount) {
          positionMeta.originalDollarAmount = positionMeta.dollarAmount;
        }
        capitalManager.recordRealizedPnl(partialRealizedPnl); // cash is realized now
        positionMeta.realizedPartialPnl = Number(
          ((positionMeta.realizedPartialPnl || 0) + partialRealizedPnl).toFixed(2),
        );
        positionMeta.partialFills = (positionMeta.partialFills || []).concat([
          {
            at: new Date().toISOString(),
            reason: decision.reason,
            fraction: decision.fraction,
            price: Number(currentPrice.toFixed(4)),
            pnlDollars: partialRealizedPnl,
          },
        ]);
        if (decision.flagOnSuccess) {
          positionMeta[decision.flagOnSuccess] = true;
        }
        if (decision.floorOnSuccess != null) {
          positionMeta.lockedFloor = decision.floorOnSuccess;
        }
        // ══════════════════════════════════════════════════════════════
        // v7.3 — SHRINK THE TRACKED AMOUNT AFTER A PARTIAL.
        //
        // Selling half a position halves what eToro holds, but this
        // handler never updated dollarAmount — so the meta still claimed
        // the full size. The v7.2 per-tick sync then saw an exactly-50%
        // gap and fired a "fill mismatch" alert on the very next tick.
        //
        // Measured 2026-08-03: EVERY drift alert that day (AMZN, META,
        // UPST, RKLB, IONQ, SOFI, GOOGL) followed a 50% partial by about
        // one minute. All of them were false alarms about the bot's own
        // deliberate action.
        //
        // Shrinking it here keeps the record truthful the moment the sell
        // succeeds. The sync stays as the backstop for a genuine
        // mismatch — it just no longer shouts about an expected one.
        // ══════════════════════════════════════════════════════════════
        if (typeof positionMeta.dollarAmount === "number" && decision.fraction) {
          positionMeta.dollarAmount = Number(
            (positionMeta.dollarAmount * (1 - decision.fraction)).toFixed(2),
          );
        }
        // v7: a queued reviewer partial is one-shot — clear it once filled so
        // the next tick doesn't bank another slice of the same position.
        if (decision.fromReviewer) {
          delete positionMeta.pendingReviewerAction;
        }
        metaChanged = true;

        const pnlPercent = (position.unrealizedProfitLossPercent || 0) * 100;
        logger.info(
          symbol +
            " PARTIAL " +
            Math.round(decision.fraction * 100) +
            "% (" +
            decision.reason +
            ") at +" +
            pnlPercent.toFixed(1) +
            "%" +
            (positionMeta.lockedFloor
              ? " — floor now $" + positionMeta.lockedFloor.toFixed(2)
              : "") +
            " · banked $" +
            partialRealizedPnl.toFixed(2),
        );
        await notifications.sendTelegramMessage(
          "🎯 <b>" +
            symbol +
            " partial exit</b> (" +
            humanize(decision.reason) +
            ")\nSold " +
            Math.round(decision.fraction * 100) +
            "% at +" +
            pnlPercent.toFixed(1) +
            "%, banked " +
            formatDualAmount(partialRealizedPnl, { signed: true }) +
            ". Rest keeps running" +
            (positionMeta.lockedFloor
              ? ", floor locked at $" + positionMeta.lockedFloor.toFixed(2)
              : "") +
            ".",
        );
        await etoroClient.sleep(2000);
      } catch (partialError) {
        logger.error(
          "Partial failed for " + symbol + ": " + partialError.message,
        );
        journal.error("PARTIAL:" + symbol, partialError.message);
        await alerts.systemAlert(
          "ETORO_PARTIAL",
          "Partial exit FAILED for " +
            symbol +
            " (" +
            partialError.message +
            "). It will retry on the next 1-minute tick; if this alert " +
            "repeats, close manually in the eToro app.",
        );
      }
      continue;
    }

    // ── EXIT: full close + all accounting ──
    if (decision.action === "EXIT") {
      try {
        await etoroClient.closeExistingPosition(
          position.positionId,
          position.instrumentId,
          symbol,
        );

        // v8: the WHOLE trade — partials banked earlier plus this final
        // leg — is what the daily tracker, the loss cooldown, trade history
        // and Telegram judge. The ledger gets only the final leg, because
        // each partial was booked to it when it filled.
        const heldMinutes = Math.round(
          (Date.now() - (positionMeta.openedAt || Date.now())) / 60000,
        );
        const closedTrade = performance.buildClosedTradeRecord({
          symbol,
          positionMeta,
          livePosition: position,
          exitReason: decision.reason,
          heldMinutes,
        });
        const pnlDollars = closedTrade.pnlDollars;
        const pnlPercent = closedTrade.pnlPercent;
        riskManager.recordClosedTradeResult(pnlDollars); // daily loss limit
        capitalManager.recordRealizedPnl(closedTrade.finalLegPnlDollars); // compounding + de-risk
        // v6: loss-aware cooldown + re-entry justification (whipsaw guard)
        cooldownTracker.startCooldown(symbol, {
          wasLoss: pnlDollars < 0,
          scoreAtExit:
            (positionMeta.plan && positionMeta.plan.score) ??
            (positionMeta.entryConditions &&
              positionMeta.entryConditions.score) ??
            null,
        });
        performance.recordTrade(closedTrade);
        journal.tradeClosed({
          symbol,
          tradeType: positionMeta.tradeType || "DAY",
          source: positionMeta.source || "WATCHLIST",
          exitReason: decision.reason,
          pnlDollars,
          pnlPercent: Number(pnlPercent.toFixed(2)),
          partialPnlDollars: closedTrade.partialPnlDollars,
          mfePercent: closedTrade.mfePercent,
          maePercent: closedTrade.maePercent,
          givebackFromPeakPercent: closedTrade.givebackFromPeakPercent,
          heldMinutes,
          plan: positionMeta.plan || null,
        });

        // Observation only: watch what price does after a DISCRETIONARY
        // exit — time-based cleanups AND the early profit-protection guards
        // (aged-trade harvest, breakeven ratchet). These are exactly the
        // exits where "would it have hit Target 1 if held?" is the open
        // question; the +30/60/120-min checkpoints turn that from a guess
        // into journal evidence. Hard stops and targets are NOT shadowed —
        // those exits aren't discretionary. Never re-enters, never affects
        // trading.
        if (
          decision.reason === "TIME_EXIT_STALE" ||
          decision.reason === "SWING_TIME_EXIT" ||
          decision.reason === "MFE_GIVEBACK" ||
          decision.reason === "AGED_PROFIT_PROTECT" ||
          decision.reason === "BREAKEVEN_STOP" ||
          // v7: an AI-requested close is the most discretionary exit this bot
          // makes — exactly the one where "would it have recovered?" needs to
          // be answered with evidence rather than opinion.
          decision.reason === "AI_REVIEW_CLOSE"
        ) {
          exitShadowTracker.startShadow(
            symbol,
            position.instrumentId,
            positionMeta,
            currentPrice,
            decision.reason,
          );
        }

        delete meta[symbol];
        metaChanged = true;

        logger.info(
          symbol +
            " EXIT (" +
            decision.reason +
            ") trade P&L $" +
            pnlDollars.toFixed(2) +
            (closedTrade.partialPnlDollars
              ? " (incl. $" + closedTrade.partialPnlDollars.toFixed(2) + " banked earlier)"
              : ""),
        );
        {
          const exitInfo = describeExitReason(decision.reason);
          const tightenedNote = positionMeta.tightenedByReviewerAt
            ? "\n🤖 <i>Stop was tightened earlier today by the AI daily review.</i>"
            : "";
          const extendedNote = positionMeta.extendedByReviewerAt
            ? "\n🤖 <i>This trade was extended overnight by the AI daily review.</i>"
            : "";
          // P&L shown is YOUR real dollars (copy-ratio scaled) — pnlPercent
          // is unaffected, a % return is the same in both accounts.
          const realPnlDollars = toRealDollars(pnlDollars);
          await notifications.sendTelegramMessage(
            (pnlDollars >= 0 ? "🟢" : "🔴") +
              " <b>CLOSED " +
              symbol +
              "</b> — " +
              (positionMeta.tradeType || "DAY") +
              "\n" +
              exitInfo.trigger +
              (exitInfo.detail ? ": " + exitInfo.detail : "") +
              "\nP&L: " +
              (realPnlDollars >= 0 ? "+" : "") +
              "$" +
              realPnlDollars.toFixed(2) +
              " (" +
              (pnlPercent >= 0 ? "+" : "") +
              pnlPercent.toFixed(1) +
              "%) · held " +
              heldMinutes +
              " min" +
              tightenedNote +
              extendedNote,
          );
        }
        await etoroClient.sleep(2000);
      } catch (exitError) {
        logger.error("Exit failed for " + symbol + ": " + exitError.message);
        journal.error("EXIT:" + symbol, exitError.message);
        await alerts.systemAlert(
          "ETORO_EXIT",
          "EXIT FAILED for " +
            symbol +
            " (" +
            exitError.message +
            ") — the position is still OPEN. It will retry on the next " +
            "1-minute tick; if this alert repeats, close manually in the " +
            "eToro app.",
        );
      }
    }
  }

  if (metaChanged) savePositionMeta(meta);
  // v6: return the fetched portfolio so callers (the scan cycle) can reuse
  // its totalEquity for live-capital reconciliation without a second API
  // call. undefined on the early-return paths above (flat book, or the
  // portfolio fetch itself failed) — callers must null-check.
  return portfolio;
}

// -----------------------------
// EXIT MONITOR (1-min)
// -----------------------------
async function runExitMonitorTick() {
  // v8: no longer skips while a scan or the daily review is running — both
  // hold the position lock only while touching positions, so this tick waits
  // at most a few seconds instead of losing whole minutes of stop coverage.
  if (exitCheckInProgress) return;
  if (!marketHours.shouldRunAnalysisCycle()) return;
  exitCheckInProgress = true;
  try {
    await withPositionLock("exit-tick", () => manageOpenPositions());
    // Observation-only checkpoints for prior stale exits — cheap no-op
    // unless a checkpoint is actually due. Failures here must never affect
    // real position management, so they're isolated in their own try/catch.
    try {
      await exitShadowTracker.checkPendingShadows();
    } catch (shadowError) {
      logger.warn("Exit-shadow check failed: " + shadowError.message);
    }
    // v8.2: approved stocks waiting to be bought on a dip. Isolated like the
    // shadow check — a failure here must never touch exit management.
    // v9.1: the paper book, isolated the same way — logging must never
    // touch exit management.
    try {
      await markPaperPositions();
    } catch (paperError) {
      logger.warn("Paper book marking failed: " + paperError.message);
    }
    try {
      await checkPendingDipEntries();
    } catch (dipError) {
      logger.warn("Dip-entry check failed: " + dipError.message);
      journal.error("DIP_ENTRY_CHECK", dipError.message);
      for (const order of pendingDipEntries.values()) {
        order.checkFailures = (order.checkFailures || 0) + 1;
      }
    }
    consecutiveExitMonitorFailures = 0;
  } catch (monitorError) {
    logger.error("Exit monitor error: " + monitorError.message);
    consecutiveExitMonitorFailures++;
    if (
      consecutiveExitMonitorFailures === EXIT_MONITOR_FAILURE_ALERT_THRESHOLD
    ) {
      await alerts.systemAlert(
        "EXIT_MONITOR",
        "The 1-minute exit monitor has CRASHED " +
          consecutiveExitMonitorFailures +
          " times in a row (" +
          monitorError.message +
          "). Open positions are NOT being watched between scans. Check " +
          "pm2 logs etoro-daytrade immediately.",
      );
    }
  } finally {
    exitCheckInProgress = false;
  }
}

// -----------------------------
// V6: DAILY AI POSITION REVIEW (Tier 2)
// -----------------------------
// Mon-Thu at config.reviewerHourET:reviewerMinuteET ET — ~45 min before the
// EOD close routine. Each open position gets one AI call; the chosen action
// is applied deterministically by applyReviewDecision. Friday has no review
// (everything force-closes regardless — first-month rule).
async function runDailyPositionReview() {
  if (!config.reviewerEnabled) return;
  if (reviewInProgress) return;
  reviewInProgress = true;

  try {
    const meta = loadPositionMeta();
    const trackedSymbols = Object.keys(meta);
    if (!trackedSymbols.length) {
      logger.info("🔎 Daily review: no open positions — nothing to review");
      return;
    }

    logger.info(
      "🔎 Daily position review starting (" +
        trackedSymbols.length +
        " open position(s))",
    );

    let portfolio;
    try {
      const raw = await etoroClient.fetchRawPortfolio();
      portfolio = etoroClient.parsePortfolioFromRawData(raw);
      await etoroClient.labelPositionsWithTickers(portfolio);
    } catch (portfolioError) {
      await alerts.systemAlert(
        "ETORO_PORTFOLIO",
        "Daily position review could not fetch the portfolio (" +
          portfolioError.message +
          ") — review skipped today. DAY positions will close at EOD as " +
          "planned (the safe default).",
      );
      return;
    }

    // Market context for the reviewer prompt (previous scan's values are
    // fine — this is context, not a gate)
    const marketContext = {
      spyChangePercent: lastKnownSpyChangePercent,
      regime: lastKnownRegime,
      // v7: reuse the most recent scan's brief. It is minutes-to-an-hour old
      // at review time, which is fine — this is context for a hold/trim
      // judgement, not a gate, and the alternative (no macro picture at all)
      // is strictly worse.
      brief: lastKnownBrief,
      briefText: lastKnownBriefText,
    };
    const easternWeekdayName = getEasternWeekdayName();
    const reviewSummaryLines = [];
    // v8: verdicts are collected here and applied afterwards to a FRESH copy
    // of the meta under the position lock. The AI calls take minutes; saving
    // this early snapshot back afterwards could erase positions opened, or
    // resurrect positions closed, in the meantime.
    const pendingReviews = [];

    for (const position of portfolio.openPositions || []) {
      const symbol = (position.symbol || "").toUpperCase();
      const positionMeta = meta[symbol];
      if (!positionMeta) continue; // not this bot's position

      // v8: eToro's real fill price, as manageOpenPositions uses — not the
      // bot's recorded entry, which can differ from the fill.
      const currentPrice =
        (position.openPrice || positionMeta.entryPrice) *
        (1 + (position.unrealizedProfitLossPercent || 0));
      if (!currentPrice) continue;

      const pnlPercent = (position.unrealizedProfitLossPercent || 0) * 100;
      const heldMinutes = Math.round(
        (Date.now() - (positionMeta.openedAt || Date.now())) / 60000,
      );
      const heldDescription =
        heldMinutes >= 1440
          ? (heldMinutes / 1440).toFixed(1) + " days"
          : heldMinutes + " minutes";

      // Fresh headlines add real signal if Finnhub is configured; [] if not
      const headlines = await finnhub.getRecentHeadlines(symbol, 2, 5);

      const reviewResult = await positionReviewer.reviewSinglePosition({
        symbol,
        positionMeta,
        currentPrice,
        pnlPercent,
        heldDescription,
        easternWeekdayName,
        headlines,
        marketContext,
      });

      journal.aiDecision(
        symbol,
        "REVIEW_" + reviewResult.action,
        reviewResult.confidence,
        reviewResult.reasoning,
        reviewResult.analysis,
      );

      pendingReviews.push({ symbol, reviewResult, currentPrice, pnlPercent });
    }

    await withPositionLock("daily-review-apply", async () => {
      const freshMeta = loadPositionMeta();
      let freshSwingCount = countOpenByType(freshMeta).swingCount;
      let freshMetaChanged = false;
      for (const pending of pendingReviews) {
        const freshPositionMeta = freshMeta[pending.symbol];
        if (!freshPositionMeta) {
          pending.applied = {
            applied: false,
            description: "position closed before the review could be applied",
          };
          continue;
        }
        pending.applied = await positionReviewer.applyReviewDecision(
          freshPositionMeta,
          pending.reviewResult,
          pending.currentPrice,
          freshSwingCount,
        );
        if (pending.applied.applied) {
          freshMetaChanged = true;
          if (
            pending.reviewResult.action === "EXTEND" &&
            freshPositionMeta.tradeType === "SWING"
          ) {
            freshSwingCount++; // an extension consumes a swing slot
          }
        }
      }
      if (freshMetaChanged) savePositionMeta(freshMeta);
    });

    for (const { symbol, reviewResult, pnlPercent, applied } of pendingReviews) {
      const REVIEW_ACTION_EMOJI = {
        EXTEND: "🔼",
        TIGHTEN: "🔒",
        TAKE_PARTIAL: "🎯",
        CLOSE: "🛑",
        HOLD: "⏸",
      };
      const lineEmoji = REVIEW_ACTION_EMOJI[reviewResult.action] || "⏸";
      reviewSummaryLines.push(
        lineEmoji +
          " <b>" +
          symbol +
          "</b> (" +
          (pnlPercent >= 0 ? "+" : "") +
          pnlPercent.toFixed(1) +
          "%) → " +
          reviewResult.action +
          " (conf " +
          reviewResult.confidence +
          ")\n<i>" +
          escapeHtml(reviewResult.reasoning) +
          "</i>\n" +
          escapeHtml(applied.description),
      );

      logger.info(
        "🔎 Review " +
          symbol +
          ": " +
          reviewResult.action +
          " (conf " +
          reviewResult.confidence +
          ") — " +
          applied.description,
      );
    }

    if (reviewSummaryLines.length > 0) {
      // v8.8: this lands at 22:00 Bahrain while the market still has an hour
      // to run, and used to say only "pre-close", which read as though the day
      // were over. State the clock, the time left, and the rest of the day.
      const reviewWeekday = getEasternWeekday();
      const reviewNowMinute = easternMinuteOfDay();
      const reviewCloseMoment = scheduleMoment(reviewWeekday, "marketClose");
      const untilClose = reviewCloseMoment
        ? formatMinutesUntil(reviewNowMinute, reviewCloseMoment.minute)
        : null;
      await notifications.sendTelegramMessage(
        "🔎 <b>Position review — mid-session</b>\n" +
          "<b>" +
          easternWeekdayName +
          " " +
          marketHours.describeEtClock(config.reviewerHourET, config.reviewerMinuteET) +
          "</b>\n" +
          (untilClose
            ? "<i>Trading is still open for another " +
              untilClose +
              " — this is a check-up, not the end of the day.</i>\n\n"
            : "\n") +
          reviewSummaryLines.join("\n\n") +
          "\n\n<b>Rest of today</b>\n" +
          formatSessionSchedule(reviewWeekday, reviewNowMinute).join("\n") +
          "\n\n<i>EXTEND = holds overnight as a swing · TIGHTEN = stop pulled " +
          "in · Friday still closes everything.</i>",
      );
    }
  } catch (reviewError) {
    logger.error("Daily position review failed: " + reviewError.message);
    journal.error("REVIEW", reviewError.message);
    await alerts.systemAlert(
      "POSITION_REVIEW",
      "The daily position review CRASHED (" +
        reviewError.message +
        "). No positions were extended or tightened — DAY positions will " +
        "close at EOD as planned (the safe default).",
    );
  } finally {
    reviewInProgress = false;
  }
}

// v9.2 — TELEGRAM COMMANDS (/status, /positions, /help). Read-only.
const BOT_STARTED_AT_MS = Date.now();
function agoText(ms) {
  if (!ms) return "never";
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? m + " min ago" : Math.floor(m / 60) + " h " + (m % 60) + " min ago";
}
const usd = (v) => (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);

// v9.2: today's closed paper trades, by why the live bot did not take them.
function paperSummaryLines() {
  try {
    const day = new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
    const file = path.join(__dirname, "../data/shadow-log/paper-" + day + ".jsonl");
    if (!fs.existsSync(file)) return [];
    const by = {};
    fs.readFileSync(file, "utf8").split("\n").forEach((line) => {
      if (!line.includes("PAPER_CLOSE")) return;
      try {
        const r = JSON.parse(line);
        const k = r.paperReason || "DIP_WAIT";
        const b = by[k] || (by[k] = { n: 0, wins: 0, pnl: 0 });
        const pnl = r.totalPnlDollars != null ? r.totalPnlDollars : r.pnlDollars || 0;
        b.n++; b.pnl += pnl; if (pnl > 0) b.wins++;
      } catch {}
    });
    const label = { SCORE_FLOOR: "Skipped by score", DIP_WAIT: "Skipped waiting for dip" };
    return Object.entries(by).map(([k, b]) =>
      (label[k] || k) + ": " + b.n + " closed, " + b.wins + " won, " + formatDualAmount(b.pnl),
    );
  } catch {
    return [];
  }
}

async function commandStatus() {
  const cap = capitalManager.getCapitalState();
  const meta = loadPositionMeta() || {};
  const ledger = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "../data/capital-ledger.json"), "utf8")); } catch { return {}; } })();
  const todayNy = new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  const todayPnl = (ledger.dailyPnl || {})[todayNy] || 0;
  const scanAgeMin = lastScanCompletedAtMs ? (Date.now() - lastScanCompletedAtMs) / 60000 : null;
  const open = marketHours.isRegularMarketHours();
  const healthy = !open || (scanAgeMin != null && scanAgeMin < config.scanIntervalMinutes * 3);
  return (
    (healthy ? "🟢" : "🔴") + " <b>Bot status</b> — " + (healthy ? "running" : "scans have stopped") + "\n" +
    "Now: " + marketHours.localClock(new Date()) + " · market " + (open ? "OPEN" : "closed") + "\n" +
    "Up since: " + agoText(BOT_STARTED_AT_MS) + " · last scan " + agoText(lastScanCompletedAtMs) + "\n\n" +
    "Open positions: " + Object.keys(meta).length + " / " + config.maxDayPositions + "\n" +
    "Waiting to buy on a dip: " + (pendingDipEntries.size ? [...pendingDipEntries.keys()].join(", ") : "none") + "\n" +
    "Paper positions (log only): " + paperPositions.size + "\n" +
    (paperSummaryLines().length ? "<i>If it had bought what it skipped today:</i>\n" + paperSummaryLines().map((l) => "  " + l).join("\n") + "\n" : "") +
    "\n" +
    "Today P&L: " + formatDualAmount(todayPnl) + "\n" +
    "Capital: $" + Number(cap.effectiveCapital).toFixed(2) + (ledger.peakEffectiveCapital ? " · peak $" + Number(ledger.peakEffectiveCapital).toFixed(2) : "") + "\n" +
    "Mode: " + (process.env.TRADING_MODE || "?") + " · AI " + config.aiModel + "\n\n" +
    "<i>/positions for what it holds · /help</i>"
  );
}

async function commandPositions() {
  const meta = loadPositionMeta() || {};
  const symbols = Object.keys(meta);
  if (!symbols.length) return "📭 <b>No open positions.</b>\n" + (pendingDipEntries.size ? "Waiting to buy on a dip: " + [...pendingDipEntries.keys()].join(", ") : "");
  let live = {};
  try {
    const portfolio = etoroClient.parsePortfolioFromRawData(await etoroClient.fetchRawPortfolio());
    await etoroClient.labelPositionsWithTickers(portfolio);
    (portfolio.openPositions || []).forEach((p) => (live[String(p.symbol).toUpperCase()] = p));
  } catch (e) {
    logger.warn("/positions portfolio fetch failed: " + e.message);
  }
  const lines = symbols.map((symbol) => {
    const m = meta[symbol];
    const p = live[symbol];
    const price = p ? (p.openPrice || m.entryPrice) * (1 + (p.unrealizedProfitLossPercent || 0)) : null;
    let st = null;
    try { if (price) st = riskManager.describePositionState(m, price); } catch {}
    return (
      "<b>" + symbol + "</b> " + (m.tradeType || "DAY") + (p ? " · " + usd(toRealDollars(p.unrealizedProfitLoss)) + " (" + ((p.unrealizedProfitLossPercent || 0) * 100).toFixed(2) + "%)" : "") + "\n" +
      "  bought $" + Number(m.entryPrice).toFixed(2) + (price ? " → now $" + price.toFixed(2) : "") + " · held " + agoText(m.openedAt).replace(" ago", "") + "\n" +
      (st ? "  " + st.state + " · stop $" + Number(st.stopPrice).toFixed(2) + " (" + humanize(String(st.stopKind || "")) + ")\n  sells if: " + (st.exitConditions || []).slice(0, 2).join(" · ") : "  (live price unavailable)")
    );
  });
  return "📊 <b>Open positions (" + symbols.length + ")</b>\n\n" + lines.join("\n\n");
}

// ── v10 Telegram screens: /today, /perf, /shadow ─────────────────────────
const V9_START = "2026-10-12"; // the frozen evaluation started with v9
const real = (v) => formatDualAmount(v, { signed: true });
const pct = (v) => (v >= 0 ? "+" : "") + Number(v).toFixed(1) + "%";

function readJsonLines(file, mustInclude) {
  try {
    return fs.readFileSync(file, "utf8").split("\n")
      .filter((l) => l && (!mustInclude || mustInclude.some((m) => l.includes(m))))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function tradeStats(list) {
  const n = list.length;
  const sum = list.reduce((a, t) => a + t.pnlDollars, 0);
  const wins = list.filter((t) => t.pnlDollars > 0);
  const losses = list.filter((t) => t.pnlDollars <= 0);
  return {
    n, sum,
    per: n ? sum / n : 0,
    win: n ? Math.round((100 * wins.length) / n) : 0,
    avgWin: wins.length ? wins.reduce((a, t) => a + t.pnlDollars, 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((a, t) => a + t.pnlDollars, 0) / losses.length : 0,
  };
}

async function commandToday() {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  const ev = readJsonLines(path.join(__dirname, "../data/journal/decisions-" + day + ".jsonl"), [
    '"TRADE_OPENED"', '"TRADE_CLOSED"', '"DIP_ENTRY"', '"AI_DECISION"', '"PLAN_BUILT"', '"SCAN_START"',
  ]);
  const opened = ev.filter((e) => e.event === "TRADE_OPENED");
  const closed = ev.filter((e) => e.event === "TRADE_CLOSED");
  const dips = ev.filter((e) => e.event === "DIP_ENTRY");
  const ai = ev.filter((e) => e.event === "AI_DECISION");
  const takes = ai.filter((a) => a.decision === "TAKE");
  const closedSum = closed.reduce((a, t) => a + (t.pnlDollars || 0), 0);
  const lines = ["📅 <b>Today</b> — " + new Date().toLocaleDateString("en-GB", { timeZone: TIMEZONE, weekday: "short", day: "numeric", month: "short" }), ""];
  lines.push("<b>Real trades</b>");
  if (!opened.length && !closed.length) lines.push("  none yet");
  opened.forEach((e) => lines.push("  🟢 bought " + escapeHtml((e.plan && e.plan.symbol) || "?") + " $" + Number((e.plan && e.plan.entryPrice) || 0).toFixed(2)));
  closed.forEach((e) => lines.push("  " + (e.pnlDollars > 0 ? "✅" : "🔻") + " sold " + escapeHtml(e.symbol) + " " + real(e.pnlDollars || 0) + " · " + describeExitReason(String(e.exitReason || "")).trigger));
  if (closed.length) lines.push("  <i>closed today: " + real(closedSum) + "</i>");
  lines.push("");
  lines.push("<b>Pipeline</b>");
  lines.push("  scans " + ev.filter((e) => e.event === "SCAN_START").length + " · plans " + ev.filter((e) => e.event === "PLAN_BUILT").length +
    " · AI approved " + takes.length + " of " + ai.length);
  const st = (k) => dips.filter((d) => d.status === k).length;
  lines.push("  dip orders: " + st("ARMED") + " placed · " + st("FILLED") + " bought · " + st("EXPIRED") + " expired" +
    (pendingDipEntries.size ? " · waiting now: " + [...pendingDipEntries.keys()].join(", ") : ""));
  if (takes.length) lines.push("  approved: " + [...new Set(takes.map((t) => t.symbol))].join(", "));
  const paper = paperSummaryLines();
  if (paper.length) {
    lines.push("");
    lines.push("<b>If it had bought what it skipped</b> <i>(paper)</i>");
    paper.forEach((l) => lines.push("  " + l));
  }
  return lines.join("\n");
}

async function commandPerf() {
  let hist = [];
  try {
    hist = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/trade-history.json"), "utf8"))
      .filter((t) => typeof t.pnlDollars === "number" && t.closedAt);
  } catch {}
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const row = (label, list) => {
    const x = tradeStats(list);
    return "<b>" + label + "</b>: " + x.n + " trades · " + real(x.sum) + (x.n ? " · " + x.win + "% won · avg win " + real(x.avgWin) + " / loss " + real(x.avgLoss) : "");
  };
  const v9 = hist.filter((t) => t.closedAt >= V9_START);
  const mix = {};
  v9.forEach((t) => { const k = t.exitReason || "?"; const b = mix[k] || (mix[k] = { n: 0, p: 0 }); b.n++; b.p += t.pnlDollars; });
  const cap = capitalManager.getCapitalState();
  let peak = null;
  try { peak = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/capital-ledger.json"), "utf8")).peakEffectiveCapital; } catch {}
  const eff = Number(cap.effectiveCapital);
  const lines = ["📈 <b>Performance</b> <i>(your real dollars)</i>", ""];
  lines.push(row("Last 7 days", hist.filter((t) => t.closedAt >= weekAgo)));
  lines.push(row("Since " + V9_START + " (current rules)", v9));
  lines.push(row("All time", hist));
  if (Object.keys(mix).length) {
    lines.push("");
    lines.push("<b>How trades ended</b> (current rules)");
    Object.entries(mix).sort((a, b) => b[1].n - a[1].n).forEach(([k, b]) => lines.push("  " + describeExitReason(k).trigger + ": " + b.n + " · " + real(b.p)));
  }
  if (peak) {
    const dd = (1 - eff / peak) * 100;
    const breaker = peak * (1 - config.maxDrawdownFromPeakPct);
    lines.push("");
    lines.push("<b>Risk</b>");
    lines.push("  capital " + real(eff).replace(/^\+/, "") + " · peak " + real(peak).replace(/^\+/, "") + " · down " + dd.toFixed(1) + "% from peak");
    lines.push("  safety stop at " + (config.maxDrawdownFromPeakPct * 100).toFixed(0) + "% down — room left " + real(Math.max(0, eff - breaker)).replace(/^\+/, ""));
  }
  lines.push("");
  lines.push("<i>Evaluation target: ~110 trades on the current rules (" + v9.length + " so far).</i>");
  return lines.join("\n");
}

function paperTotalsAllTime() {
  const dir = path.join(__dirname, "../data/shadow-log");
  const by = {};
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.startsWith("paper-"))) {
      for (const r of readJsonLines(path.join(dir, f), ['"PAPER_CLOSE"'])) {
        const k = r.paperReason || "DIP_WAIT";
        const b = by[k] || (by[k] = { n: 0, wins: 0, pnl: 0 });
        const v = r.totalPnlDollars != null ? r.totalPnlDollars : r.pnlDollars || 0;
        b.n++; b.pnl += v; if (v > 0) b.wins++;
      }
    }
  } catch {}
  return by;
}

async function commandShadow() {
  const dir = path.join(__dirname, "../data/shadow-strategies");
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  const lastRun = readJson(path.join(dir, "last-run.json"));
  const backtest = readJson(path.join(dir, "_backtest", "last-run.json"));
  let strategies = {};
  try { strategies = require("./shadow-strategies").STRATEGIES; } catch {}
  const lines = ["🧪 <b>Shadow strategies</b> <i>(paper only — own books, no real money)</i>"];
  lines.push(lastRun
    ? "<i>updated " + marketHours.localClock(new Date(lastRun.at)) + " · up to the " + lastRun.latestCompleteSession + " close</i>"
    : "<i>not run yet — it runs each morning after the price capture</i>");
  for (const name of ["SWING_BREAKOUT", "DIP_IN_UPTREND", "EARNINGS_DRIFT", "ROTATION"]) {
    const st = readJson(path.join(dir, name, "state.json"));
    const meta = strategies[name] || { label: name, emoji: "•" };
    lines.push("");
    lines.push(meta.emoji + " <b>" + meta.label + "</b>" + (meta.idea ? " — <i>" + escapeHtml(meta.idea) + "</i>" : ""));
    if (!st) { lines.push("  no data yet"); continue; }
    const closed = st.closed || [];
    const realized = closed.reduce((a, t) => a + t.pnl, 0);
    const wins = closed.filter((t) => t.pnl > 0).length;
    const mark = (st.marks || [])[(st.marks || []).length - 1];
    lines.push("  closed " + closed.length + (closed.length ? " · " + wins + " won · " + real(realized) + " (" + real(realized / closed.length) + "/trade)" : ""));
    const open = Object.values(st.open || {});
    if (open.length) lines.push("  open " + open.length + ": " + open.map((o) => o.symbol).join(", ") + (mark ? " · open P&L " + real(mark.unrealized) : ""));
    if ((st.pending || []).length) lines.push("  buying at next open: " + st.pending.map((x) => x.symbol).join(", "));
    const bt = backtest && backtest.books && backtest.books[name];
    if (bt && bt.closed) lines.push("  <i>history check (Jul 14–Oct 21): " + bt.closed + " trades · " + real(bt.realized + (bt.unrealized || 0)) + "</i>");
  }
  const paper = paperTotalsAllTime();
  const live = tradeStats((() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, "../data/trade-history.json"), "utf8"))
        .filter((t) => typeof t.pnlDollars === "number" && t.closedAt >= V9_START);
    } catch { return []; }
  })());
  lines.push("");
  lines.push("<b>Compared with</b>");
  lines.push("  🤖 live bot (since " + V9_START + "): " + live.n + " trades · " + real(live.sum) + (live.n ? " (" + real(live.per) + "/trade)" : ""));
  const label = { SCORE_FLOOR: "skipped by score", DIP_WAIT: "skipped waiting for dip" };
  Object.entries(paper).forEach(([k, b]) =>
    lines.push("  📝 paper, " + (label[k] || k) + ": " + b.n + " · " + b.wins + " won · " + real(b.pnl) + " (" + real(b.pnl / b.n) + "/trade)"));
  return lines.join("\n");
}

function commandHelp() {
  return [
    "🤖 <b>Commands</b> — tap a button below, or type:",
    "",
    "/status — is the bot working? health, P&L, capital",
    "/positions — what it holds now, live P&L, when it will sell",
    "/today — today's trades, dip orders, AI calls, skipped stocks",
    "/perf — results: last 7 days, current rules, all time, risk",
    "/shadow — the 4 shadow strategies vs the live bot",
    "/help — this list",
    "",
    "<i>Read-only: no command can buy or sell.</i>",
  ].join("\n");
}

// v8.8 — THE DAY'S SUMMARY, SENT WHEN THE MARKET ACTUALLY CLOSES.
// Set by the force-close job at 15:45 ET so this message can say what it did.
let lastEodCloseMode = null;

async function sendEndOfDaySummary() {
  try {
    const weekday = getEasternWeekday();
    const mode = lastEodCloseMode || (weekday === 5 && config.fridayCloseAll ? "ALL" : "DAY_ONLY");
    lastEodCloseMode = null;
    const stats = performance.computeStats();
    journal.eodSummary({ mode, stats, dipEntry: { ...dipEntryDayStats } });

    const todayNy = new Date().toLocaleDateString("en-US", { timeZone: TIMEZONE });
    const dipDayLine = !config.dipEntryEnabled
      ? ""
      : dipEntryDayStats.day === todayNy
        ? "\n\n📉 Dip orders today: " +
          dipEntryDayStats.armed +
          " approved · " +
          dipEntryDayStats.bought +
          " bought on a dip · " +
          dipEntryDayStats.notBought +
          " not bought"
        : "\n\n📉 Dip orders today: none";

    const stillOpen = Object.keys(loadPositionMeta() || {}).length;
    // One source for the force-close time: the same timetable the message prints.
    const forceCloseMoment = scheduleMoment(weekday, "forceClose");
    const forceCloseText = forceCloseMoment
      ? marketHours.describeEtClock(
          Math.floor(forceCloseMoment.minute / 60),
          forceCloseMoment.minute % 60,
        )
      : "the scheduled close";
    const closeAction =
      mode === "ALL"
        ? "Everything was closed at " + forceCloseText + " (Friday — no weekend exposure)."
        : "Day trades were closed at " +
          forceCloseText +
          (stillOpen
            ? ", and " +
              stillOpen +
              (stillOpen === 1 ? " winner is" : " winners are") +
              " being held overnight."
            : ".");

    await notifications.sendTelegramMessage(
      "🔔 <b>Market closed</b> — " +
        marketHours.describeEtClock(16, 0) +
        "\n" +
        "<i>" +
        closeAction +
        "</i>\n\n" +
        performance.formatStatsForTelegram(stats) +
        (paperSummaryLines().length
          ? "\n\n🧪 <b>If it had bought what it skipped today</b> (paper, log only)\n" +
            paperSummaryLines().join("\n")
          : "") +
        dipDayLine +
        "\n\n<b>Today's timetable</b>\n" +
        formatSessionSchedule(weekday, 16 * 60).join("\n"),
    );
  } catch (summaryError) {
    logger.warn("End-of-day summary failed: " + summaryError.message);
  }
}

// -----------------------------
// SCHEDULER
// -----------------------------
function startScheduler() {
  new CronJob(
    "*/" + config.scanIntervalMinutes + " * * * 1-5",
    runScanCycle,
    null,
    true,
    TIMEZONE,
  );

  new CronJob("* * * * 1-5", runExitMonitorTick, null, true, TIMEZONE);

  // v8.8: the day's wrap-up at the REAL 16:00 ET close (23:00 Bahrain, and
  // 00:00 Bahrain once US daylight saving ends), not 15 minutes before it.
  new CronJob("0 16 * * 1-5", sendEndOfDaySummary, null, true, TIMEZONE);

  // V6: daily position review — Mon-Thu ONLY (Friday closes everything
  // anyway, so extending on Friday would be meaningless).
  new CronJob(
    config.reviewerMinuteET + " " + config.reviewerHourET + " * * 1-4",
    runDailyPositionReview,
    null,
    true,
    TIMEZONE,
  );

  // EOD force-close: Mon-Thu → DAY positions only (swings hold overnight).
  // Friday → EVERYTHING (first-month rule: zero weekend exposure).
  const closeMinuteRaw = 60 - config.forceCloseMinutesBeforeClose;
  const forceCloseHour = closeMinuteRaw >= 60 ? 16 : 15;
  const forceCloseMinute =
    closeMinuteRaw >= 60 ? closeMinuteRaw - 60 : closeMinuteRaw;

  new CronJob(
    forceCloseMinute + " " + forceCloseHour + " * * 1-5",
    async () => {
      const weekday = getEasternWeekday();
      // Friday → close ALL (weekend safety). Mon–Thu in 24/5 overnight-hold
      // mode → keep winning DAY positions overnight. Otherwise → close all
      // DAY positions (swings hold).
      let mode;
      if (weekday === 5 && config.fridayCloseAll) {
        mode = "ALL";
      } else if (config.trade24_5 && config.hold24_5Overnight) {
        mode = "DAY_KEEP_WINNERS";
      } else {
        mode = "DAY_ONLY";
      }
      // v8: under the position lock — this cron used to load and save the
      // meta file with nothing stopping an exit tick or a scan doing the same.
      await withPositionLock("eod-close", () =>
        eodCloser.forceCloseAllPositions(
          etoroClient,
          notifications,
          riskManager,
          performance,
          loadPositionMeta,
          savePositionMeta,
          mode,
          {
            // v8: finalLegPnl is new cash for the ledger; closedTrade is the
            // whole trade (partials included) for cooldown and the journal.
            onClosed: (symbol, finalLegPnl, positionMeta, exitReason, closedTrade) => {
              capitalManager.recordRealizedPnl(finalLegPnl);
              const tradePnl = closedTrade ? closedTrade.pnlDollars : finalLegPnl;
              // v6: loss-aware cooldown + re-entry justification
              cooldownTracker.startCooldown(symbol, {
                wasLoss: tradePnl < 0,
                scoreAtExit:
                  (positionMeta.plan && positionMeta.plan.score) ??
                  (positionMeta.entryConditions &&
                    positionMeta.entryConditions.score) ??
                  null,
              });
              journal.tradeClosed({
                symbol,
                tradeType: positionMeta.tradeType || "DAY",
                source: positionMeta.source || "WATCHLIST",
                exitReason,
                pnlDollars: Number(tradePnl.toFixed(2)),
                partialPnlDollars: closedTrade ? closedTrade.partialPnlDollars : 0,
                plan: positionMeta.plan || null,
              });
            },
          },
        ),
      );

      // v8.8: the day's summary is no longer sent from here. This job runs
      // forceCloseMinutesBeforeClose EARLY (15:45 ET = 22:45 Bahrain) so the
      // exits get filled before the bell, which meant the operator's last
      // message of the day arrived while the market was still open. The
      // summary now goes out at the real 16:00 ET close; this just records
      // which mode ran so that message can say so.
      lastEodCloseMode = mode;
      try {
        await markPaperPositions(mode); // v9.2: same end-of-day rule, paper book
      } catch (paperError) {
        logger.warn("Paper end-of-day close failed: " + paperError.message);
      }
    },
    null,
    true,
    TIMEZONE,
  );

  // Friday weekly self-evaluation, 5 minutes after the close routine.
  const selfEvalMinuteRaw = forceCloseMinute + 5;
  const selfEvalHour =
    selfEvalMinuteRaw >= 60 ? forceCloseHour + 1 : forceCloseHour;
  const selfEvalMinute =
    selfEvalMinuteRaw >= 60 ? selfEvalMinuteRaw - 60 : selfEvalMinuteRaw;
  new CronJob(
    selfEvalMinute + " " + selfEvalHour + " * * 5",
    async () => {
      try {
        const report = selfEvaluation.generateSelfEvaluation();
        await notifications.sendTelegramMessage(
          selfEvaluation.formatSelfEvaluationForTelegram(report),
        );
        logger.info(
          "Weekly self-evaluation sent (" +
            (report.totalTrades || 0) +
            " trades analyzed)",
        );
      } catch (evalError) {
        logger.warn("Self-evaluation failed: " + evalError.message);
      }
    },
    null,
    true,
    TIMEZONE,
  );

  // v7.10: schedules are ANCHORED to ET (they follow the US session) but
  // are printed in the operator's clock, computed live so they shift with
  // US daylight saving on their own. Bahrain has no DST, so a hardcoded
  // local figure here would be wrong for roughly half the year.
  const zoneLabel = marketHours.getLogTimeZoneLabel();
  logger.info(
    "Scheduler: scans every " +
      config.scanIntervalMinutes +
      " min (adaptive slow-down in CHOP) · 1-min exit monitor · daily " +
      "position review Mon-Thu " +
      marketHours.easternClockToLogZone(
        config.reviewerHourET,
        config.reviewerMinuteET,
      ) +
      " " +
      zoneLabel +
      " · EOD close Mon-Thu (DAY) / Fri (ALL) at " +
      marketHours.easternClockToLogZone(forceCloseHour, forceCloseMinute) +
      " " +
      zoneLabel +
      " · Friday self-evaluation",
  );
}

// -----------------------------
async function main() {
  logger.info("╔════════════════════════════════════════════════╗");
  logger.info("║  eToro Day + Swing Bot v5                       ║");
  logger.info("║  planner · discovery · reviewer · alerts        ║");
  logger.info("╚════════════════════════════════════════════════╝");

  notifications.initialiseTelegramBot();

  const startupWatchlist = loadWatchlist();
  if (startupWatchlist.length === 0) {
    logger.error(
      "⚠️  watchlist-daytrade.json MISSING/empty — discovery can still find " +
        "trades, but the watchlist pipeline is dead. Fix the file.",
    );
    await notifications.sendTelegramMessage(
      "⚠️ <b>Bot started WITHOUT a watchlist</b> — running on discovery only. " +
        "Add watchlist-daytrade.json next to package.json and restart.",
    );
  } else {
    logger.info(
      "Watchlist: " +
        startupWatchlist.length +
        " symbols · Discovery: " +
        (config.discoveryEnabled ? "ON (Yahoo screeners)" : "OFF"),
    );
  }

  // v5: report optional integrations honestly at startup
  // v5.3: optional Alpaca WebSocket stream — no-op if not configured
  marketDataStream.start();

  // v9.1: a restart must not truncate the paper comparison.
  try {
    const saved = journal.readPaperState();
    Object.entries(saved || {}).forEach(([symbol, meta]) => paperPositions.set(symbol, meta));
    if (paperPositions.size) {
      logger.info("Paper book restored: " + [...paperPositions.keys()].join(", ") + " (log only)");
    }
  } catch (restoreError) {
    logger.warn("Paper book restore failed: " + restoreError.message);
  }

  // v8.8: the session clock, in both zones, so the log answers "when does
  // anything happen" without arithmetic. Recomputed on every boot, so it
  // follows US daylight saving on its own.
  logger.info(
    "Session clock (" + marketHours.getLogTimeZoneLabel() + " operator time):",
  );
  formatSessionSchedule(getEasternWeekday(), -1).forEach((line) =>
    logger.info("   " + line.replace(/^[•✅] /, "")),
  );

  // v8.7: say which Claude model is deciding, and whether it is thinking.
  logger.info(
    "AI model: " + config.aiModel +
      " · thinking " + (config.aiThinking ? "ON (billed against max_tokens)" : "off") +
      " · screener/reviewer token caps " + config.screenerMaxTokens + "/" + config.reviewerMaxTokens +
      " (DT_AI_MODEL, DT_AI_THINKING)",
  );

  if (finnhub.isConfigured()) {
    logger.info(
      "Finnhub: CONFIGURED — earnings blackout, dynamic sector buckets, and " +
        "reviewer headlines are ACTIVE",
    );
  } else {
    logger.warn(
      "Finnhub: NOT configured (FINNHUB_API_KEY missing). Bot works, but " +
        "WITHOUT: earnings blackout, dynamic sector buckets for discovered " +
        "tickers, reviewer headlines. Free key: https://finnhub.io",
    );
  }

  if (etoroMarketData.isConfigured()) {
    logger.info(
      "eToro market-data: CONFIGURED (primary quote source) — batched " +
        "rates + real-volume candles on your existing trading credentials. " +
        "Alpaca/Twelve Data are now pure fallbacks.",
    );
  } else {
    logger.warn(
      "eToro market-data: NOT configured (ETORO_PUBLIC_API_KEY/" +
        "ETORO_AGENT_USER_KEY missing) — falling back to Alpaca/Twelve Data.",
    );
  }

  if (marketDataStream.isConfigured()) {
    logger.info(
      "Alpaca stream: CONFIGURED — watchlist quotes will be near-instant " +
        "once the stream warms up (no more 8s/symbol sequential wait)",
    );
  } else {
    logger.warn(
      "Alpaca stream: NOT configured (ALPACA_API_KEY_ID/ALPACA_SECRET_KEY " +
        "missing). Falling back to sequential Twelve Data polling — free " +
        "key: https://app.alpaca.markets/signup",
    );
  }
  if (capitalManager.isHalted()) {
    logger.warn(
      "🛑 halt.flag exists — new entries are BLOCKED until you delete " +
        "data/halt.flag",
    );
    await notifications.sendTelegramMessage(
      "🛑 <b>Bot started with halt.flag present</b> — no new entries until you " +
        "delete data/halt.flag on the server. Exits and EOD closes run " +
        "normally.",
    );
  }

  const capitalState = capitalManager.getCapitalState();
  logger.info(
    "Capital: $" +
      capitalState.effectiveCapital +
      " effective (peak $" +
      capitalState.peakEffectiveCapital +
      ") · Risk/trade: " +
      config.riskPctDay * 100 +
      "% day / " +
      config.riskPctSwing * 100 +
      "% swing · Slots: " +
      config.maxDayPositions +
      " day + " +
      config.maxSwingPositions +
      " swing · Drawdown breaker: " +
      config.maxDrawdownFromPeakPct * 100 +
      "% from peak · Friday closes ALL: " +
      config.fridayCloseAll,
  );
  logger.info(
    config.dipEntryEnabled
      ? "🎯 Dip entry ON: approved stocks are bought only on a dip of " +
          config.dipEntryDepthOfStop +
          "× the stop distance within " +
          config.dipEntryWindowMinutes +
          " min" +
          (config.dipEntryTrailFromHigh
            ? ", measured from the highest price seen while waiting but never above the approval price (v8.6)"
            : ", measured from the approval price") +
          " (DT_DIP_ENTRY_ENABLED=false buys immediately)"
      : "Dip entry OFF: approved stocks are bought immediately",
  );

  startScheduler();
  // v9.2: answer /status and /positions from the owner's phone.
  notifications.startCommandListener([
    { command: "/status", description: "Is the bot working? Health, P&L, capital", handler: commandStatus, button: "🟢 Status" },
    { command: "/positions", aliases: ["/held"], description: "What it holds now, live P&L, when it sells", handler: commandPositions, button: "📂 Positions" },
    { command: "/today", description: "Today: trades, dip orders, AI calls, skipped stocks", handler: commandToday, button: "📅 Today" },
    { command: "/perf", aliases: ["/performance"], description: "Results: last 7 days, current rules, all time, risk", handler: commandPerf, button: "📈 Performance" },
    { command: "/shadow", aliases: ["/strategies"], description: "The 4 shadow strategies vs the live bot", handler: commandShadow, button: "🧪 Shadow books" },
    { command: "/help", aliases: ["/start"], description: "List of commands", handler: commandHelp, button: "❓ Help" },
  ]);

  // v6: real-time exit watchdog. A live tick crossing a held position's own
  // stop/floor triggers an IMMEDIATE off-cycle exit check instead of waiting
  // up to 60s for the next 1-minute tick. Guarded against overlapping with
  // an already-running exit check/scan — it just runs the SAME
  // manageOpenPositions() path a normal tick would, so risk-manager's
  // whipsaw confirmation still applies identically.
  priceStream.start(async (symbol, estimatedMidPrice) => {
    // v8: waits for the position lock rather than skipping during a scan.
    if (exitCheckInProgress) return;
    logger.warn(
      "Emergency position check (price stream): " +
        symbol +
        " estimated mid $" +
        estimatedMidPrice.toFixed(4),
    );
    exitCheckInProgress = true;
    try {
      await withPositionLock("price-stream", () => manageOpenPositions());
      consecutiveExitMonitorFailures = 0;
    } catch (emergencyError) {
      logger.error(
        "Emergency exit check failed: " + emergencyError.message,
      );
    } finally {
      exitCheckInProgress = false;
    }
  });

  // v8.2: pm2 stop/restart sends SIGINT (SIGTERM on some setups). Waiting dip
  // orders live in memory, so record how each one ended before the process
  // goes — otherwise the review would find ARMED orders with no outcome.
  // The journal write is synchronous, so it lands before exit.
  const recordPendingDipOrdersAndExit = (signal) => {
    for (const order of [...pendingDipEntries.values()]) {
      finishDipEntry(order, "CANCELLED", "bot stopped or restarted (" + signal + ")");
    }
    process.exit(0);
  };
  process.once("SIGINT", () => recordPendingDipOrdersAndExit("SIGINT"));
  process.once("SIGTERM", () => recordPendingDipOrdersAndExit("SIGTERM"));

  if (process.env.DT_RUN_ON_STARTUP !== "false") {
    runScanCycle();
  }

  logger.info("Running (" + marketHours.getCurrentBahrainTime() + " Bahrain)");
}

// v10: `node src/index.js --render /perf` prints one Telegram screen and exits
// WITHOUT starting the bot (no schedulers, no Telegram polling, no orders), so
// a screen can be checked against live data before a deploy.
if (process.argv[2] === "--render") {
  const screens = { "/status": commandStatus, "/today": commandToday, "/perf": commandPerf, "/shadow": commandShadow, "/help": commandHelp };
  const fn = screens[process.argv[3]];
  Promise.resolve(fn ? fn() : "unknown screen; one of " + Object.keys(screens).join(" "))
    .then((out) => { console.log(String(out).replace(/<[^>]+>/g, "")); process.exit(0); })
    .catch((e) => { console.error(e.stack || e); process.exit(1); });
} else {
  main();
}
