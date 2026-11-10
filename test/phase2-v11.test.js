// v11 (Phase 2) tests: the fixed readings logged beside the live ones.
// Pure functions only — no network, no files.
module.exports = {
  name: "phase 2 v11 (fixed readings, shadow only)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass: !!pass });
    const marketData = require("../src/market-data");
    const scanner = require("../src/strategies/momentum-scanner");
    const shadow = require("../src/strategies/shadow-signals");

    // 2026-11-09 is EST (UTC-5): 09:30 ET = 14:30Z
    const at = (hh, mm) => Date.UTC(2026, 10, 9, hh + 5, mm);
    const bar = (hh, mm, o, h, l, c, v) => ({ t: at(hh, mm), o, h, l, c, v });
    const bars = [
      bar(4, 0, 90, 120, 89, 91, 5000), // pre-market spike — must be ignored
      bar(9, 30, 100, 101, 99, 100.5, 1000),
      bar(9, 35, 100.5, 102, 100, 101.5, 1000),
      bar(9, 40, 101.5, 102.5, 101, 102.4, 1000), // still forming at 09:42
    ];
    const now = at(9, 42);
    const r = marketData.computeSessionReadings(bars, now, 100000);

    check("pre-market bar is left out of the session high", r.sessionHigh === 102.5);
    check("day open is the 09:30 bar's open", r.dayOpen === 100);
    check("breakout high excludes the bar still forming", r.priorSessionHigh === 102);
    check("only completed bars count for volume", r.completedBars === 2);
    const expected = 100000 * marketData.SESSION_VOLUME_PROFILE[1];
    check("relative volume uses the time-of-day curve", Math.abs(r.volumeRatio - 2000 / expected) < 1e-9);
    const vwap = ((101 + 99 + 100.5) / 3 + (102 + 100 + 101.5) / 3 + (102.5 + 101 + 102.4) / 3) / 3;
    check("VWAP is regular-session only", Math.abs(r.sessionVwap - vwap) < 1e-9);
    check("no readings before the session opens", marketData.computeSessionReadings(bars, at(9, 0), 100000) === null);
    check("volume curve rises to the end of the day", marketData.SESSION_VOLUME_PROFILE.length === 78 &&
      marketData.SESSION_VOLUME_PROFILE.every((x, i, a) => i === 0 || x >= a[i - 1]));

    check("previous close is frozen for the day",
      marketData.stablePreviousClose("ZZTEST", 50) === 50 && marketData.stablePreviousClose("ZZTEST", 52) === 50);

    // a stock that gapped up 3% and is breaking its session high
    const candidate = {
      symbol: "ZZTEST",
      source: "WATCHLIST",
      currentPrice: 102.4,
      priceChangePercent: 5.0, // live figure against a shifted previous close
      stablePreviousClose: 97,
      rsi: 85, // above the live RSI band: no MOMENTUM_SURGE
      vwap: 105, // live midnight VWAP pulled up by the pre-market spike
      recentIntradayHigh: 120, // live high from the pre-market spike
      recentIntradayLow: 89,
      volumeRatio: 3,
      atrPercent: 3,
    };
    Object.defineProperty(candidate, "sessionReadings", { value: r, enumerable: false });
    const fixed = scanner.applyFixedReadings(candidate);
    check("fixed % up uses the frozen previous close", Math.abs(fixed.priceChangePercent - (102.4 / 97 - 1) * 100) < 1e-9);
    check("fixed gap = day open vs previous close", Math.abs(fixed.gapPercent - (100 / 97 - 1) * 100) < 1e-9);

    const live = scanner.scoreEnrichedCandidate(candidate, 0, { regime: "TREND" }, null);
    check("live: rejected (below the pre-market-inflated VWAP)", live.rejected && live.rejectReason === "below VWAP");
    const fixedScored = scanner.scoreEnrichedCandidate(fixed, 0, { regime: "TREND" }, null);
    check("fixed: passes, with a real setup", !fixedScored.rejected && ["GAP_AND_GO", "BREAKOUT"].includes(fixedScored.setup));

    const record = shadow.buildShadowSignal(candidate, live, { spyChangePercent: 0, regime: "TREND", regimeObject: { regime: "TREND" } });
    check("shadow record carries the fixed block", record.fixed && record.fixed.setup === fixedScored.setup);
    check("…flags that the verdict changed", record.fixed.verdictChanged === true);
    check("…and the live fields are untouched", record.vwapDistancePct < 0 && record.outcome === "SCORING_REJECTED");
    const noReadings = shadow.buildShadowSignal({ symbol: "X", currentPrice: 1 }, live, {});
    check("no session readings → fixed is null", noReadings.fixed === null);

    // the live candidate itself is never modified
    check("live candidate unchanged", candidate.vwap === 105 && candidate.priceChangePercent === 5);
    return results;
  },
};
