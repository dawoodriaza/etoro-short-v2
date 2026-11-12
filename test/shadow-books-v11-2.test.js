// v11.2 tests: the two new shadow books — the no-chase tag and the
// 5-day pullback strategy. Pure functions, no network, no files.
module.exports = {
  name: "shadow books v11.2 (no-chase tag, pullback strategy)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass: !!pass });
    const config = require("../src/config");
    const planner = require("../src/strategies/trade-planner");
    const books = require("../src/shadow-strategies");

    // ── no-chase tag ───────────────────────────────────────────────────
    check("defaults: 5% day move, 1.0x daily range, 4 pts vs SPY",
      config.noChaseMaxDayMovePct === 5 && config.noChaseMaxMoveToAtr === 1 && config.noChaseMaxRelativeStrength === 4);
    check("a modest move is not stretched",
      planner.stretchedEntryReasons({ priceChangePercent: 2.1, moveToAtrRatio: 0.6, relativeStrength: 1.5 }).length === 0);
    check("up 5%+ today is stretched",
      planner.stretchedEntryReasons({ priceChangePercent: 5.2, moveToAtrRatio: 0.7, relativeStrength: 2 }).length === 1);
    check("moved more than its daily range is stretched",
      planner.stretchedEntryReasons({ priceChangePercent: 3, moveToAtrRatio: 1.2, relativeStrength: 2 }).length === 1);
    check("all three reasons are listed",
      planner.stretchedEntryReasons({ priceChangePercent: 8, moveToAtrRatio: 1.5, relativeStrength: 6 }).length === 3);
    check("missing figures never tag a trade",
      planner.stretchedEntryReasons({}).length === 0 && planner.stretchedEntryReasons(null).length === 0);

    // ── pullback strategy ──────────────────────────────────────────────
    const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    const build = (closes) => {
      const daily = closes.map((c, i) => ({ date: day(i), t: Date.UTC(2026, 0, 1) + i * 86400000, o: c, h: c * 1.01, l: c * 0.99, c, v: 1 }));
      const last = daily[daily.length - 1];
      return { daily, sessions: new Map([[last.date, { o: last.o, h: last.h, l: last.l, c: last.c }]]), date: last.date };
    };
    const rising = Array.from({ length: 130 }, (_, i) => 100 + i * 0.3);
    const scan = (closes) => {
      const u = build(closes);
      return books.STRATEGIES.PULLBACK_5D.scan(u.date, { symbols: ["AAA"], universe: { AAA: u } });
    };
    const top = rising[rising.length - 1];
    const dipped = [...rising, top * 0.98, top * 0.96, top * 0.94]; // -6% over 3 days, still above the average
    check("uptrend + 6% drop over 3 days → a signal", scan(dipped).length === 1 && scan(dipped)[0].stopAtr === 3);
    check("uptrend with no drop → no signal", scan([...rising, top * 1.001, top * 1.002, top * 1.003]).length === 0);
    check("a 3% drop is not enough", scan([...rising, top * 0.99, top * 0.98, top * 0.97]).length === 0);
    const falling = Array.from({ length: 130 }, (_, i) => 200 - i * 0.5);
    const low = falling[falling.length - 1];
    check("the same drop in a DOWNtrend → no signal", scan([...falling, low * 0.98, low * 0.96, low * 0.94]).length === 0);
    check("too little history → no signal", scan(dipped.slice(-60)).length === 0);
    check("it holds 5 sessions and is listed with the other books",
      books.STRATEGIES.PULLBACK_5D.maxHoldSessions === 5 && Object.keys(books.STRATEGIES).includes("PULLBACK_5D"));
    return results;
  },
};
