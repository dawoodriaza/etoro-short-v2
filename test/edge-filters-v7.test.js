// v7.4 edge-filter tests. Every threshold here was derived from the
// 114-trade audit of 2026-08-06, so each test states the evidence it
// guards. If someone later loosens one of these, the test explains what
// it cost historically.
//
// NOTE ON CONFIG: reads the RESOLVED config rather than assuming its own
// process.env.DT_* overrides applied — config is a shared singleton.
const config = require("../src/config");
const sessionTiming = require("../src/strategies/session-timing");
const marketContext = require("../src/strategies/market-context");

// 2026-08-06 is a Thursday. Bahrain has no DST; ET is UTC-4 in August.
const etInstant = (hourET, minute = 0) =>
  new Date(Date.UTC(2026, 7, 6, hourET + 4, minute));

module.exports = {
  name: "edge filters v7.4 (score gate, dead zone, live volatility)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass });

    // ══ MINIMUM ENTRY SCORE ═══════════════════════════════════════════
    // Audit: score bands 0-49 (-$97.01), 50-64 (-$218.92) and 65-79
    // (-$160.31) all lost. Only 80+ made money (+$166.68).
    check(
      "score gate: a minimum entry score is configured",
      config.minEntryScore > 0,
    );
    check(
      "score gate: the floor sits at the boundary the audit identified (80)",
      config.minEntryScore >= 80,
    );
    check(
      "score gate: the floor is reachable — scores are capped at 100",
      config.minEntryScore <= 100,
    );
    // It must not collide with the loss-reentry ceiling, or a symbol could
    // be permanently untradeable after one loss.
    check(
      "score gate: does not exceed the re-entry ceiling (would deadlock re-entry)",
      config.minEntryScore <= config.reentryMaxRequiredScore,
    );

    // ══ OVERNIGHT DEAD ZONE ═══════════════════════════════════════════
    // Audit: all 16 trades entered 00:00-04:00 ET lost, -$170.05 at a 31%
    // win rate. The score gate did NOT rescue it — the 3 high-score
    // overnight trades went 0-for-3 at -$27.07 each, the worst of any
    // bucket in the study.
    check(
      "dead zone: enabled by default",
      config.overnightDeadZoneEnabled === true,
    );
    check(
      "dead zone: 00:00 ET is blocked",
      sessionTiming.isInOvernightDeadZone(etInstant(0, 0)),
    );
    check(
      "dead zone: 02:30 ET (mid-window) is blocked",
      sessionTiming.isInOvernightDeadZone(etInstant(2, 30)),
    );
    check(
      "dead zone: 03:59 ET is blocked",
      sessionTiming.isInOvernightDeadZone(etInstant(3, 59)),
    );

    // The windows the audit found PROFITABLE at score 80+ must stay open.
    // Blocking 24/5 wholesale would have discarded ~$56 of real profit.
    check(
      "dead zone: 04:00 ET pre-market is OPEN (+$12.25/trade at score 80+)",
      !sessionTiming.isInOvernightDeadZone(etInstant(4, 0)),
    );
    check(
      "dead zone: 07:00 ET pre-market is OPEN",
      !sessionTiming.isInOvernightDeadZone(etInstant(7, 0)),
    );
    check(
      "dead zone: 10:00 ET regular session is OPEN (+$3.46/trade at score 80+)",
      !sessionTiming.isInOvernightDeadZone(etInstant(10, 0)),
    );
    check(
      "dead zone: 18:00 ET after-hours is OPEN (+$15.17/trade, best average)",
      !sessionTiming.isInOvernightDeadZone(etInstant(18, 0)),
    );
    check(
      "dead zone: 23:00 ET is OPEN — the window ends at 04:00, it does not wrap",
      !sessionTiming.isInOvernightDeadZone(etInstant(23, 0)),
    );

    // ══ LIVE VOLATILITY (VXX) ═════════════════════════════════════════
    // Replaces a FRED VIX close measured 2 days stale on 2026-08-06.
    check(
      "volatility: VXX is in the batched index fetch (free — the call already runs)",
      Object.keys(marketContext.INDEX_ETFS).includes("VXX"),
    );
    check(
      "volatility: an expansion threshold is configured",
      typeof config.vxxExpansionPct === "number" && config.vxxExpansionPct > 0,
    );

    // Expansion = VXX up sharply AND SPY down. Either alone is not enough.
    const expanding = marketContext.classifyRiskTone({
      spyChangePercent: -0.8,
      indexChanges: { QQQ: -1.0, IWM: -1.2, VXX: 6.0 },
      breadth: { advancingPct: 30 },
      vix: 22,
      volatilityExpanding: true,
    });
    check(
      "volatility: an expansion event pushes tone to RISK_OFF",
      expanding.tone === "RISK_OFF",
    );
    check(
      "volatility: expansion counts as its own signal, not a free vote",
      expanding.availableSignals === 6,
    );

    const calm = marketContext.classifyRiskTone({
      spyChangePercent: 0.9,
      indexChanges: { QQQ: 1.1, IWM: 0.8, VXX: -4.0 },
      breadth: { advancingPct: 70 },
      vix: 15,
      volatilityExpanding: false,
    });
    check(
      "volatility: a calm tape still classifies RISK_ON",
      calm.tone === "RISK_ON",
    );
    check(
      "volatility: absent expansion data does not fabricate a signal",
      marketContext.classifyRiskTone({
        spyChangePercent: 0.5,
        indexChanges: { QQQ: 0.6, IWM: 0.4 },
        breadth: { advancingPct: 60 },
        vix: 16,
      }).availableSignals === 5,
    );

    // ══ v7.6 — VXX IS DIRECTION, NEVER A LEVEL ════════════════════════
    // VXX tracks VIX *futures*, bleeds under contango and has been
    // reverse-split repeatedly, so its price is meaningless as a fear
    // gauge — VXX at $20.51 does NOT mean VIX 20.51. The absolute level
    // must come from FRED; VXX contributes direction only.
    const vxxBrief = marketContext.formatBriefForPrompt({
      spyChangePercent: -0.9,
      indexChanges: { QQQ: -1.1, IWM: -1.3, VXX: 7.0 },
      breadth: { advancers: 5, decliners: 15, total: 20, advancingPct: 25 },
      vix: 16.5,
      vxxChangePercent: 7.0,
      volatilityExpanding: true,
      volatilityCollapsing: false,
      volatilityConfirmedByPrice: true,
      tenYear: null,
      regime: "TRENDING",
      rangePct: 1.6,
      sectorLeaders: [],
      sectorLaggards: [],
      riskTone: "RISK_OFF",
      riskToneDetail: { availableSignals: 6, riskOnVotes: 0, riskOffVotes: 6 },
    });
    check(
      "vxx: the real VIX LEVEL still comes from FRED, not from VXX",
      vxxBrief.includes("VIX 16.5"),
    );
    check(
      "vxx: the model is told explicitly that VXX's price is not a VIX level",
      vxxBrief.includes("NOT a VIX level"),
    );
    check(
      "vxx: the FRED level is still labelled as lagging",
      vxxBrief.includes("lags 1-3 days"),
    );
    check(
      "vxx: a confirmed expansion says the index confirmed it",
      vxxBrief.includes("confirmed by a falling index"),
    );

    // Expansion no longer requires SPY to be red — vol often bids up
    // BEFORE the index turns, which was the most valuable missed case.
    const earlyWarning = marketContext.classifyRiskTone({
      spyChangePercent: 0.3,
      indexChanges: { QQQ: 0.2, IWM: 0.1, VXX: 6.0 },
      breadth: { advancingPct: 58 },
      vix: 17,
      volatilityExpanding: true,
      volatilityCollapsing: false,
      volatilityConfirmedByPrice: false,
    });
    check(
      "vxx: a VXX spike counts even while the index is still green",
      earlyWarning.riskOffVotes >= 1,
    );

    const confirmed = marketContext.classifyRiskTone({
      spyChangePercent: -1.2,
      indexChanges: { QQQ: -1.4, IWM: -1.6, VXX: 8.0 },
      breadth: { advancingPct: 20 },
      vix: 22,
      volatilityExpanding: true,
      volatilityCollapsing: false,
      volatilityConfirmedByPrice: true,
    });
    check(
      "vxx: expansion CONFIRMED by a falling index carries extra weight",
      confirmed.riskOffVotes > earlyWarning.riskOffVotes,
    );

    // The contango dead-band: routine decay must not read as a vol crush.
    const decayDrift = -0.3;
    check(
      "vxx: routine futures-roll decay is below the collapse threshold",
      decayDrift > -(config.vxxExpansionPct + config.vxxContangoDriftPct),
    );
    check(
      "vxx: a contango drift allowance is configured",
      config.vxxContangoDriftPct > 0,
    );
    const steadyBrief = marketContext.formatBriefForPrompt({
      spyChangePercent: 0.4,
      indexChanges: { QQQ: 0.3, IWM: 0.2, VXX: decayDrift },
      breadth: null,
      vix: 16.5,
      vxxChangePercent: decayDrift,
      volatilityExpanding: false,
      volatilityCollapsing: false,
      volatilityConfirmedByPrice: false,
      tenYear: null,
      regime: "TRENDING",
      rangePct: 0.7,
      sectorLeaders: [],
      sectorLaggards: [],
      riskTone: "MIXED",
      riskToneDetail: { availableSignals: 4, riskOnVotes: 2, riskOffVotes: 2 },
    });
    check(
      "vxx: a small negative move is labelled decay, NOT falling volatility",
      steadyBrief.includes("futures-roll decay, not signal"),
    );

    // ══ CROSS-ASSET-CLASS TICKER COLLISION ════════════════════════════
    // Measured 2026-08-06: "DIA" resolved to instrumentId 100580 — a $0.11
    // crypto on eToro's Digital Currency exchange — not the ~$450 Dow ETF,
    // which eToro does not list under that symbol. It produced a fake
    // "Dow +5.30%" in the AI prompts, and because the SAME resolver
    // supplies instrumentIds for ORDERS, a colliding watchlist ticker
    // would have put real money on the wrong asset.
    check(
      "collision: DIA is no longer treated as an index (eToro lists only the crypto)",
      !Object.keys(marketContext.INDEX_ETFS).includes("DIA"),
    );
    check(
      "collision: the surviving index set is all genuine equity ETFs",
      Object.keys(marketContext.INDEX_ETFS).every((s) =>
        ["QQQ", "IWM", "VXX"].includes(s),
      ),
    );

    // The brief must not print a Dow line it cannot source.
    const noDia = marketContext.formatBriefForPrompt({
      spyChangePercent: 0.4,
      indexChanges: { QQQ: 0.2, IWM: -0.1, VXX: -1.0 },
      breadth: null,
      vix: 16,
      vxxChangePercent: -1.0,
      volatilityExpanding: false,
      tenYear: null,
      regime: "TRENDING",
      rangePct: 0.8,
      sectorLeaders: [],
      sectorLaggards: [],
      riskTone: "MIXED",
      riskToneDetail: { availableSignals: 4, riskOnVotes: 2, riskOffVotes: 2 },
    });
    check(
      "collision: the brief no longer shows a DIA/Dow figure at all",
      !noDia.includes("DIA"),
    );

    // ══ PROMPT RENDERING ══════════════════════════════════════════════
    // The model must never read the lagging FRED close as current.
    const brief = {
      spyChangePercent: -0.8,
      indexChanges: { QQQ: -1.0, DIA: -0.6, IWM: -1.2, VXX: 6.0 },
      breadth: { advancers: 6, decliners: 14, total: 20, advancingPct: 30 },
      vix: 22.4,
      vxxChangePercent: 6.0,
      volatilityExpanding: true,
      tenYear: { value: 4.31, changeBps: 3.2, asOf: "2026-08-04" },
      regime: "TRENDING",
      rangePct: 1.4,
      sectorLeaders: [],
      sectorLaggards: [{ bucket: "semi", changePct: -2.2 }],
      riskTone: "RISK_OFF",
      riskToneDetail: { availableSignals: 6, riskOnVotes: 0, riskOffVotes: 6 },
    };
    const text = marketContext.formatBriefForPrompt(brief);
    check(
      "prompt: the LIVE VXX reading appears",
      text.includes("VXX +6.00%"),
    );
    check(
      "prompt: expansion is called out explicitly",
      text.includes("VOLATILITY EXPANDING NOW"),
    );
    check(
      "prompt: the FRED VIX close is labelled as lagging, not current",
      text.includes("lags 1-3 days"),
    );

    return results;
  },
};
