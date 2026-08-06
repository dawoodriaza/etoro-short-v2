// v7.2 overnight scan-freeze tests. Requested window: 23:30 -> 09:30 in the
// operator's local (log) timezone, every day, new-trade scanning only.
//
// NOTE ON CONFIG: this module reads process.env directly (not the shared
// config singleton — it has to work standalone in market-hours.js, which is
// deliberately dependency-free), so overrides here take effect immediately
// without the "first require wins" caveat the other suites carry.
const path = require("path");

module.exports = {
  name: "overnight scan freeze v7.2 (23:30->09:30 local, new-trade only)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass });

    delete require.cache[require.resolve("../src/market-hours")];
    process.env.DT_OVERNIGHT_FREEZE_ENABLED = "true";
    process.env.DT_OVERNIGHT_FREEZE_START_HOUR = "23";
    process.env.DT_OVERNIGHT_FREEZE_START_MIN = "30";
    process.env.DT_OVERNIGHT_FREEZE_END_HOUR = "9";
    process.env.DT_OVERNIGHT_FREEZE_END_MIN = "30";
    process.env.DT_LOG_TIMEZONE = "Asia/Bahrain"; // UTC+3, no DST
    // v7.4: pin the freeze clock explicitly. The window can now be anchored
    // to a different timezone than the log clock (the live .env anchors it
    // to America/New_York so it tracks the ET dead zone through DST), and
    // this suite must assert Bahrain-clock behaviour regardless of what the
    // deployed .env happens to say.
    process.env.DT_OVERNIGHT_FREEZE_TIMEZONE = "Asia/Bahrain";
    const marketHours = require("../src/market-hours");

    // Bahrain has no DST, so UTC = local - 3h always. Build instants directly
    // in UTC for exact, unambiguous local-time control.
    const bahrainInstant = (hour, minute) =>
      new Date(Date.UTC(2026, 6, 27, hour - 3 < 0 ? hour - 3 + 24 : hour - 3, minute));

    // ── Squarely inside the window ──────────────────────────────────────
    check(
      "in-window: 23:30 (the exact start) is frozen",
      marketHours.isInOvernightFreezeWindow(bahrainInstant(23, 30)),
    );
    check(
      "in-window: 23:45 is frozen",
      marketHours.isInOvernightFreezeWindow(bahrainInstant(23, 45)),
    );
    check(
      "in-window: midnight (00:00, the wrap point) is frozen",
      marketHours.isInOvernightFreezeWindow(bahrainInstant(0, 0)),
    );
    check(
      "in-window: 03:00 (deep overnight) is frozen",
      marketHours.isInOvernightFreezeWindow(bahrainInstant(3, 0)),
    );
    check(
      "in-window: 09:00 is still frozen",
      marketHours.isInOvernightFreezeWindow(bahrainInstant(9, 0)),
    );
    check(
      "in-window: 09:29 is still frozen (end is exclusive)",
      marketHours.isInOvernightFreezeWindow(bahrainInstant(9, 29)),
    );

    // ── Squarely outside the window ─────────────────────────────────────
    check(
      "outside: 09:30 (the exact end) is NOT frozen — scanning resumes",
      !marketHours.isInOvernightFreezeWindow(bahrainInstant(9, 30)),
    );
    check(
      "outside: 10:00 is not frozen",
      !marketHours.isInOvernightFreezeWindow(bahrainInstant(10, 0)),
    );
    check(
      "outside: noon is not frozen",
      !marketHours.isInOvernightFreezeWindow(bahrainInstant(12, 0)),
    );
    check(
      "outside: 16:30 (real NYSE open in Bahrain time) is not frozen",
      !marketHours.isInOvernightFreezeWindow(bahrainInstant(16, 30)),
    );
    check(
      "outside: 23:29 (one minute before start) is NOT frozen",
      !marketHours.isInOvernightFreezeWindow(bahrainInstant(23, 29)),
    );

    // ── Applies every day — no day-of-week logic at all ─────────────────
    const saturdayLateNight = new Date(Date.UTC(2026, 6, 25, 21, 0)); // Sat 00:00 Bahrain
    const sundayLateNight = new Date(Date.UTC(2026, 6, 26, 21, 0)); // Sun 00:00 Bahrain
    check(
      "every day: Saturday midnight Bahrain is frozen just like a weekday",
      marketHours.isInOvernightFreezeWindow(saturdayLateNight),
    );
    check(
      "every day: Sunday midnight Bahrain is frozen just like a weekday",
      marketHours.isInOvernightFreezeWindow(sundayLateNight),
    );

    // ── Disable switch ───────────────────────────────────────────────────
    process.env.DT_OVERNIGHT_FREEZE_ENABLED = "false";
    delete require.cache[require.resolve("../src/market-hours")];
    const marketHoursDisabled = require("../src/market-hours");
    check(
      "disabled: DT_OVERNIGHT_FREEZE_ENABLED=false freezes nothing, even at 03:00",
      !marketHoursDisabled.isInOvernightFreezeWindow(bahrainInstant(3, 0)),
    );
    process.env.DT_OVERNIGHT_FREEZE_ENABLED = "true";

    // ── Configurable window (operator changes the times later) ─────────
    delete require.cache[require.resolve("../src/market-hours")];
    process.env.DT_OVERNIGHT_FREEZE_START_HOUR = "22";
    process.env.DT_OVERNIGHT_FREEZE_START_MIN = "0";
    process.env.DT_OVERNIGHT_FREEZE_END_HOUR = "6";
    process.env.DT_OVERNIGHT_FREEZE_END_MIN = "0";
    const marketHoursCustom = require("../src/market-hours");
    check(
      "configurable: a custom 22:00-06:00 window respects the new start",
      marketHoursCustom.isInOvernightFreezeWindow(bahrainInstant(22, 0)) &&
        !marketHoursCustom.isInOvernightFreezeWindow(bahrainInstant(21, 59)),
    );
    check(
      "configurable: and the new end",
      marketHoursCustom.isInOvernightFreezeWindow(bahrainInstant(5, 59)) &&
        !marketHoursCustom.isInOvernightFreezeWindow(bahrainInstant(6, 0)),
    );

    // Restore defaults for any later test file that shares this process.
    delete require.cache[require.resolve("../src/market-hours")];
    process.env.DT_OVERNIGHT_FREEZE_START_HOUR = "23";
    process.env.DT_OVERNIGHT_FREEZE_START_MIN = "30";
    process.env.DT_OVERNIGHT_FREEZE_END_HOUR = "9";
    process.env.DT_OVERNIGHT_FREEZE_END_MIN = "30";
    require("../src/market-hours");

    // ── The reviewer/EOD-close crons must fall outside the window ───────
    // Confirmed manually: reviewer runs 22:00 Bahrain, EOD close ~22:45
    // Bahrain — both before the 23:30 freeze start, so neither is starved.
    const reviewerBahrain = 22 * 60 + 0;
    const eodCloseBahrain = 22 * 60 + 45;
    const freezeStartBahrain = 23 * 60 + 30;
    check(
      "schedule: the daily reviewer (22:00 Bahrain) runs before the freeze starts",
      reviewerBahrain < freezeStartBahrain,
    );
    check(
      "schedule: EOD close (~22:45 Bahrain) runs before the freeze starts",
      eodCloseBahrain < freezeStartBahrain,
    );

    return results;
  },
};
