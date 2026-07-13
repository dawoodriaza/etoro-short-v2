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
const notifications = require("./notifications/telegram");
const alerts = require("./notifications/alerts");
const finnhub = require("./data-sources/finnhub");

const tradePlanner = require("./strategies/trade-planner");
const marketDiscovery = require("./discovery/market-discovery");
const capitalManager = require("./strategies/capital-manager");
const journal = require("./strategies/decision-journal");
const ethicsFilter = require("./strategies/ethics-filter");
const exitShadowTracker = require("./strategies/exit-shadow-tracker");
const {
  escapeHtml,
  humanize,
  describeExitReason,
} = require("./notifications/format-helpers");

const TIMEZONE = "America/New_York";

let scanInProgress = false;
let exitCheckInProgress = false;
let reviewInProgress = false;

// v7: repeated exit-monitor failures must become visible — the exit monitor
// is the bot's only live protection between scans.
let consecutiveExitMonitorFailures = 0;
const EXIT_MONITOR_FAILURE_ALERT_THRESHOLD = 5; // 5 minutes of failures

// Adaptive-scan state (from the PREVIOUS scan)
let lastScanCompletedAtMs = 0;
let lastKnownRegime = "UNKNOWN";
let lastKnownSpyChangePercent = 0;

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
    journal.gateBlock(
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
    journal.gateBlock("HALT_FLAG", "data/halt.flag exists");
    return true;
  }

  return false;
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

  scanInProgress = true;
  const startTime = Date.now();

  try {
    logger.info(
      "═══ Scan start (" +
        marketHours.getCurrentBahrainTime() +
        " Bahrain) ═══",
    );
    journal.scanStart({ bahrain: marketHours.getCurrentBahrainTime() });

    // 1. Always manage open positions first — exits are never gated
    await manageOpenPositions();

    // v5.3: cheap check for a silently-dead Alpaca stream (no-op if not
    // configured) — mirrors the alerting pattern for every other data source
    marketDataStream.checkStreamHealth();

    // 2. Risk gates for NEW entries
    // V4: halt flag / drawdown breaker first — the hardest gate
    if (await isTradingHaltedForNewEntries()) {
      return;
    }

    // V3: daily loss limit sized off EFFECTIVE capital, same base as sizing
    const capitalState = capitalManager.getCapitalState();
    if (riskManager.isDailyLossLimitHit(capitalState.effectiveCapital)) {
      logger.info("Daily loss limit hit — exits only");
      journal.gateBlock("DAILY_LOSS_LIMIT", "realized losses at limit");
      return;
    }

    const sessionCheck = sessionTiming.isNewEntryAllowed();
    if (!sessionCheck.allowed) {
      logger.info("Entry blocked: " + sessionCheck.reason);
      journal.gateBlock("SESSION_TIMING", sessionCheck.reason);
      return;
    }

    // 3. SPY filter (fail-closed, alerts on failure inside market-data)
    const spyQuote = await marketData.fetchSpyQuote();
    if (!spyQuote) {
      logger.warn("SPY unavailable — blocking entries");
      journal.gateBlock("SPY_DATA", "SPY quote unavailable (fail-closed)");
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
      journal.gateBlock(
        "SPY_DIRECTION",
        "SPY " + spyChange.toFixed(2) + "% below floor",
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
      journal.gateBlock(
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

    const heldSymbols = new Set(
      (portfolio.openPositions || []).map((position) =>
        (position.symbol || "").toUpperCase(),
      ),
    );

    const toEnrich = [];
    for (const candidate of prefiltered) {
      const upperSymbol = candidate.symbol.toUpperCase();
      // Excluded industries (gambling/betting, alcohol, adult) are never
      // bought — cheap static check here saves the enrichment API spend;
      // the async industry-based check runs again in tryOpenPosition.
      if (ethicsFilter.isBlockedStatic(upperSymbol)) {
        journal.candidateRejected(
          upperSymbol,
          "ETHICS_FILTER",
          "excluded industry (gambling/alcohol/adult)",
        );
        continue;
      }
      if (heldSymbols.has(upperSymbol)) {
        journal.candidateRejected(upperSymbol, "HELD", "already holding");
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
        journal.candidateRejected(
          upperSymbol,
          "COOLDOWN",
          cooldown.minutesRemaining + " min remaining",
        );
        continue;
      }
      toEnrich.push(candidate);
    }
    if (!toEnrich.length) {
      logger.info("All movers held or cooling down");
      return;
    }

    const scoredCandidates = [];
    for (const candidate of toEnrich) {
      const enrichment = await marketData.enrichCandidate(
        candidate.symbol,
        candidate.currentPrice,
        candidate.instrumentId, // v5.4: already resolved if this came from eToro's quote path
      );
      if (enrichment) Object.assign(candidate, enrichment);

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
      if (!scored.rejected) {
        scored.atrPercent = candidate.atrPercent;
        scored.source = candidate.source || "WATCHLIST";
        scored.priceChangePercent = candidate.priceChangePercent;
        scoredCandidates.push(scored);
        journal.candidateScored(scored);
      } else {
        journal.candidateRejected(
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
    if (!scoredCandidates.length) {
      logger.info("No candidates passed scoring");
      return;
    }

    scoredCandidates.sort((a, b) => b.score - a.score);
    const topCandidates = scoredCandidates.slice(0, config.maxCandidates);

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
      } else {
        journal.planRejected(candidate.symbol, planResult.rejectReason);
        logger.info(
          candidate.symbol + " plan rejected: " + planResult.rejectReason,
        );
      }
    }
    if (!plans.length) {
      logger.info("No plans survived geometry/slots/RRR checks");
      return;
    }

    // 7. AI veto screen → open approved plans
    const marketContext = {
      regime: regime.regime,
      rangePct: regime.rangePct,
      spyChangePercent: spyChange,
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
      );
    }

    const approvedPlans = plans.filter((plan) =>
      screenResults.some(
        (result) => result.symbol === plan.symbol && result.decision === "TAKE",
      ),
    );

    for (const plan of approvedPlans) {
      const aiResult = screenResults.find(
        (result) => result.symbol === plan.symbol,
      );
      await tryOpenPosition(plan, aiResult, portfolio, capitalState);
    }

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
  }
}

// -----------------------------
// POSITION ENTRY (plan-driven)
// -----------------------------
async function tryOpenPosition(plan, aiResult, portfolio, capitalState) {
  const meta = loadPositionMeta();

  // HARD GATE: never buy gambling/betting, alcohol, or adult-industry
  // stocks — static blocklist + Finnhub industry check. This is the last
  // line of defense and covers every entry path (watchlist + discovery).
  const ethicsCheck = await ethicsFilter.isBlocked(plan.symbol);
  if (ethicsCheck.blocked) {
    logger.info(plan.symbol + " blocked: " + ethicsCheck.reason);
    journal.candidateRejected(plan.symbol, "ETHICS_FILTER", ethicsCheck.reason);
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
      journal.candidateRejected(
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
    portfolio.availableCash || 0,
    plan.positionDollars,
    plan.tradeType,
    meta,
    plan.averageDollarVolume, // v5.1: liquidity/spread floor
  );
  if (!safety.allowed) {
    logger.info(plan.symbol + " blocked: " + safety.reason);
    journal.candidateRejected(plan.symbol, "PRE_TRADE_SAFETY", safety.reason);
    return;
  }

  try {
    const instrumentId = await etoroClient.resolveTickerToInstrumentId(
      plan.symbol,
    );
    if (!instrumentId) {
      logger.warn(plan.symbol + " not resolvable on eToro — skipping");
      journal.candidateRejected(
        plan.symbol,
        "ETORO_RESOLUTION",
        "instrument not found on eToro",
      );
      return;
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
      journal.candidateRejected(
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
      partialDone: false, // day tier flag
      partialT1Done: false, // swing tier flags
      partialT2Done: false,
      // Bookkeeping
      setup: plan.setup,
      source: plan.source,
      confidence: aiResult ? aiResult.confidence : null,
      dollarAmount: actualDollarAmount, // REAL invested amount, not the plan
      plannedDollarAmount: plan.positionDollars, // kept for comparison/debugging
      openedAt: Date.now(),
      plan, // full plan echoed for the journal on close
      entryConditions: {
        tradeType: plan.tradeType, // v5.1: ORIGINAL type at entry — positionMeta.tradeType
        // mutates to SWING if the reviewer later extends it; this field lets
        // self-evaluation tell "born DAY, later extended" apart from "born SWING"
        score: plan.score,
        regime: plan.regime,
        spyChangePercent: plan.spyChangePercent,
        relativeStrength: plan.relativeStrength,
        rsi: plan.rsi,
        aboveVwap: plan.aboveVwap,
        atrPercent: plan.atrPercent,
        volatilityBucket: plan.volatilityBucket,
        entryHourET: sessionTiming.getEasternHourMinute().hour,
      },
    };
    savePositionMeta(meta);

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
  if (!Object.keys(meta).length) return; // zero-cost when flat

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

  for (const position of portfolio.openPositions || []) {
    const symbol = (position.symbol || "").toUpperCase();
    const positionMeta = meta[symbol];
    if (!positionMeta) continue; // not this bot's position

    // eToro's own P&L gives us the live price for free (no API credit)
    const currentPrice =
      positionMeta.entryPrice *
      (1 + (position.unrealizedProfitLossPercent || 0));
    if (!currentPrice) continue;

    const decision = riskManager.decidePositionAction(
      positionMeta,
      currentPrice,
    );

    if (decision.newPeak && decision.newPeak !== positionMeta.peakPrice) {
      positionMeta.peakPrice = decision.newPeak;
      metaChanged = true;
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
        await etoroClient.closePartialPosition(
          position.positionId,
          position.instrumentId,
          symbol,
          decision.fraction,
        );
        if (decision.flagOnSuccess) {
          positionMeta[decision.flagOnSuccess] = true;
        }
        if (decision.floorOnSuccess != null) {
          positionMeta.lockedFloor = decision.floorOnSuccess;
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
              : ""),
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
            "%. Rest keeps running" +
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
        const pnlDollars = position.unrealizedProfitLoss || 0;
        const pnlPercent = (position.unrealizedProfitLossPercent || 0) * 100;
        await etoroClient.closeExistingPosition(
          position.positionId,
          position.instrumentId,
          symbol,
        );

        riskManager.recordClosedTradeResult(pnlDollars); // daily loss limit
        capitalManager.recordRealizedPnl(pnlDollars); // compounding + de-risk
        cooldownTracker.startCooldown(symbol); // whipsaw guard

        const heldMinutes = Math.round(
          (Date.now() - (positionMeta.openedAt || Date.now())) / 60000,
        );
        performance.recordTrade({
          symbol,
          setup: positionMeta.setup,
          tradeType: positionMeta.tradeType || "DAY",
          source: positionMeta.source || "WATCHLIST",
          entryPrice: positionMeta.entryPrice,
          exitPrice: currentPrice,
          dollarAmount: positionMeta.dollarAmount,
          pnlDollars,
          pnlPercent,
          exitReason: decision.reason,
          confidence: positionMeta.confidence,
          openedAt: positionMeta.openedAt
            ? new Date(positionMeta.openedAt).toISOString()
            : null,
          heldMinutes,
          entryConditions: positionMeta.entryConditions || null,
          plan: positionMeta.plan || null,
          extendedByReviewer: !!positionMeta.extendedByReviewerAt, // v5.1 Tier-3
        });
        journal.tradeClosed({
          symbol,
          tradeType: positionMeta.tradeType || "DAY",
          source: positionMeta.source || "WATCHLIST",
          exitReason: decision.reason,
          pnlDollars: Number(pnlDollars.toFixed(2)),
          pnlPercent: Number(pnlPercent.toFixed(2)),
          heldMinutes,
          plan: positionMeta.plan || null,
        });

        // Observation only: watch what price does after a TIME-based exit
        // (not a stop/target) to build real evidence for whether the hold
        // window should change. Never re-enters, never affects trading.
        if (
          decision.reason === "TIME_EXIT_STALE" ||
          decision.reason === "SWING_TIME_EXIT"
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
            ") P&L $" +
            pnlDollars.toFixed(2),
        );
        {
          const exitInfo = describeExitReason(decision.reason);
          const tightenedNote = positionMeta.tightenedByReviewerAt
            ? "\n🤖 <i>Stop was tightened earlier today by the AI daily review.</i>"
            : "";
          const extendedNote = positionMeta.extendedByReviewerAt
            ? "\n🤖 <i>This trade was extended overnight by the AI daily review.</i>"
            : "";
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
              (pnlDollars >= 0 ? "+" : "") +
              "$" +
              pnlDollars.toFixed(2) +
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
}

// -----------------------------
// EXIT MONITOR (1-min)
// -----------------------------
async function runExitMonitorTick() {
  if (scanInProgress || exitCheckInProgress || reviewInProgress) return;
  if (!marketHours.shouldRunAnalysisCycle()) return;
  exitCheckInProgress = true;
  try {
    await manageOpenPositions();
    // Observation-only checkpoints for prior stale exits — cheap no-op
    // unless a checkpoint is actually due. Failures here must never affect
    // real position management, so they're isolated in their own try/catch.
    try {
      await exitShadowTracker.checkPendingShadows();
    } catch (shadowError) {
      logger.warn("Exit-shadow check failed: " + shadowError.message);
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
    };
    const easternWeekdayName = getEasternWeekdayName();
    const { swingCount } = countOpenByType(meta);
    let currentSwingCount = swingCount;

    let metaChanged = false;
    const reviewSummaryLines = [];

    for (const position of portfolio.openPositions || []) {
      const symbol = (position.symbol || "").toUpperCase();
      const positionMeta = meta[symbol];
      if (!positionMeta) continue; // not this bot's position

      const currentPrice =
        positionMeta.entryPrice *
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
      );

      const applied = await positionReviewer.applyReviewDecision(
        positionMeta,
        reviewResult,
        currentPrice,
        currentSwingCount,
      );

      if (applied.applied) {
        metaChanged = true;
        if (
          reviewResult.action === "EXTEND" &&
          positionMeta.tradeType === "SWING"
        ) {
          currentSwingCount++; // an extension consumes a swing slot
        }
      }

      const lineEmoji =
        reviewResult.action === "EXTEND"
          ? "🔼"
          : reviewResult.action === "TIGHTEN"
            ? "🔒"
            : "⏸";
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

    if (metaChanged) savePositionMeta(meta);

    if (reviewSummaryLines.length > 0) {
      await notifications.sendTelegramMessage(
        "🔎 <b>Daily Position Review</b> (" +
          easternWeekdayName +
          ", pre-close)\n\n" +
          reviewSummaryLines.join("\n\n") +
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
      await eodCloser.forceCloseAllPositions(
        etoroClient,
        notifications,
        riskManager,
        performance,
        loadPositionMeta,
        savePositionMeta,
        mode,
        {
          onClosed: (symbol, pnlDollars, positionMeta, exitReason) => {
            capitalManager.recordRealizedPnl(pnlDollars);
            cooldownTracker.startCooldown(symbol);
            journal.tradeClosed({
              symbol,
              tradeType: positionMeta.tradeType || "DAY",
              source: positionMeta.source || "WATCHLIST",
              exitReason,
              pnlDollars: Number(pnlDollars.toFixed(2)),
              plan: positionMeta.plan || null,
            });
          },
        },
      );

      // EOD performance summary
      try {
        const stats = performance.computeStats();
        journal.eodSummary({ mode, stats });
        await notifications.sendTelegramMessage(
          performance.formatStatsForTelegram(stats),
        );
      } catch (statsError) {
        logger.warn("EOD stats failed: " + statsError.message);
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

  logger.info(
    "Scheduler: scans every " +
      config.scanIntervalMinutes +
      " min (adaptive slow-down in CHOP) · 1-min exit monitor · daily " +
      "position review Mon-Thu " +
      config.reviewerHourET +
      ":" +
      String(config.reviewerMinuteET).padStart(2, "0") +
      " ET · EOD close Mon-Thu (DAY) / Fri (ALL) at " +
      forceCloseHour +
      ":" +
      String(forceCloseMinute).padStart(2, "0") +
      " ET · Friday self-evaluation",
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

  startScheduler();

  if (process.env.DT_RUN_ON_STARTUP !== "false") {
    runScanCycle();
  }

  logger.info("Running (" + marketHours.getCurrentBahrainTime() + " Bahrain)");
}

main();
