// v7 AI decision-layer tests: response parsing, the reviewer's deterministic
// guardrails, and the precedence rule that keeps a queued AI directive from
// ever displacing hard risk management.
//
// Nothing here makes a network call. applyReviewDecision only reaches Finnhub
// on the EXTEND *success* path, so every EXTEND case below is one that
// returns before that point.
//
// NOTE ON CONFIG: reads the RESOLVED config rather than assuming its own
// process.env.DT_* overrides applied — config is a shared singleton
// evaluated once by whichever test file required it first.
const screener = require("../src/models/ai-screener");
const reviewer = require("../src/models/ai-position-reviewer");
const riskManager = require("../src/strategies/risk-manager");
const config = require("../src/config");

const MIN = 60000;

function freshMeta(overrides) {
  return Object.assign(
    {
      tradeType: "DAY",
      entryPrice: 100,
      stopPrice: 97,
      targetT1: 110,
      targetT2: 120,
      // Peak deliberately kept close to the test prices: a wide gap between
      // peak and current price legitimately trips MFE_GIVEBACK, and these
      // cases need the engine to be in its quiet HOLD state so the
      // directive-precedence behaviour is what is actually under test.
      peakPrice: 100.5,
      peakSetAt: Date.now() - 5 * MIN,
      openedAt: Date.now() - 10 * MIN,
      partialDone: false,
      plan: { stopDistancePct: 3.0 },
    },
    overrides || {},
  );
}

function review(action, confidence, analysis) {
  return {
    symbol: "TEST",
    action,
    confidence,
    reasoning: "test",
    analysis: analysis || {},
  };
}

module.exports = {
  name: "ai-decision v7 (parsing, guardrails, directive precedence)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass });

    // ── JSON extraction robustness ───────────────────────────────────────
    // In v6 any of these threw inside JSON.parse. Because the screener is
    // fail-closed, that silently SKIPPED the plan — and when every plan in a
    // scan hit it at once the bot stopped trading while looking healthy.
    const clean = '{"decision":"TAKE","confidence":7}';
    check(
      "parse: clean JSON",
      screener.extractJsonObject(clean)?.decision === "TAKE",
    );
    check(
      "parse: markdown-fenced JSON",
      screener.extractJsonObject("```json\n" + clean + "\n```")?.decision ===
        "TAKE",
    );
    check(
      "parse: bare fence without a language tag",
      screener.extractJsonObject("```\n" + clean + "\n```")?.decision === "TAKE",
    );
    check(
      "parse: leading prose before the object",
      screener.extractJsonObject("Here is my verdict:\n" + clean)?.decision ===
        "TAKE",
    );
    check(
      "parse: trailing prose after the object",
      screener.extractJsonObject(clean + "\n\nLet me know if you need more.")
        ?.decision === "TAKE",
    );
    check(
      "parse: truncated JSON returns null rather than throwing",
      screener.extractJsonObject('{"decision":"TAKE","conf') === null,
    );
    check(
      "parse: empty input returns null",
      screener.extractJsonObject("") === null,
    );
    check(
      "parse: prose with no object at all returns null",
      screener.extractJsonObject("I cannot answer that.") === null,
    );
    check(
      "parse: reviewer shares the same hardened extractor",
      reviewer.extractJsonObject("```json\n" + clean + "\n```")?.decision ===
        "TAKE",
    );

    // ── Screener: stock-specific sector context ──────────────────────────
    const brief = {
      sectorLeaders: [{ bucket: "semi", changePct: 1.8 }],
      sectorLaggards: [{ bucket: "healthcare", changePct: -0.9 }],
    };
    check(
      "sector momentum: a leading sector is reported as LEADING",
      screener.describeSectorMomentum(brief, "semi").startsWith("LEADING"),
    );
    check(
      "sector momentum: a lagging sector is reported as LAGGING",
      screener.describeSectorMomentum(brief, "healthcare").startsWith("LAGGING"),
    );
    check(
      "sector momentum: an unmapped sector says so rather than implying flat",
      screener.describeSectorMomentum(brief, "crypto").includes("no decisive"),
    );
    check(
      "sector momentum: a missing brief reports unavailable",
      screener.describeSectorMomentum(null, "semi") === "unavailable",
    );

    // ── Reviewer: analysis normalisation ─────────────────────────────────
    const garbage = reviewer.normaliseAnalysis({
      thesisStatus: "VIBES",
      momentum: "SIDEWAYS-ISH",
      lossType: "kind of bad",
      recoveryProbabilityPct: 480,
      expectedHoldingPeriod: "forever",
      maxAcceptableDrawdownPct: -12,
      reviewIntervalMinutes: 999999,
      scaleInCase: "MAYBE",
    });
    check(
      "normalise: an out-of-enum thesis falls back to UNPROVEN",
      garbage.thesisStatus === "UNPROVEN",
    );
    check(
      "normalise: an out-of-enum momentum falls back to STEADY",
      garbage.momentum === "STEADY",
    );
    check(
      "normalise: an out-of-enum loss type falls back to UNCLEAR",
      garbage.lossType === "UNCLEAR",
    );
    check(
      "normalise: an impossible probability is clamped to 100",
      garbage.recoveryProbabilityPct === 100,
    );
    check(
      "normalise: a negative drawdown is clamped to 0",
      garbage.maxAcceptableDrawdownPct === 0,
    );
    check(
      "normalise: an absurd review interval is clamped to the weekly ceiling",
      garbage.reviewIntervalMinutes === 10080,
    );
    check(
      "normalise: a missing numeric stays null rather than becoming 0",
      reviewer.normaliseAnalysis({}).recoveryProbabilityPct === null,
    );

    // ── Reviewer guardrails: TAKE_PARTIAL ────────────────────────────────
    const partialFloor = config.reviewerMinConfidenceToTakePartial;

    let meta = freshMeta();
    let applied = await reviewer.applyReviewDecision(
      meta,
      review("TAKE_PARTIAL", partialFloor, {}),
      95, // below the 100 entry — a losing position
      0,
    );
    check(
      "TAKE_PARTIAL: refused on a losing position",
      !applied.applied && applied.description.includes("not in profit"),
    );
    check(
      "TAKE_PARTIAL: refusal queues no directive",
      meta.pendingReviewerAction === undefined,
    );

    meta = freshMeta();
    applied = await reviewer.applyReviewDecision(
      meta,
      review("TAKE_PARTIAL", Math.max(1, partialFloor - 1), {}),
      105,
      0,
    );
    check(
      "TAKE_PARTIAL: refused below the confidence floor",
      !applied.applied && applied.description.includes("confidence"),
    );

    meta = freshMeta({ partialDone: true });
    applied = await reviewer.applyReviewDecision(
      meta,
      review("TAKE_PARTIAL", partialFloor, {}),
      105,
      0,
    );
    check(
      "TAKE_PARTIAL: refused when a partial was already banked",
      !applied.applied && applied.description.includes("already banked"),
    );

    meta = freshMeta();
    applied = await reviewer.applyReviewDecision(
      meta,
      review("TAKE_PARTIAL", partialFloor, {}),
      105,
      0,
    );
    check(
      "TAKE_PARTIAL: a valid request queues a PARTIAL directive",
      applied.applied &&
        meta.pendingReviewerAction?.type === "PARTIAL" &&
        meta.pendingReviewerAction.fraction ===
          config.reviewerTakePartialFraction,
    );

    // ── Reviewer guardrails: CLOSE ───────────────────────────────────────
    const closeFloor = config.reviewerMinConfidenceToClose;

    meta = freshMeta();
    applied = await reviewer.applyReviewDecision(
      meta,
      review("CLOSE", Math.max(1, closeFloor - 1), {}),
      95,
      0,
    );
    check(
      "CLOSE: refused below the confidence floor",
      !applied.applied && applied.description.includes("confidence"),
    );
    check(
      "CLOSE: refusal queues no directive",
      meta.pendingReviewerAction === undefined,
    );

    meta = freshMeta();
    applied = await reviewer.applyReviewDecision(
      meta,
      review("CLOSE", closeFloor, {}),
      95,
      0,
    );
    check(
      "CLOSE: a confident request queues an EXIT directive with its own reason",
      applied.applied &&
        meta.pendingReviewerAction?.type === "EXIT" &&
        meta.pendingReviewerAction.reason === "AI_REVIEW_CLOSE",
    );

    // ── Reviewer: TIGHTEN honours its own stated drawdown ────────────────
    meta = freshMeta({ lockedFloor: 97 });
    applied = await reviewer.applyReviewDecision(
      meta,
      review("TIGHTEN", 8, { maxAcceptableDrawdownPct: 1.0 }),
      110,
      0,
    );
    check(
      "TIGHTEN: uses the model's stated maximum acceptable drawdown when sane",
      applied.applied &&
        Math.abs(meta.lockedFloor - 110 * 0.99) < 0.01 &&
        applied.description.includes("stated"),
    );

    // An absurdly tight number must be clamped, not honoured — otherwise the
    // stop lands inside normal spread and guarantees an instant stop-out.
    meta = freshMeta({ lockedFloor: 97 });
    await reviewer.applyReviewDecision(
      meta,
      review("TIGHTEN", 8, { maxAcceptableDrawdownPct: 0.01 }),
      110,
      0,
    );
    const clampedDistance = (110 - meta.lockedFloor) / 110;
    check(
      "TIGHTEN: an absurdly tight stated drawdown is clamped to the configured floor",
      Math.abs(clampedDistance - config.reviewerTightenMinStopPct) < 0.0001,
    );

    // A stated drawdown WIDER than the plan stop must be ignored in favour of
    // the default factor — TIGHTEN may only ever tighten.
    meta = freshMeta({ lockedFloor: 97 });
    applied = await reviewer.applyReviewDecision(
      meta,
      review("TIGHTEN", 8, { maxAcceptableDrawdownPct: 25 }),
      110,
      0,
    );
    check(
      "TIGHTEN: a stated drawdown wider than the plan stop falls back to the default factor",
      applied.applied && applied.description.includes("default tighten factor"),
    );

    meta = freshMeta({ lockedFloor: 120 }); // floor already above any proposal
    applied = await reviewer.applyReviewDecision(
      meta,
      review("TIGHTEN", 8, { maxAcceptableDrawdownPct: 1.0 }),
      110,
      0,
    );
    check(
      "TIGHTEN: never loosens an existing floor",
      !applied.applied && meta.lockedFloor === 120,
    );

    // ── Reviewer: estimates are recorded regardless of action ────────────
    meta = freshMeta();
    await reviewer.applyReviewDecision(
      meta,
      review("HOLD", 5, {
        recoveryProbabilityPct: 65,
        expectedUpsideRemainingPct: 3.2,
        expectedHoldingPeriod: "1-2_DAYS",
        scaleInCase: "STRONG",
      }),
      101,
      0,
    );
    check(
      "estimates: a plain HOLD still records the review for later scoring",
      meta.lastReview?.recoveryProbabilityPct === 65 &&
        meta.lastReview.expectedHoldingPeriod === "1-2_DAYS",
    );
    check(
      "estimates: a STRONG scale-in case is recorded but queues no order",
      meta.lastReview.scaleInCase === "STRONG" &&
        meta.pendingReviewerAction === undefined,
    );

    // ── Directive precedence in the exit engine ──────────────────────────
    // Engine would HOLD → the queued directive applies.
    meta = freshMeta({
      pendingReviewerAction: { type: "EXIT", reason: "AI_REVIEW_CLOSE" },
    });
    let decision = riskManager.decidePositionAction(meta, 101);
    check(
      "precedence: a queued CLOSE applies when the engine would otherwise hold",
      decision.action === "EXIT" && decision.reason === "AI_REVIEW_CLOSE",
    );

    // Engine produces a hard stop exit → the engine's reason must win, so
    // the trade is recorded (and shadowed) as the stop-out it really was.
    meta = freshMeta({
      stopPrice: 97,
      stopBreachTicks: 99, // past any confirmation requirement
      pendingReviewerAction: { type: "EXIT", reason: "AI_REVIEW_CLOSE" },
    });
    decision = riskManager.decidePositionAction(meta, 90); // deep below the stop
    check(
      "precedence: a hard stop-loss outranks a queued CLOSE",
      decision.action === "EXIT" && decision.reason === "STOP_LOSS",
    );

    // Queued PARTIAL applies on a hold, at breakeven-or-better.
    meta = freshMeta({
      pendingReviewerAction: {
        type: "PARTIAL",
        reason: "AI_REVIEW_PARTIAL",
        fraction: 0.5,
      },
    });
    decision = riskManager.decidePositionAction(meta, 101);
    check(
      "precedence: a queued PARTIAL applies when the engine would hold",
      decision.action === "PARTIAL" &&
        decision.reason === "AI_REVIEW_PARTIAL" &&
        decision.fraction === 0.5,
    );
    check(
      "precedence: a queued PARTIAL banks at breakeven or better",
      decision.floorOnSuccess >= meta.entryPrice,
    );

    // Stale directive: the tier was banked between review and execution.
    meta = freshMeta({
      partialDone: true,
      pendingReviewerAction: {
        type: "PARTIAL",
        reason: "AI_REVIEW_PARTIAL",
        fraction: 0.5,
      },
    });
    decision = riskManager.decidePositionAction(meta, 101);
    check(
      "precedence: a queued PARTIAL is dropped once the tier is already banked",
      decision.reason !== "AI_REVIEW_PARTIAL",
    );

    // No directive → completely unchanged behaviour.
    meta = freshMeta();
    decision = riskManager.decidePositionAction(meta, 101);
    check(
      "precedence: with no directive the engine behaves exactly as before",
      decision.action === "HOLD",
    );

    return results;
  },
};
