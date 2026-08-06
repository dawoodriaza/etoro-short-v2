// v7 market-context tests: the shared market brief that feeds BOTH AI
// prompts. Focus is on the two properties that actually protect the model
// from hallucinating — deterministic risk-tone classification (identical
// inputs must always produce the identical tag) and honest rendering of
// absent data (a missing field must never render as a zero).
//
// NOTE ON CONFIG: like the other suites here, this reads the RESOLVED config
// values rather than assuming its own process.env.DT_* overrides applied —
// config is a shared singleton evaluated once, by whichever test file
// required it first, so overrides set here would be silently ignored.
const marketContext = require("../src/strategies/market-context");
const config = require("../src/config");

function quotesFrom(changes) {
  const quotes = {};
  changes.forEach((change, index) => {
    quotes["SYM" + index] = { priceChangePercent: change };
  });
  return quotes;
}

module.exports = {
  name: "market-context v7 (shared market brief)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass });

    const minBreadth = config.marketBriefMinBreadthSample;
    const minTone = config.marketBriefMinToneSignals;

    // ── Breadth ──────────────────────────────────────────────────────────
    const tooFew = quotesFrom(new Array(Math.max(0, minBreadth - 1)).fill(1.0));
    check(
      "breadth: sample below the minimum returns null, not a fake percentage",
      marketContext.computeWatchlistBreadth(tooFew) === null,
    );

    const mixed = quotesFrom([2.0, 1.0, -1.0, -0.5, 0.5, 3.0]);
    const breadth = marketContext.computeWatchlistBreadth(mixed);
    check(
      "breadth: counts advancers correctly (4 of 6 up)",
      breadth !== null && breadth.advancers === 4 && breadth.total === 6,
    );
    check(
      "breadth: advancing percentage is rounded correctly (67%)",
      breadth !== null && breadth.advancingPct === 67,
    );

    // Non-numeric / missing changes must be excluded, not coerced to 0.
    const withHoles = {
      A: { priceChangePercent: 1.0 },
      B: { priceChangePercent: null },
      C: { priceChangePercent: undefined },
      D: { priceChangePercent: 2.0 },
      E: {},
      F: null,
      G: { priceChangePercent: -1.0 },
      H: { priceChangePercent: 0.5 },
      I: { priceChangePercent: 0.2 },
    };
    const holed = marketContext.computeWatchlistBreadth(withHoles);
    check(
      "breadth: null/undefined/missing changes are excluded, never counted as flat-zero",
      holed !== null && holed.total === 5 && holed.advancers === 4,
    );

    // ── Risk tone: determinism and honest abstention ─────────────────────
    const strongRiskOn = {
      spyChangePercent: 0.8,
      indexChanges: { QQQ: 1.1, IWM: 0.9 },
      breadth: { advancingPct: 72 },
      vix: 15,
    };
    const toneA = marketContext.classifyRiskTone(strongRiskOn);
    const toneB = marketContext.classifyRiskTone(strongRiskOn);
    check(
      "risk tone: unanimous positive inputs classify RISK_ON",
      toneA.tone === "RISK_ON",
    );
    check(
      "risk tone: identical inputs produce an identical tag (determinism)",
      JSON.stringify(toneA) === JSON.stringify(toneB),
    );

    const strongRiskOff = marketContext.classifyRiskTone({
      spyChangePercent: -1.2,
      indexChanges: { QQQ: -1.6, IWM: -2.0 },
      breadth: { advancingPct: 20 },
      vix: 31,
    });
    check(
      "risk tone: unanimous negative inputs classify RISK_OFF",
      strongRiskOff.tone === "RISK_OFF",
    );

    const conflicted = marketContext.classifyRiskTone({
      spyChangePercent: 0.4,
      indexChanges: { QQQ: 0.6, IWM: -0.7 },
      breadth: { advancingPct: 48 },
      vix: 22,
    });
    check(
      "risk tone: a split tape classifies MIXED rather than picking a side",
      conflicted.tone === "MIXED",
    );

    // Fewer available signals than the configured minimum → UNKNOWN.
    const starved = marketContext.classifyRiskTone({
      spyChangePercent: minTone > 1 ? 0.5 : undefined,
      indexChanges: {},
      breadth: null,
      vix: null,
    });
    check(
      "risk tone: too few signals abstains with UNKNOWN instead of guessing",
      starved.tone === "UNKNOWN",
    );
    check(
      "risk tone: abstention still reports how many signals it actually had",
      starved.availableSignals < minTone,
    );

    // A missing index must not be voted on at all (not treated as 0 = flat).
    const partial = marketContext.classifyRiskTone({
      spyChangePercent: 1.0,
      indexChanges: { QQQ: undefined, IWM: null },
      breadth: { advancingPct: 80 },
      vix: 14,
    });
    check(
      "risk tone: absent index values are not counted as signals",
      partial.availableSignals === 3,
    );

    // ── Sector ranking ───────────────────────────────────────────────────
    const threshold = config.sectorRotationMinChangePct;
    const ranked = marketContext.rankSectors({
      semi: threshold + 1.5,
      energy: threshold + 0.4,
      healthcare: -(threshold + 1.1),
      consumer: 0,
    });
    check(
      "sectors: only decisive movers become leaders",
      ranked.leaders.length === 2 && ranked.leaders[0].bucket === "semi",
    );
    check(
      "sectors: decisive decliners become laggards",
      ranked.laggards.length === 1 && ranked.laggards[0].bucket === "healthcare",
    );
    check(
      "sectors: a flat sector appears in neither list",
      !ranked.leaders.concat(ranked.laggards).some((s) => s.bucket === "consumer"),
    );
    check(
      "sectors: empty input is handled without throwing",
      marketContext.rankSectors(null).leaders.length === 0,
    );

    // ── Prompt rendering honesty ─────────────────────────────────────────
    const emptyBrief = {
      spyChangePercent: null,
      indexChanges: {},
      breadth: null,
      vix: null,
      tenYear: null,
      regime: "UNKNOWN",
      rangePct: null,
      sectorLeaders: [],
      sectorLaggards: [],
      riskTone: "UNKNOWN",
      riskToneDetail: { availableSignals: 0, riskOnVotes: 0, riskOffVotes: 0 },
    };
    const emptyText = marketContext.formatBriefForPrompt(emptyBrief);
    check(
      "rendering: a fully empty brief never prints a fabricated 0.00%",
      !emptyText.includes("0.00%"),
    );
    check(
      "rendering: absent indices render as n/a",
      emptyText.includes("QQQ n/a") && emptyText.includes("IWM n/a"),
    );
    check(
      "rendering: absent breadth says unavailable rather than omitting the line",
      emptyText.includes("BREADTH: unavailable"),
    );
    check(
      "rendering: absent rates say unavailable",
      emptyText.includes("RATES: unavailable"),
    );

    const fullBrief = {
      spyChangePercent: 0.42,
      indexChanges: { QQQ: 0.71, DIA: 0.12, IWM: -0.3 },
      breadth: { advancers: 12, decliners: 8, total: 20, advancingPct: 60 },
      vix: 17.3,
      tenYear: { value: 4.31, changeBps: 3.2, asOf: "2026-07-24" },
      regime: "TRENDING",
      rangePct: 0.94,
      sectorLeaders: [{ bucket: "semi", changePct: 1.8 }],
      sectorLaggards: [{ bucket: "healthcare", changePct: -0.9 }],
      riskTone: "RISK_ON",
      riskToneDetail: { availableSignals: 5, riskOnVotes: 4, riskOffVotes: 1 },
    };
    const fullText = marketContext.formatBriefForPrompt(fullBrief);
    check(
      "rendering: breadth is explicitly labelled as watchlist breadth, not the A/D line",
      fullText.includes("NOT the NYSE A/D line"),
    );
    check(
      "rendering: the risk tone is presented as code-computed and not to be re-derived",
      fullText.includes("computed by code") && fullText.includes("do not re-derive"),
    );
    check(
      "rendering: the whole brief stays compact (under 600 chars)",
      fullText.length < 600,
    );
    check(
      "rendering: a null brief degrades to a single honest line",
      marketContext.formatBriefForPrompt(null).includes("unavailable"),
    );

    return results;
  },
};
