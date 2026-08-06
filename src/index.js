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
  toRealDollars,
  formatDualAmount,
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
    logger.info(
      "🌙 Overnight freeze active (" +
        String(window.startHour).padStart(2, "0") +
        ":" +
        String(window.startMinute).padStart(2, "0") +
        "-" +
        String(window.endHour).padStart(2, "0") +
        ":" +
        String(window.endMinute).padStart(2, "0") +
        " " +
        // v7.4: the FREEZE window's own clock, not the log clock. These are
        // now different — the window is anchored to ET so it tracks the
        // dead zone through DST, while logs stay on the operator's time.
        marketHours.getFreezeTimeZoneLabel() +
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

  try {
    logger.info(
      "═══ Scan start (" +
        marketHours.getCurrentBahrainTime() +
        " Bahrain) ═══",
    );
    journal.scanStart({ bahrain: marketHours.getCurrentBahrainTime() });

    // 1. Always manage open positions first — exits are never gated
    const monitoredPortfolio = await manageOpenPositions();

    // v5.3: cheap check for a silently-dead Alpaca stream (no-op if not
    // configured) — mirrors the alerting pattern for every other data source
    marketDataStream.checkStreamHealth();

    // v6: LIVE CAPITAL RECONCILIATION — before any gate/sizing reads
    // capitalState this cycle, make sure the ledger matches the REAL eToro
    // equity. Reuses manageOpenPositions's own portfolio fetch above (zero
    // extra calls) when positions are tracked; on a flat book that returns
    // nothing, so one lightweight direct fetch covers deposit/withdrawal/
    // drift reconciliation even while flat.
    try {
      const equitySourcePortfolio = monitoredPortfolio
        ? monitoredPortfolio
        : etoroClient.parsePortfolioFromRawData(
            await etoroClient.fetchRawPortfolio(),
          );
      const liveEquity = equitySourcePortfolio.totalEquity;
      // v7.3: the transfer detector needs to know whether orders are in
      // flight. Cash reserved against a queued order is the classic source
      // of a large, temporary, entirely fake equity drift — it produced a
      // $6,596.66 phantom withdrawal on 2026-07-31.
      const reconciliation = capitalManager.reconcileWithLiveEquity(
        liveEquity,
        { pendingOrderCount: equitySourcePortfolio.pendingOrderCount || 0 },
      );
      if (reconciliation.reconciled) {
        await notifications.sendTelegramMessage(
          "💰 <b>Capital reconciled</b>\nLedger vs live eToro equity had " +
            "drifted by $" +
            reconciliation.driftDollars.toFixed(2) +
            " (" +
            (reconciliation.driftPct * 100).toFixed(1) +
            "%) — corrected to match the real account. Sizing, the daily " +
            "loss limit, and the drawdown breaker all use the corrected figure now.",
        );
      }
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
      journal.gateBlock(
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
      logger.info(
        "🌑 Overnight dead zone (" +
          String(config.overnightDeadZoneStartHourET).padStart(2, "0") +
          ":00-" +
          String(config.overnightDeadZoneEndHourET).padStart(2, "0") +
          ":00 ET) — no new entries. Every audited trade in this window " +
          "lost money regardless of score. Exits remain fully active.",
      );
      journal.gateBlock(
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
          journal.candidateRejected(
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
          logger.info(
            candidate.symbol +
              " re-entry blocked: score " +
              scored.score.toFixed(0) +
              " doesn't beat the prior losing setup (" +
              justification.priorScore.toFixed(0) +
              ") by the required " +
              config.lossReentryMinScoreImprovement +
              " points",
          );
          await marketData.sleep(1500);
          continue;
        }

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
    for (const plan of approvedPlans) {
      const aiResult = screenResults.find(
        (result) => result.symbol === plan.symbol,
      );
      await tryOpenPosition(
        plan,
        aiResult,
        portfolio,
        capitalState,
        scanCashLedger,
      );
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
async function tryOpenPosition(
  plan,
  aiResult,
  portfolio,
  capitalState,
  scanCashLedger,
) {
  const meta = loadPositionMeta();
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
    journal.candidateRejected(plan.symbol, "POSITION_CAP_EXECUTION", reason);
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
      journal.candidateRejected(plan.symbol, "GROSS_EXPOSURE_CAP", reason);
      return;
    }
  }

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
            journal.candidateRejected(
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
        // v6: loss-aware cooldown + re-entry justification (whipsaw guard)
        cooldownTracker.startCooldown(symbol, {
          wasLoss: pnlDollars < 0,
          scoreAtExit:
            (positionMeta.plan && positionMeta.plan.score) ??
            (positionMeta.entryConditions &&
              positionMeta.entryConditions.score) ??
            null,
        });

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
      // v7: reuse the most recent scan's brief. It is minutes-to-an-hour old
      // at review time, which is fine — this is context for a hold/trim
      // judgement, not a gate, and the alternative (no macro picture at all)
      // is strictly worse.
      brief: lastKnownBrief,
      briefText: lastKnownBriefText,
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
        reviewResult.analysis,
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
            // v6: loss-aware cooldown + re-entry justification
            cooldownTracker.startCooldown(symbol, {
              wasLoss: pnlDollars < 0,
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

  // v6: real-time exit watchdog. A live tick crossing a held position's own
  // stop/floor triggers an IMMEDIATE off-cycle exit check instead of waiting
  // up to 60s for the next 1-minute tick. Guarded against overlapping with
  // an already-running exit check/scan — it just runs the SAME
  // manageOpenPositions() path a normal tick would, so risk-manager's
  // whipsaw confirmation still applies identically.
  priceStream.start(async (symbol, estimatedMidPrice) => {
    if (scanInProgress || exitCheckInProgress || reviewInProgress) return;
    logger.warn(
      "Emergency position check (price stream): " +
        symbol +
        " estimated mid $" +
        estimatedMidPrice.toFixed(4),
    );
    exitCheckInProgress = true;
    try {
      await manageOpenPositions();
      consecutiveExitMonitorFailures = 0;
    } catch (emergencyError) {
      logger.error(
        "Emergency exit check failed: " + emergencyError.message,
      );
    } finally {
      exitCheckInProgress = false;
    }
  });

  if (process.env.DT_RUN_ON_STARTUP !== "false") {
    runScanCycle();
  }

  logger.info("Running (" + marketHours.getCurrentBahrainTime() + " Bahrain)");
}

main();
