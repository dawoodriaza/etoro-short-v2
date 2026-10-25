// v7.7 selection-bias tests. Every threshold here comes from the forensic
// audit of 172 closed trades, so each test records the evidence it guards.
//
// The finding these defend: the bot's pre-filter selects for MOVEMENT,
// movement scales with ATR, and the high-ATR cohort is where the losses
// are. Mega-caps (3.57% avg ATR) were the only profitable bucket (+$202.99,
// 68% win) at just 11% of trades; semis (7.58% ATR) took 40% and lost
// $439.46. The fixes widen the gate so calm names get evaluated, and cap
// the top end so volatile ones stop crowding them out of the ranking.
//
// NOTE ON CONFIG: reads the RESOLVED config rather than assuming its own
// process.env.DT_* overrides applied — config is a shared singleton.
const fs = require("fs");
const path = require("path");
const config = require("../src/config");
const momentumScanner = require("../src/strategies/momentum-scanner");
const sectorMap = require("../src/strategies/sector-map");
const ethics = require("../src/strategies/ethics-filter");

module.exports = {
  name: "selection bias v7.7 (ATR ceiling, move gate, per-symbol sizing)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass });

    // ══ VOLATILITY CEILING ════════════════════════════════════════════
    // ATR<5%: 55 trades, 56% win, +$31.13 | ATR>=7%: 67, 43%, -$280.88
    check(
      "atr ceiling: configured and set at the evidence boundary",
      config.maxEntryAtrPct > 0 && config.maxEntryAtrPct <= 7.0,
    );

    const highAtr = momentumScanner.scoreEnrichedCandidate(
      {
        symbol: "FAKE",
        currentPrice: 100,
        atrPercent: 9.5, // the losing cohort
        priceChangePercent: 3,
        rsi: 65,
        vwap: 99,
        volumeRatio: 2,
        recentIntradayHigh: 99,
        source: "WATCHLIST",
      },
      0.3,
      { regime: "TRENDING" },
      null,
    );
    check(
      "atr ceiling: a 9.5% ATR name is rejected",
      highAtr.rejected === true && /ATR/.test(highAtr.rejectReason),
    );

    const lowAtr = momentumScanner.scoreEnrichedCandidate(
      {
        symbol: "FAKE2",
        currentPrice: 100,
        atrPercent: 3.4, // mega-cap-like, the profitable cohort
        priceChangePercent: 3,
        rsi: 65,
        vwap: 99,
        volumeRatio: 2,
        recentIntradayHigh: 99,
        source: "WATCHLIST",
      },
      0.3,
      { regime: "TRENDING" },
      null,
    );
    check(
      "atr ceiling: a 3.4% ATR name is NOT rejected on volatility",
      !(lowAtr.rejected && /ATR/.test(lowAtr.rejectReason || "")),
    );
    check(
      "atr ceiling: unknown ATR does not block (never reject on missing data)",
      (() => {
        const r = momentumScanner.scoreEnrichedCandidate(
          {
            symbol: "FAKE3",
            currentPrice: 100,
            atrPercent: null,
            priceChangePercent: 3,
            rsi: 65,
            vwap: 99,
            volumeRatio: 2,
            recentIntradayHigh: 99,
            source: "WATCHLIST",
          },
          0.3,
          { regime: "TRENDING" },
          null,
        );
        return !(r.rejected && /ATR/.test(r.rejectReason || ""));
      })(),
    );

    // ══ MOVE GATE ═════════════════════════════════════════════════════
    // The two hardcoded 1.0% thresholds are now configurable, but the
    // value is deliberately HELD at 1.0 after testing.
    //
    // Lowering it to 0.6 was tried and REVERTED: the 0.6-1.0% band has
    // zero historical trades (so history is silent), and the adjacent
    // 1-2% band already loses money at -$1.76/trade. Loosening would have
    // manufactured weaker setups rather than better access to good ones.
    check(
      "move gate: pre-filter threshold is exposed as config",
      typeof config.prefilterMinMovePct === "number",
    );
    check(
      "move gate: held at 1.0% — loosening was tested and reverted",
      config.prefilterMinMovePct >= 1.0,
    );
    check(
      "move gate: momentum-surge threshold likewise held at 1.0%",
      config.momentumSurgeMinMovePct >= 1.0,
    );

    // A 0.7% mover must still be filtered out — that band is unproven and
    // its neighbour loses money.
    // volumeRatio null = "not measured yet", the real state at pre-filter
    // time (it is only computed later during enrichment).
    const weakMover = momentumScanner.prefilterCandidates({
      MSFT: {
        symbol: "MSFT",
        currentPrice: 503,
        priceChangePercent: 0.7,
        dayOpen: 500,
        previousClose: 500,
        volumeRatio: null,
      },
    });
    check(
      "move gate: a 0.7% mover is correctly still excluded",
      weakMover.length === 0,
    );

    // ══ VOLATILITY-NORMALIZED MOVE (the better idea, shipped OFF) ══════
    // move/ATR >= 1.0 was the strongest single filter found anywhere:
    // 45 trades, 62% win, +$315.48. Every band below 1.0 lost money.
    // Default 0 (disabled) because enabling it cuts trade count ~74%.
    check(
      "move/ATR: the normalized gate is available as config",
      typeof config.minMoveToAtrRatio === "number",
    );
    check(
      "move/ATR: disabled by default (it conflicts with trading MORE)",
      config.minMoveToAtrRatio === 0,
    );
    // When enabled it must actually reject a sub-threshold move.
    const savedRatio = config.minMoveToAtrRatio;
    config.minMoveToAtrRatio = 1.0;
    const weakRelative = momentumScanner.scoreEnrichedCandidate(
      {
        symbol: "FAKE4",
        currentPrice: 100,
        atrPercent: 4.0,
        priceChangePercent: 1.2, // only 0.3x its own daily range
        rsi: 65,
        vwap: 99,
        volumeRatio: 2,
        recentIntradayHigh: 99,
        source: "WATCHLIST",
      },
      0.3,
      { regime: "TRENDING" },
      null,
    );
    config.minMoveToAtrRatio = savedRatio;
    check(
      "move/ATR: when enabled, a 0.3x-of-own-range move is rejected",
      weakRelative.rejected === true &&
        /daily range/.test(weakRelative.rejectReason || ""),
    );
    const tooQuiet = momentumScanner.prefilterCandidates({
      X: {
        symbol: "X",
        currentPrice: 100,
        priceChangePercent: 0.1,
        dayOpen: 100,
        previousClose: 100,
        volumeRatio: 1,
      },
    });
    check(
      "move gate: a genuinely flat 0.1% name is still filtered out",
      tooQuiet.length === 0,
    );

    // ══ RANKING HEADROOM ══════════════════════════════════════════════
    // Candidates are sorted by score and sliced to maxCandidates, and score
    // rises with ATR — so without more slots the new calm names would rank
    // below the semis and be cut before reaching the AI.
    check(
      "ranking: candidate slots raised so diversification survives the cut",
      config.maxCandidates >= 12,
    );

    // ══ WATCHLIST ═════════════════════════════════════════════════════
    const wl = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../watchlist-daytrade.json"),
        "utf8",
      ),
    );
    const symbols = wl.stocks.map((s) => s.symbol);

    check("watchlist: RIVN removed", !symbols.includes("RIVN"));
    check("watchlist: TSLA retained", symbols.includes("TSLA"));
    const tsla = wl.stocks.find((s) => s.symbol === "TSLA");
    check(
      "watchlist: TSLA carries a reduced sizeMultiplier",
      tsla && tsla.sizeMultiplier > 0 && tsla.sizeMultiplier < 1,
    );
    check(
      "watchlist: no duplicate symbols",
      new Set(symbols).size === symbols.length,
    );
    check(
      "watchlist: MSFT still present (it was profitable — 6 trades, +$46.95)",
      symbols.includes("MSFT"),
    );
    check("watchlist: MELI added", symbols.includes("MELI"));
    // v10.1: CVX was kept off because the bare "CVX" on eToro is a crypto.
    // The NYSE share is listed as "CVX.US", which the resolver now finds, so
    // CVX is on the watchlist as an energy name (owner request, 2026-10-25).
    check(
      "watchlist: CVX present as energy (resolves to the NYSE share CVX.US, not the crypto)",
      symbols.includes("CVX"),
    );

    // Diversification is real, not cosmetic: buckets beyond tech exist.
    const buckets = new Set(wl.stocks.map((s) => s.bucket));
    ["healthcare", "energy", "industrials", "consumer", "automotive", "transport"].forEach(
      (b) => {
        check("watchlist: bucket '" + b + "' present", buckets.has(b));
      },
    );
    // Toyota/Honda/Ferrari are listed on eToro but isCurrentlyTradable=false,
    // so adding them would produce orders that get rejected at execution.
    ["TM", "HMC", "RACE", "STLA"].forEach((s) => {
      check(
        "watchlist: " + s + " correctly NOT added (not tradeable on eToro)",
        !symbols.includes(s),
      );
    });
    check(
      "discovery: dollar-volume floor raised enough to filter micro-cap pumps",
      config.minAverageDollarVolume >= 10000000,
    );
    check(
      "watchlist: non-tech names are a meaningful share, not tokens",
      wl.stocks.filter((s) =>
        ["healthcare", "energy", "industrials", "consumer", "materials", "telecom"].includes(
          s.bucket,
        ),
      ).length >= 10,
    );

    // Every symbol must resolve to a real bucket for the concentration guard.
    const unmapped = symbols.filter((s) => !sectorMap.getStaticBucket(s));
    check(
      "watchlist: every symbol maps to a static sector bucket" +
        (unmapped.length ? " (unmapped: " + unmapped.join(",") + ")" : ""),
      unmapped.length === 0,
    );

    // ══ ETHICS / SCREENING ════════════════════════════════════════════
    // No added name may be on the blocklist, and the blocklist must now
    // actually cover the categories that were requested.
    const blocked = symbols.filter((s) => ethics.isBlockedStatic(s));
    check(
      "screening: no watchlist symbol is on the exclusion list" +
        (blocked.length ? " (blocked: " + blocked.join(",") + ")" : ""),
      blocked.length === 0,
    );
    check(
      "screening: tobacco is now excluded",
      ethics.isBlockedStatic("MO") && ethics.isBlockedStatic("PM"),
    );
    check(
      "screening: interest-based banking is now excluded",
      ethics.isBlockedStatic("JPM") && ethics.isBlockedStatic("GS"),
    );
    check(
      "screening: insurance is now excluded",
      ethics.isBlockedStatic("UNH") && ethics.isBlockedStatic("PGR"),
    );
    check(
      "screening: crypto-primary businesses are excluded",
      ethics.isBlockedStatic("COIN") && ethics.isBlockedStatic("MARA"),
    );
    check(
      "screening: gambling/alcohol still excluded (unchanged)",
      ethics.isBlockedStatic("DKNG") && ethics.isBlockedStatic("BUD"),
    );

    return results;
  },
};
