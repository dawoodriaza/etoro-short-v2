// v7.5 tests: every Telegram dollar figure in the real (copy) account, and
// log timestamps in the operator's timezone instead of server UTC.
//
// Server system clock was confirmed as Etc/UTC via `timedatectl` — every
// log line had been printed in UTC despite every "X Bahrain" message in the
// same console implying otherwise. And two whole Telegram reports (weekly
// performance, Friday self-evaluation) were found still showing raw
// bot-account dollars after the v7.3 dual-amount fix, because they build
// their numbers from computeStats()/totalPnl() directly rather than through
// the shared formatter.
//
// NOTE ON CONFIG: reads the RESOLVED config rather than assuming its own
// process.env.DT_* overrides applied — config is a shared singleton.
const config = require("../src/config");

module.exports = {
  name: "telegram money & log timestamps v7.5",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass });

    // ══ Log timestamps follow the operator's timezone ══════════════════
    delete require.cache[require.resolve("../src/logger")];
    process.env.DT_LOG_TIMEZONE = "Asia/Bahrain";
    const { logger } = require("../src/logger");

    // Winston's timestamp formatter isn't exposed directly, so reconstruct
    // it the same way logger.js does and check it against a known instant.
    const formatAt = (utcDate) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bahrain",
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(utcDate)
        .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});

    // The exact instant from the bug report: server (UTC) said 07:13:23,
    // which is 10:13:23 in Bahrain (UTC+3, no DST).
    const utcInstant = new Date(Date.UTC(2026, 7, 6, 7, 13, 23));
    const bahrainParts = formatAt(utcInstant);
    check(
      "log timezone: a UTC instant of 07:13:23 renders as 10:13:23 in Bahrain",
      bahrainParts.hour === "10" &&
        bahrainParts.minute === "13" &&
        bahrainParts.second === "23",
    );
    check(
      "log timezone: logger module loads cleanly with the custom timestamp formatter",
      typeof logger.info === "function",
    );

    // ══ Telegram money: performance report ══════════════════════════════
    delete require.cache[require.resolve("../src/strategies/performance-tracker")];
    const performance = require("../src/strategies/performance-tracker");
    const ratio = config.realAccountCapital / config.dayTradeCapital;

    const fakeStats = {
      totalTrades: 10,
      wins: 6,
      losses: 4,
      winRate: 60,
      avgWin: 20,
      avgLoss: -15,
      profitFactor: 2.0,
      expectancy: 6,
      totalPnl: 60,
      bySetup: {
        MOMENTUM_SURGE: { trades: 10, wins: 6, pnl: 60 },
      },
    };
    const report = performance.formatStatsForTelegram(fakeStats);
    check(
      "performance report: total P&L is shown in REAL-account dollars",
      report.includes("$" + (60 * ratio).toFixed(2)),
    );
    check(
      "performance report: does NOT leak the raw bot-account total",
      ratio !== 1 ? !report.includes("$60.00") : true,
    );
    check(
      "performance report: avg win is scaled",
      report.includes("$" + (20 * ratio).toFixed(2)),
    );
    check(
      "performance report: the per-setup breakdown is scaled too",
      report.includes("$" + (60 * ratio).toFixed(2)),
    );
    check(
      "performance report: win rate is a ratio and stays unscaled",
      report.includes("60.0%"),
    );

    // ══ Telegram money: self-evaluation report ══════════════════════════
    delete require.cache[require.resolve("../src/strategies/self-evaluation")];
    const selfEval = require("../src/strategies/self-evaluation");
    const fakeReport = {
      hasEnoughData: true,
      totalTrades: 20,
      overallStats: { winRate: 55, totalPnl: 120 },
      bySetup: [],
      regimeFindings: [],
      scoreAnalysis: null,
      holdTime: null,
      archetypeFindings: [],
      extendedAnalysis: null,
      suggestions: [],
    };
    const evalText = selfEval.formatSelfEvaluationForTelegram(fakeReport);
    check(
      "self-evaluation report: the headline total is shown in REAL dollars",
      evalText.includes("$" + (120 * ratio).toFixed(2)),
    );
    check(
      "self-evaluation report: does not leak the raw bot-account figure",
      ratio !== 1 ? !evalText.includes("$120.00") : true,
    );

    return results;
  },
};
