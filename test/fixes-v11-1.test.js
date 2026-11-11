// v11.1 tests: commission kept out of the losing-day streak, NYSE early
// closes and holidays. The real capital ledger is moved aside meanwhile.
const fs = require("fs");
const path = require("path");

const realLedgerPath = path.join(__dirname, "../data/capital-ledger.json");
const ledgerBackupPath = realLedgerPath + ".test-backup-v11-1";

module.exports = {
  name: "fixes v11.1 (de-risk vs commission, early closes, holidays)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass: !!pass });

    // ── #1 commission must not make a day "losing" ─────────────────────
    const hadLedger = fs.existsSync(realLedgerPath);
    if (hadLedger) fs.renameSync(realLedgerPath, ledgerBackupPath);
    try {
      delete require.cache[require.resolve("../src/strategies/capital-manager")];
      const capital = require("../src/strategies/capital-manager");
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      // yesterday was a real losing day
      fs.writeFileSync(realLedgerPath, JSON.stringify({
        baseCapital: 10000, ownerAdjustments: 0, cumulativeRealizedPnl: -50,
        peakEffectiveCapital: 10000, dailyPnl: { "2020-01-01": -50 },
      }));
      const before = capital.getCapitalState();
      capital.recordCommission(1); // first buy of today
      const after = capital.getCapitalState();
      const ledger = JSON.parse(fs.readFileSync(realLedgerPath, "utf8"));
      check("a buy's commission does not create a losing day", !(today in ledger.dailyPnl));
      check("…so size is NOT halved (streak stays 1)", after.consecutiveLosingDays === 1 && after.riskMultiplier === 1);
      check("…but capital still drops by the $1", Math.abs(before.effectiveCapital - after.effectiveCapital - 1) < 1e-9);
      check("…and it is tallied per day", ledger.dailyCommissions[today] === 1 && ledger.commissionsBooked === 1);
      capital.recordRealizedPnl(-5); // a real losing close today
      check("a real losing close today still counts", capital.getCapitalState().consecutiveLosingDays === 2);
    } finally {
      if (fs.existsSync(realLedgerPath)) fs.unlinkSync(realLedgerPath);
      if (hadLedger) fs.renameSync(ledgerBackupPath, realLedgerPath);
      delete require.cache[require.resolve("../src/strategies/capital-manager")];
    }

    // ── #4 calendar ────────────────────────────────────────────────────
    const mh = require("../src/market-hours");
    const et = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h + 5, mi)); // EST dates
    check("27 Nov 2026 closes at 13:00", mh.getSessionCloseMinute(et(2026, 11, 27, 10, 0)) === 780);
    check("24 Dec 2026 closes at 13:00", mh.getSessionCloseMinute(et(2026, 12, 24, 10, 0)) === 780);
    check("a normal day closes at 16:00", mh.getSessionCloseMinute(et(2026, 11, 18, 10, 0)) === 960);
    check("Wed 25 Nov 2026 is the day before a holiday", mh.isNextWeekdayHoliday(et(2026, 11, 25, 15, 0)));
    check("Thu 31 Dec 2026 → 1 Jan 2027 holiday", mh.isNextWeekdayHoliday(et(2026, 12, 31, 15, 0)));
    check("Tue 17 Nov 2026 is not", !mh.isNextWeekdayHoliday(et(2026, 11, 17, 15, 0)));
    check("2027 holidays are known", mh.US_MARKET_HOLIDAYS.has("2027-01-01") && mh.US_MARKET_HOLIDAYS.has("2027-11-25"));

    const timing = require("../src/strategies/session-timing");
    const fri1250 = timing.getEntryCutoffStatus(et(2026, 11, 27, 12, 50));
    check("27 Nov 12:50 ET: no entries (force-close has run)", fri1250.blocked && fri1250.gate === "FRIDAY_AFTER_CLOSE");
    check("27 Nov 10:00 ET: entries allowed", !timing.getEntryCutoffStatus(et(2026, 11, 27, 10, 0)).blocked);
    const wed1550 = timing.getEntryCutoffStatus(et(2026, 11, 25, 15, 50));
    check("Wed before Thanksgiving 15:50 ET: no entries into the holiday", wed1550.blocked && wed1550.gate === "FRIDAY_AFTER_CLOSE");
    const normal1550 = timing.getEntryCutoffStatus(et(2026, 11, 18, 15, 50));
    check("a normal Wednesday is unchanged", normal1550.gate !== "FRIDAY_AFTER_CLOSE");

    const risk = require("../src/strategies/risk-manager");
    check("session minutes stop at 13:00 on an early-close day",
      risk.computeRegularSessionMinutesBetween(et(2026, 11, 27, 9, 30).getTime(), et(2026, 11, 27, 15, 0).getTime()) === 210);
    check("Thanksgiving counts zero session minutes",
      risk.computeRegularSessionMinutesBetween(et(2026, 11, 25, 15, 0).getTime(), et(2026, 11, 27, 10, 0).getTime()) === 90);
    check("a 2027 holiday counts zero (old copy stopped at 2026)",
      risk.computeRegularSessionMinutesBetween(et(2026, 12, 31, 15, 0).getTime(), et(2027, 1, 4, 10, 0).getTime()) === 90);
    return results;
  },
};
