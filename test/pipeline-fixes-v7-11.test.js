// v7.11 pipeline-integrity tests.
//
// These guard four bugs found by reading a full live session (2026-09-01)
// in which the bot took ZERO trades across ~10 hours. Each test records the
// evidence, because the whole point of the coming month of live logging is
// that the funnel actually reaches the screener with tradable names.
//
// NOTE ON CONFIG: reads the RESOLVED config rather than assuming its own
// process.env.DT_* overrides applied — config is a shared singleton.
const config = require("../src/config");
const tradePlanner = require("../src/strategies/trade-planner");
const etoroClient = require("../src/etoro-client");

// A candidate that clears every SWING bar in classifyTradeType():
// TRENDING regime, RSI under 70, relative strength >= 1.5, above VWAP,
// and a setup that is not GAP_AND_GO.
function swingQualifiedCandidate(overrides) {
  return Object.assign(
    {
      symbol: "TESTQ",
      currentPrice: 100,
      atrPercent: 3.0,
      priceChangePercent: 2.0,
      rsi: 60,
      relativeStrength: 2.5,
      aboveVwap: true,
      score: 95, // comfortably over any configured entry floor
      setup: "MOMENTUM_BREAKOUT",
      detail: "unit-test",
      source: "WATCHLIST",
      averageVolume: 1e9,
    },
    overrides || {},
  );
}

// easternWeekday must be inside DT_SWING_ENTRY_DAYS (default Mon-Wed) or
// the candidate is disqualified as a late-week entry before we get to the
// capacity branch under test.
const SWING_DAY = (config.swingEntryDays && config.swingEntryDays[0]) || 2;

function build(openCounts, weekday) {
  return tradePlanner.buildTradePlan(
    swingQualifiedCandidate(),
    {
      regime: "TRENDING",
      spyChangePercent: 0.5,
      easternWeekday: weekday === undefined ? SWING_DAY : weekday,
    },
    { effectiveCapital: 10000, riskMultiplier: 1 },
    openCounts,
    false,
  );
}

module.exports = {
  name: "pipeline fixes v7.11 (swing downgrade, negative cache, log noise)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass });

    // ══ 1. SWING CAPACITY DOWNGRADES INSTEAD OF DISCARDING ═════════════
    //
    // Live evidence: with DT_MAX_SWING_POSITIONS=0, MMED and CRK were
    // rejected "swing slots full" on six consecutive scans. A SWING label
    // is only earned by passing EVERY trend-persistence bar, so the old
    // behaviour threw away the best candidates and traded the rest.
    //
    // swingCount === maxSwingPositions forces the no-capacity branch
    // whatever the configured slot count happens to be.
    const atCapacity = build({
      dayCount: 0,
      swingCount: config.maxSwingPositions,
    });

    check(
      "swing at capacity: plan is ACCEPTED, not discarded",
      atCapacity.accepted === true,
    );
    check(
      "swing at capacity: demoted to DAY rather than rejected",
      atCapacity.accepted === true && atCapacity.plan.tradeType === "DAY",
    );
    check(
      "swing at capacity: downgrade is flagged for later analysis",
      atCapacity.accepted === true &&
        atCapacity.plan.downgradedFromSwing === true,
    );
    check(
      "swing at capacity: reason explains the demotion",
      atCapacity.accepted === true &&
        /traded as DAY/.test(atCapacity.plan.tradeTypeReason || ""),
    );
    check(
      "swing at capacity: DAY geometry applied (no third target)",
      atCapacity.accepted === true && atCapacity.plan.targetT3 == null,
    );

    // A demoted plan must still respect the DAY slot limit — the downgrade
    // must not become a way to exceed maxDayPositions.
    const dayFull = build({
      dayCount: config.maxDayPositions,
      swingCount: config.maxSwingPositions,
    });
    check(
      "downgrade still honours the DAY slot cap",
      dayFull.accepted === false &&
        /day-trade slots full/.test(dayFull.rejectReason || ""),
    );

    // Control: when swing capacity DOES exist, the label must survive.
    if (config.maxSwingPositions > 0) {
      const withRoom = build({ dayCount: 0, swingCount: 0 });
      check(
        "swing with capacity: stays SWING (no spurious downgrade)",
        withRoom.accepted === true &&
          withRoom.plan.tradeType === "SWING" &&
          withRoom.plan.downgradedFromSwing === false,
      );
    } else {
      // Swings are paused in this configuration, so the control cannot run
      // live. Assert the pause itself is what makes the downgrade fire.
      check(
        "swings paused: downgrade path is the active one",
        config.maxSwingPositions === 0 &&
          atCapacity.accepted === true &&
          atCapacity.plan.downgradedFromSwing === true,
      );
    }

    // A candidate that FAILS a swing bar was always a DAY trade — it must
    // not be mislabelled as a downgrade, or the month's data is polluted.
    const genuineDay = tradePlanner.buildTradePlan(
      swingQualifiedCandidate({ aboveVwap: false }), // fails one swing bar
      { regime: "TRENDING", spyChangePercent: 0.5, easternWeekday: SWING_DAY },
      { effectiveCapital: 10000, riskMultiplier: 1 },
      { dayCount: 0, swingCount: config.maxSwingPositions },
      false,
    );
    check(
      "genuine DAY candidate is not falsely flagged as downgraded",
      genuineDay.accepted === true &&
        genuineDay.plan.tradeType === "DAY" &&
        genuineDay.plan.downgradedFromSwing === false,
    );

    // ══ 2. ENTRY-FLOOR MESSAGE NO LONGER ROUNDS INTO A FAKE BUG ════════
    //
    // toFixed(0) printed a rejected 79.6 as "score 80 below the entry floor
    // of 80", which reads as an off-by-one that does not exist.
    if (config.minEntryScore > 1) {
      const justUnder = tradePlanner.buildTradePlan(
        swingQualifiedCandidate({ score: config.minEntryScore - 0.4 }),
        {
          regime: "TRENDING",
          spyChangePercent: 0.5,
          easternWeekday: SWING_DAY,
        },
        { effectiveCapital: 10000, riskMultiplier: 1 },
        { dayCount: 0, swingCount: 0 },
        false,
      );
      const printedFloor = String(config.minEntryScore);
      check(
        "entry-floor rejection does not print score == floor",
        justUnder.accepted === false &&
          !new RegExp("score " + printedFloor + " below").test(
            justUnder.rejectReason || "",
          ),
      );
    }

    // ══ 3. NEGATIVE RESOLUTION CACHE ═══════════════════════════════════
    //
    // Live evidence: RDIB/FGL/NIPG/FCUV/WFCF each re-resolved twice per
    // scan and failed every time — roughly 600 wasted API calls a day,
    // plus enrichment credits spent on names that can never be ordered.
    const SYM = "ZZUNRESOLVABLE";
    delete etoroClient.instrumentIdNegativeCache[SYM];

    check(
      "unknown symbol is not pre-emptively blacklisted",
      etoroClient.isKnownUnresolvable(SYM) === false,
    );

    etoroClient.instrumentIdNegativeCache[SYM] = Date.now();
    check(
      "a fresh failure suppresses repeat lookups",
      etoroClient.isKnownUnresolvable(SYM) === true,
    );

    // Must EXPIRE — eToro does add listings, and a transient search glitch
    // must never blacklist a good symbol for the life of the process.
    etoroClient.instrumentIdNegativeCache[SYM] = Date.now() - 48 * 3600 * 1000;
    check(
      "a stale failure expires so the symbol can be retried",
      etoroClient.isKnownUnresolvable(SYM) === false,
    );
    check(
      "expiry evicts the entry rather than leaking it",
      etoroClient.instrumentIdNegativeCache[SYM] === undefined,
    );

    // Successful resolutions must never be poisoned by the negative cache.
    check(
      "negative cache is separate from the positive one",
      etoroClient.instrumentIdCache !==
        etoroClient.instrumentIdNegativeCache,
    );

    // ══ 4. THE RE-ENTRY SCORE PENALTY EXPIRES (v7.12) ══════════════════
    //
    // Live evidence 2026-09-01: 26 symbols carried a penalty, 24 of them
    // requiring a score of 90 after the clamp, from losses up to 41 days
    // old (AAPL 39d, CRWV/DELL 41d, MSFT/AVGO 33d). The whole watchlist
    // peaked at 87 that session, so all of them were unbuyable — roughly
    // half the watchlist silently retired, including the mega-cap bucket
    // that was the only profitable one in the audit.
    check(
      "penalty expiry is configured and finite",
      config.reentryPenaltyExpiryHours > 0 &&
        Number.isFinite(config.reentryPenaltyExpiryHours),
    );

    const cooldownTracker = require("../src/strategies/cooldown-tracker");
    const fs = require("fs");
    const path = require("path");
    const cooldownPath = path.join(
      __dirname,
      "..",
      "data",
      "trade-cooldowns.json",
    );
    const hadFile = fs.existsSync(cooldownPath);
    const original = hadFile ? fs.readFileSync(cooldownPath, "utf8") : null;
    const hourMs = 60 * 60 * 1000;

    try {
      const writeRecord = (ageHours) =>
        fs.writeFileSync(
          cooldownPath,
          JSON.stringify({
            ZTEST: {
              exitAtMs: Date.now() - ageHours * hourMs,
              wasLoss: true,
              scoreAtExit: 88,
            },
          }),
        );

      // Fresh loss: the bar must still apply, or the guard is useless.
      writeRecord(1);
      const fresh = cooldownTracker.getReentryJustification("ZTEST");
      check(
        "a recent loss still requires a stronger setup",
        fresh.requiresJustification === true && fresh.minScore > 0,
      );
      check(
        "the bar stays clamped to a reachable score",
        fresh.minScore <= config.reentryMaxRequiredScore,
      );

      // Stale loss: must NOT gate the symbol any more.
      writeRecord(config.reentryPenaltyExpiryHours + 24);
      const stale = cooldownTracker.getReentryJustification("ZTEST");
      check(
        "a stale loss no longer blocks re-entry",
        stale.requiresJustification === false,
      );
      check(
        "expiry is reported, not silent",
        stale.expired === true,
      );

      // Boundary: just inside the window must still be enforced.
      writeRecord(config.reentryPenaltyExpiryHours - 1);
      check(
        "penalty holds right up to the expiry boundary",
        cooldownTracker.getReentryJustification("ZTEST")
          .requiresJustification === true,
      );
    } finally {
      if (hadFile) fs.writeFileSync(cooldownPath, original);
      else if (fs.existsSync(cooldownPath)) fs.unlinkSync(cooldownPath);
    }

    return results;
  },
};
