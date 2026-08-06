// v7.1 production-bug tests. Every case here reproduces something that was
// observed in live pm2 logs on 2026-07-27, so each test is a regression
// guard against a failure that actually cost money.
//
// NOTE ON CONFIG: reads the RESOLVED config rather than assuming its own
// process.env.DT_* overrides applied — config is a shared singleton
// evaluated once by whichever test file required it first.
const marketHours = require("../src/market-hours");
const riskManager = require("../src/strategies/risk-manager");
const config = require("../src/config");

// 2026-07-27 is a Monday. 13:30 UTC = 09:30 ET (EDT, UTC-4) = the open.
const utc = (h, m) => Date.UTC(2026, 6, 27, h, m); // July = month 6
const MIN = 60000;

module.exports = {
  name: "production fixes v7.1 (timezone, session budget, re-entry, caps)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass });

    // ══ P0: the midnight hour-24 bug ══════════════════════════════════
    // On Node 20 `hour12:false` yields hour 24 at 00:xx ET, so every
    // module computing (hour-9)*60 got ~900 instead of ~-540 and treated
    // a dead overnight tape as a completed 390-minute session.
    const midnight = marketHours.getEasternHourMinute(new Date(utc(4, 30)));
    check(
      "timezone: 00:30 ET parses as hour 0, never 24",
      midnight.hour === 0 && midnight.minute === 30,
    );
    check(
      "timezone: minutes-since-open at 00:30 ET is NEGATIVE (pre-open)",
      marketHours.getMinutesSinceEasternOpen(new Date(utc(4, 30))) === -540,
    );
    // Sweep the whole broken hour — every minute of it used to read as a
    // finished session.
    let anyHourBroken = false;
    for (let minute = 0; minute < 60; minute += 7) {
      const probe = marketHours.getEasternHourMinute(new Date(utc(4, minute)));
      const since = marketHours.getMinutesSinceEasternOpen(
        new Date(utc(4, minute)),
      );
      if (probe.hour === 24 || since >= 45) anyHourBroken = true;
    }
    check(
      "timezone: no minute of the 00:00-00:59 ET hour reads as a live session",
      !anyHourBroken,
    );
    check(
      "timezone: normaliseHour maps a stray 24 back to 0",
      marketHours.normaliseHour(24) === 0 && marketHours.normaliseHour(13) === 13,
    );
    // Regular trading hours must still be correct after the change.
    check(
      "timezone: 10:00 ET still reads as hour 10, +30 min since open",
      marketHours.getEasternHourMinute(new Date(utc(14, 0))).hour === 10 &&
        marketHours.getMinutesSinceEasternOpen(new Date(utc(14, 0))) === 30,
    );
    check(
      "timezone: 15:59 ET is +389 min since open (last session minute)",
      marketHours.getMinutesSinceEasternOpen(new Date(utc(19, 59))) === 389,
    );

    // ══ P0/SNAP: session-minute accounting ════════════════════════════
    const sessionMinutes = riskManager.computeRegularSessionMinutesBetween;

    // SNAP's real timeline: opened 01:00 ET Monday, killed ~90 wall-clock
    // minutes later at 02:30 ET — 7 hours before the market opened.
    check(
      "SNAP case: 01:00->02:30 ET pre-market accrues ZERO session minutes",
      sessionMinutes(utc(5, 0), utc(6, 30)) === 0,
    );
    check(
      "SNAP case: 01:00 ET entry has still accrued zero budget by 09:29 ET",
      sessionMinutes(utc(5, 0), utc(13, 29)) === 0,
    );
    check(
      "SNAP case: that same position accrues 30 min by 10:00 ET",
      sessionMinutes(utc(5, 0), utc(14, 0)) === 30,
    );
    check(
      "SNAP case: it finally spends a 90-min budget at 11:00 ET, not 02:30",
      sessionMinutes(utc(5, 0), utc(15, 0)) === 90,
    );

    // Intraday accounting must be plain wall-clock inside the session.
    check(
      "session minutes: 10:00->11:00 ET counts a full 60",
      sessionMinutes(utc(14, 0), utc(15, 0)) === 60,
    );
    // After the close, nothing more accrues.
    check(
      "session minutes: 15:30->18:00 ET stops counting at the 16:00 close",
      sessionMinutes(utc(19, 30), utc(22, 0)) === 30,
    );
    // A full session is 390 minutes.
    check(
      "session minutes: a whole 09:30-16:00 session is 390 minutes",
      sessionMinutes(utc(13, 30), utc(20, 0)) === 390,
    );
    // Weekends contribute nothing: Sat 2026-07-25 through Sun.
    check(
      "session minutes: a weekend accrues zero",
      riskManager.computeRegularSessionMinutesBetween(
        Date.UTC(2026, 6, 25, 14, 0),
        Date.UTC(2026, 6, 26, 20, 0),
      ) === 0,
    );
    check(
      "session minutes: reversed/degenerate ranges return 0, never negative",
      sessionMinutes(utc(15, 0), utc(14, 0)) === 0 &&
        sessionMinutes(0, 0) === 0 &&
        sessionMinutes(null, utc(14, 0)) === 0,
    );

    // The wall-clock backstop must still exist, so a Friday-night entry
    // cannot be held forever waiting for session minutes that never come.
    check(
      "backstop: an absolute wall-clock ceiling is configured",
      config.maxHoldWallClockCeilingMultiplier > 1,
    );
    const ceilingMinutes =
      config.maxHoldMinutes * config.maxHoldWallClockCeilingMultiplier;
    const staleMeta = {
      tradeType: "DAY",
      entryPrice: 100,
      stopPrice: 97,
      targetT1: 110,
      peakPrice: 100,
      peakSetAt: Date.now() - (ceilingMinutes + 60) * MIN,
      openedAt: Date.now() - (ceilingMinutes + 60) * MIN,
      recentPrices: [
        { price: 99.8, atMs: Date.now() - 3 * MIN },
        { price: 99.8, atMs: Date.now() - 2 * MIN },
        { price: 99.8, atMs: Date.now() - 1 * MIN },
      ],
      staleGraceUsedAt: 1, // grace already consumed long ago
      partialDone: false,
    };
    const ceilingDecision = riskManager.decidePositionAction(staleMeta, 99.8);
    check(
      "backstop: a position past the wall-clock ceiling still exits, even with 0 session minutes",
      ceilingDecision.action === "EXIT" &&
        ceilingDecision.reason === "TIME_EXIT_STALE",
    );
    check(
      "backstop: the exit records WHICH limit fired, for later analysis",
      ceilingDecision.timeExitTrigger === "WALL_CLOCK_CEILING" ||
        ceilingDecision.timeExitTrigger === "SESSION_BUDGET",
    );

    // A hard stop must still outrank every one of these time rules.
    const stopMeta = {
      ...staleMeta,
      stopBreachTicks: 99,
      openedAt: Date.now() - 10 * MIN,
      peakSetAt: Date.now() - 10 * MIN,
    };
    check(
      "safety: a hard stop-loss still fires regardless of session accounting",
      riskManager.decidePositionAction(stopMeta, 90).reason === "STOP_LOSS",
    );

    // ══ P1: permanent re-entry lockout above score 85 ═════════════════
    // Reload the tracker against an isolated file so the real cooldown
    // state is untouched.
    const fs = require("fs");
    const path = require("path");
    const realCooldowns = path.join(__dirname, "../data/trade-cooldowns.json");
    const backup = realCooldowns + ".v7test-backup";
    const hadReal = fs.existsSync(realCooldowns);
    if (hadReal) fs.renameSync(realCooldowns, backup);

    delete require.cache[require.resolve("../src/strategies/cooldown-tracker")];
    const cooldownTracker = require("../src/strategies/cooldown-tracker");

    try {
      // AMD's real case: lost at score 88, needed 88+15 = 103, but the
      // scanner caps every score at 100. Rejected 13 times in 3 hours.
      cooldownTracker.startCooldown("AMDTEST", {
        wasLoss: true,
        scoreAtExit: 88,
      });
      const highScore = cooldownTracker.getReentryJustification("AMDTEST");
      check(
        "re-entry: a prior score of 88 no longer demands an impossible 103",
        highScore.minScore <= 100,
      );
      check(
        "re-entry: the bar is clamped to the configured reachable ceiling",
        highScore.minScore === config.reentryMaxRequiredScore &&
          highScore.wasClamped === true,
      );

      // A normal prior score must be untouched — the fix must not weaken
      // the guard where it was already working.
      cooldownTracker.startCooldown("MRVLTEST", {
        wasLoss: true,
        scoreAtExit: 52,
      });
      const normalScore = cooldownTracker.getReentryJustification("MRVLTEST");
      check(
        "re-entry: an ordinary prior score (52) still requires 52+improvement",
        normalScore.minScore ===
          52 + config.lossReentryMinScoreImprovement &&
          !normalScore.wasClamped,
      );

      // A winning exit never requires justification.
      cooldownTracker.startCooldown("WINTEST", {
        wasLoss: false,
        scoreAtExit: 95,
      });
      check(
        "re-entry: a winning exit requires no justification at all",
        cooldownTracker.getReentryJustification("WINTEST")
          .requiresJustification === false,
      );
    } finally {
      try {
        if (fs.existsSync(realCooldowns)) fs.unlinkSync(realCooldowns);
        if (hadReal) fs.renameSync(backup, realCooldowns);
      } catch {
        /* best effort */
      }
    }

    // ══ P0: exposure cap is configured and sane ═══════════════════════
    // The live incident: 5 positions totalling $11,612 against $9,323 of
    // capital = 125%, because 3 day slots × 35% each permits 105% before
    // any swing sleeve.
    check(
      "exposure: a gross exposure cap is configured",
      config.maxTotalExposurePct > 0 && config.maxTotalExposurePct <= 1.5,
    );
    check(
      "exposure: the cap is tighter than per-position caps alone would allow",
      config.maxTotalExposurePct <
        config.maxPositionPctDay * config.maxDayPositions,
    );

    // ══ P1: unconfirmed-fill grace ════════════════════════════════════
    check(
      "ghost sweeper: unconfirmed positions get a longer grace than confirmed ones",
      config.unconfirmedPositionGraceMinutes >
        config.ghostPositionGraceMinutes,
    );

    // ══ Log timezone is configurable (operator moved Bahrain -> Pakistan)
    check(
      "logging: the log timezone is exposed and labelled",
      typeof marketHours.getLogTimeZoneLabel() === "string" &&
        marketHours.getLogTimeZoneLabel().length > 0,
    );
    check(
      "logging: getCurrentLocalTime returns a usable clock string",
      /\d/.test(marketHours.getCurrentLocalTime()),
    );

    return results;
  },
};
