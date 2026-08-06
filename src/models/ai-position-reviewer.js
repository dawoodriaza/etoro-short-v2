// src/models/ai-position-reviewer.js
//
// TIER-2 AI: THE DAILY POSITION REVIEWER — one Haiku call per open position,
// once per day (Mon-Thu at config.reviewerHourET, before the EOD close).
// The AI never sets prices; it picks ONE action and the price math stays
// deterministic in applyReviewDecision() below.
//
// ═══════════════════════════════════════════════════════════════════════
// v7 (2026-07-25) — DYNAMIC TRADE MANAGEMENT.
//
// v6 asked one question: should this DAY position survive tonight?
// Three actions, no estimates, no diagnosis of WHY a position was losing.
// Exits were otherwise purely mechanical — a clock or a price level.
//
// v7 makes this an actual position-management seat:
//
//   ACTIONS  EXTEND · HOLD · TIGHTEN · TAKE_PARTIAL (new) · CLOSE (new)
//
//   ESTIMATES the model must produce before acting — expected holding
//   period, probability of recovery, upside remaining, maximum acceptable
//   drawdown, and a recommended review interval. These turn "hold or fold"
//   into a probability-weighted judgement that lands in the journal where
//   it can be scored against what actually happened.
//
//   LOSS DIAGNOSIS  temporary vs structural, plus concrete reversal
//   evidence — the difference between a position worth time and one worth
//   capital preservation.
//
// TWO THINGS ARE REPORTED BUT DELIBERATELY NOT EXECUTED:
//   scaleInCase and averagingDownCase. Adding to an open position is not a
//   prompt change — it needs a re-entry risk budget, capital-manager and
//   slot plumbing, and it directly contradicts the fixed-risk-per-trade
//   architecture every stop and size in this bot is derived from. The
//   model's assessment is captured and surfaced so the evidence
//   accumulates; wiring it to an order is a separate, deliberate decision.
//   See docs/ai-prompt-review-2026-07-25.md.
//
// HOW THE NEW ACTIONS REACH THE MARKET: TAKE_PARTIAL and CLOSE queue a
// directive on the position meta (pendingReviewerAction). The ordinary
// 1-minute exit monitor executes it through the same order + accounting
// path as every other exit — see decidePositionAction() in risk-manager.js.
// A hard stop always takes precedence over a queued directive.
//
// Fail-safe unchanged: any error → HOLD (the existing plan is the safe
// default) plus a throttled Telegram alert, so a dead reviewer is visible.
require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const { logger } = require("../logger");
const config = require("../config");
const finnhub = require("../data-sources/finnhub");
const alerts = require("../notifications/alerts");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VALID_ACTIONS = ["EXTEND", "HOLD", "TIGHTEN", "TAKE_PARTIAL", "CLOSE"];

// ── SYSTEM PROMPT ──────────────────────────────────────────────────────────
// Invariant across every position reviewed in a cycle.
const REVIEWER_SYSTEM_PROMPT = `You are a portfolio manager on an institutional trading desk, running the daily risk review of open positions ~45 minutes before the US close. Your job is what to do with risk already carried, not whether it should have been taken.

FIXED, NOT YOURS TO SET: entry, size, target ladder, stop formula. You choose an ACTION; the system does the price math. A hard stop-loss stays live at all times, including through any extension you grant.

METHOD — assess separately, then decide:
- MARKET: does the tape support carrying this risk overnight or longer? Use TONE, index alignment, breadth, volatility.
- POSITION: what has this trade actually done, against entry, against its peak, against stop and targets? A large give-back from the peak is exhaustion evidence; holding near the peak into the close is continuation evidence.
- RISK: what is still at stake, how much time has it consumed, what does a negative headline change?
- DECIDE: market and risk can override an attractive chart; a good chart cannot rescue a broken market read.

DIAGNOSE A LOSING POSITION EXPLICITLY: a loss is TEMPORARY when the tape explains it — market or sector down with it, unremarkable volume, structure intact, no adverse news. It is STRUCTURAL when the position falls while its market and sector do not, a negative catalyst appeared, or the setup plainly broke. Temporary losses can deserve time; structural losses only deepen with it. If the evidence does not separate them say UNCLEAR, and treat UNCLEAR as nearer structural when setting confidence.

ACTIONS — choose exactly one:
- HOLD: working or unresolved; the default when nothing changed. For a DAY position this means it closes at today's EOD as planned.
- EXTEND: DAY positions only, and only with real evidence the move persists 1-3 more sessions — trend intact, closing near highs, no exhaustion, no negative catalyst. It then holds overnight as a swing. If in doubt do NOT extend.
- TIGHTEN: still worth holding but tired, extended or newly exposed. The stop ratchets closer, never looser.
- TAKE_PARTIAL: PROFITABLE and momentum fading rather than broken — bank part, let the rest run. Prefer over CLOSE when the thesis is intact but the easy money is made. Never valid on a loser; that is just a worse stop.
- CLOSE: exit fully. For a broken thesis, a structural loss, or a materially negative catalyst — where waiting for the mechanical stop only donates the remaining distance to it.

ESTIMATES — produce these BEFORE choosing, and let them drive the action. Your action must be consistent with your own numbers: do not report a 20% recovery probability and then HOLD a loser, or large remaining upside and then CLOSE.
- recoveryProbabilityPct: if losing, probability of returning to breakeven within your expected holding period; if winning, probability of holding current gains.
- expectedUpsideRemainingPct: further move expected from the CURRENT price if it works. Anchor on the target ladder, not ambition.
- maxAcceptableDrawdownPct: how far below the CURRENT price you would let it go before conceding, positive. On TIGHTEN this is the number the system uses to place the new stop, so it must be a level you would genuinely honour.

EVIDENCE RULES:
- "unavailable"/"n/a" means the desk could not measure it — not zero, not a warning sign.
- Never invent a price level, earnings date, analyst action or news event. An empty headline list means none were RETRIEVED, not that news is quiet — say so rather than concluding calm.
- You have no browsing and no memory of previous reviews. List what you needed but did not get in unavailableData and lower confidence rather than guessing.

CONSISTENCY: identical evidence must always produce an identical action. Apply these rules as written, not by feel; let confidence carry uncertainty, not the action.

CONFIDENCE 1-10 describes the strength of the EVIDENCE, not enthusiasm: 1-3 thin or contradictory, 4-5 workable, 6-7 clean and factors agree, 8-10 strong alignment. The desk enforces confidence floors in code — a low-confidence CLOSE or TAKE_PARTIAL is declined and the position left alone, so an honest low number is never wasted.

OUTPUT — JSON only, no markdown, no text outside the object, fields in this order:
{"unavailableData":"fields you needed but were not given, or: none","marketRead":"<=15 words","positionRead":"<=25 words on what this position actually did","thesisStatus":"INTACT"|"WEAKENING"|"BROKEN"|"UNPROVEN","momentum":"ACCELERATING"|"STEADY"|"WEAKENING"|"REVERSING","lossType":"TEMPORARY"|"STRUCTURAL"|"UNCLEAR"|"NOT_LOSING","reversalEvidence":"concrete evidence, or: none","expectedHoldingPeriod":"INTRADAY"|"1-2_DAYS"|"3-5_DAYS"|"OVER_A_WEEK","recoveryProbabilityPct":0-100,"expectedUpsideRemainingPct":number,"maxAcceptableDrawdownPct":number,"reviewIntervalMinutes":15|60|240|1440|2880,"scaleInCase":"NONE"|"WEAK"|"STRONG","scaleInRationale":"<=20 words; assessment only, the desk does not add to open positions","action":"EXTEND"|"HOLD"|"TIGHTEN"|"TAKE_PARTIAL"|"CLOSE","confidence":1-10,"confidenceRationale":"<=20 words naming what set this"}`;

// ── USER TURN: the evidence for ONE position ───────────────────────────────
function buildReviewerEvidence(reviewContext) {
  const {
    symbol,
    positionMeta,
    currentPrice,
    pnlPercent,
    heldDescription,
    easternWeekdayName,
    headlines,
    marketContext,
  } = reviewContext;

  const plan = positionMeta.plan || {};
  const entryPrice = positionMeta.entryPrice;

  // Peak framing: the give-back from the high-water mark is the single most
  // decision-relevant number in an exhaustion read, so it is computed here
  // rather than left for the model to derive (and mis-derive).
  let peakLine = "Peak since entry: unavailable";
  if (positionMeta.peakPrice && entryPrice) {
    const peakGainPct =
      ((positionMeta.peakPrice - entryPrice) / entryPrice) * 100;
    const givebackPct =
      ((positionMeta.peakPrice - currentPrice) / positionMeta.peakPrice) * 100;
    peakLine =
      "Peak since entry: $" +
      positionMeta.peakPrice.toFixed(4) +
      " (" +
      (peakGainPct >= 0 ? "+" : "") +
      peakGainPct.toFixed(1) +
      "% at best) — currently " +
      givebackPct.toFixed(1) +
      "% below that peak";
  }

  const headlineBlock =
    headlines && headlines.length > 0
      ? headlines
          .map(
            (article) =>
              "- [" + (article.source || "news") + "] " + article.headline,
          )
          .join("\n")
      : "(no headlines were retrieved for this symbol — this means the news feed returned nothing or is not configured, NOT that there is no news)";

  const stopLevel = positionMeta.lockedFloor || positionMeta.stopPrice;
  const distanceToStopPct =
    stopLevel && currentPrice
      ? ((currentPrice - stopLevel) / currentPrice) * 100
      : null;

  const briefBlock = marketContext?.briefText
    ? marketContext.briefText
    : "MARKET BRIEF: unavailable — SPY " +
      (typeof marketContext?.spyChangePercent === "number"
        ? marketContext.spyChangePercent.toFixed(2) + "%"
        : "n/a") +
      ", regime " +
      (marketContext?.regime || "UNKNOWN");

  const timeBudget =
    positionMeta.tradeType === "SWING"
      ? config.swingMaxHoldDays + " days"
      : config.maxHoldMinutes + " minutes";

  // v7: state which actions are actually live for THIS position, mirroring
  // the guardrails in applyReviewDecision(). Observed in a live smoke test:
  // shown only "Partials taken: YES", the model still chose TAKE_PARTIAL —
  // the guardrail refused it safely, but the review was wasted and the
  // journal recorded an action that never had a route to the market. Naming
  // the available set costs a handful of tokens and removes the dead branch.
  const unavailableActions = [];
  if (positionMeta.tradeType === "SWING") {
    unavailableActions.push("EXTEND (already a SWING)");
  }
  if (positionMeta.partialDone || positionMeta.partialT1Done) {
    unavailableActions.push("TAKE_PARTIAL (a partial was already banked)");
  } else if (currentPrice <= entryPrice) {
    unavailableActions.push("TAKE_PARTIAL (position is not in profit)");
  }
  if (!config.reviewerAllowClose) unavailableActions.push("CLOSE (disabled)");
  if (!config.reviewerAllowTakePartial) {
    unavailableActions.push("TAKE_PARTIAL (disabled)");
  }
  const availableActionsLine =
    unavailableActions.length > 0
      ? "UNAVAILABLE FOR THIS POSITION — do not choose: " +
        unavailableActions.join("; ")
      : "All five actions are available for this position.";

  return `${briefBlock}
TODAY: ${easternWeekdayName} afternoon ET, about 45 minutes before the close.

── POSITION: ${symbol} [${positionMeta.tradeType || "DAY"}] ──
Setup at entry: ${positionMeta.setup || "n/a"} — ${plan.setupDetail || "n/a"}
Entry $${entryPrice} · Current $${currentPrice.toFixed(4)} (${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(1)}%)
${peakLine}
Stop/floor: $${stopLevel ? stopLevel.toFixed(4) : "n/a"}${distanceToStopPct != null ? " (" + distanceToStopPct.toFixed(1) + "% below current price)" : ""}
Targets: T1 $${positionMeta.targetT1}${positionMeta.targetT2 ? " · T2 $" + positionMeta.targetT2 : ""}${positionMeta.targetT3 ? " · T3 $" + positionMeta.targetT3 : ""}
Held: ${heldDescription} (the desk's normal time budget for this type is ${timeBudget})
Partials taken: ${positionMeta.partialDone || positionMeta.partialT1Done ? "YES — winners already banked, the remainder is a runner" : "no"}
Daily ATR at entry: ${positionMeta.entryConditions?.atrPercent != null ? positionMeta.entryConditions.atrPercent + "%" : "unavailable"}${plan.volatilityBucket ? " (volatility bucket " + plan.volatilityBucket + ")" : ""}
Original trend read: ${plan.trendDirection || "n/a"} · entry RSI ${plan.rsi ?? "unavailable"} · entry RS vs SPY ${plan.relativeStrength != null ? plan.relativeStrength.toFixed(2) + " pts" : "unavailable"}

── RECENT HEADLINES (last 2 days) ──
${headlineBlock}

${availableActionsLine}
Return the JSON decision for ${symbol}.`;
}

// ── Response parsing ───────────────────────────────────────────────────────
function extractJsonObject(rawText) {
  if (!rawText) return null;
  const withoutFences = rawText.replace(/```(?:json)?/gi, "").trim();
  const firstBrace = withoutFences.indexOf("{");
  const lastBrace = withoutFences.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(withoutFences.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function boundedNumber(rawValue, minimum, maximum) {
  const parsed = typeof rawValue === "string" ? parseFloat(rawValue) : rawValue;
  if (typeof parsed !== "number" || isNaN(parsed)) return null;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normaliseAnalysis(parsed) {
  const oneOf = (value, allowed, fallback) =>
    allowed.includes(value) ? value : fallback;

  return {
    unavailableData: parsed.unavailableData || "none",
    marketRead: parsed.marketRead || "",
    positionRead: parsed.positionRead || "",
    thesisStatus: oneOf(
      parsed.thesisStatus,
      ["INTACT", "WEAKENING", "BROKEN", "UNPROVEN"],
      "UNPROVEN",
    ),
    momentum: oneOf(
      parsed.momentum,
      ["ACCELERATING", "STEADY", "WEAKENING", "REVERSING"],
      "STEADY",
    ),
    lossType: oneOf(
      parsed.lossType,
      ["TEMPORARY", "STRUCTURAL", "UNCLEAR", "NOT_LOSING"],
      "UNCLEAR",
    ),
    reversalEvidence: parsed.reversalEvidence || "none",
    expectedHoldingPeriod: oneOf(
      parsed.expectedHoldingPeriod,
      ["INTRADAY", "1-2_DAYS", "3-5_DAYS", "OVER_A_WEEK"],
      "INTRADAY",
    ),
    recoveryProbabilityPct: boundedNumber(parsed.recoveryProbabilityPct, 0, 100),
    expectedUpsideRemainingPct: boundedNumber(
      parsed.expectedUpsideRemainingPct,
      -100,
      1000,
    ),
    maxAcceptableDrawdownPct: boundedNumber(
      parsed.maxAcceptableDrawdownPct,
      0,
      100,
    ),
    reviewIntervalMinutes: boundedNumber(parsed.reviewIntervalMinutes, 5, 10080),
    scaleInCase: oneOf(parsed.scaleInCase, ["NONE", "WEAK", "STRONG"], "NONE"),
    scaleInRationale: parsed.scaleInRationale || "",
    confidenceRationale: parsed.confidenceRationale || "",
  };
}

function composeReasoning(analysis) {
  const parts = [
    analysis.positionRead,
    "thesis " + analysis.thesisStatus,
    "momentum " + analysis.momentum,
    analysis.lossType !== "NOT_LOSING" ? "loss looks " + analysis.lossType : null,
    analysis.recoveryProbabilityPct != null
      ? "recovery ~" + analysis.recoveryProbabilityPct + "%"
      : null,
    analysis.expectedUpsideRemainingPct != null
      ? "upside left ~" + analysis.expectedUpsideRemainingPct + "%"
      : null,
    analysis.confidenceRationale || null,
  ].filter(Boolean);
  return parts.join(" · ");
}

async function reviewSinglePosition(reviewContext) {
  const { symbol } = reviewContext;
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: config.reviewerMaxTokens,
      system: REVIEWER_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: buildReviewerEvidence(reviewContext) },
      ],
    });

    const text = (response.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    const parsed = extractJsonObject(text);
    if (!parsed) {
      throw new Error(
        "unparseable reviewer response" +
          (response.stop_reason === "max_tokens"
            ? " (hit max_tokens — raise DT_REVIEWER_MAX_TOKENS)"
            : ""),
      );
    }

    const action = VALID_ACTIONS.includes(parsed.action) ? parsed.action : "HOLD";
    const analysis = normaliseAnalysis(parsed);
    const confidence = Math.min(
      10,
      Math.max(1, parseInt(parsed.confidence, 10) || 5),
    );

    return {
      symbol,
      action,
      confidence,
      reasoning: composeReasoning(analysis),
      analysis,
    };
  } catch (reviewError) {
    logger.warn(
      "Position reviewer failed for " + symbol + ": " + reviewError.message,
    );
    await alerts.systemAlert(
      "AI_POSITION_REVIEWER",
      "The daily position reviewer got NO usable response for " +
        symbol +
        " (" +
        reviewError.message +
        "). Defaulting to HOLD — existing stops/EOD close still protect the position.",
    );
    // Fail-safe: HOLD keeps the existing (already safe) plan.
    return {
      symbol,
      action: "HOLD",
      confidence: 0,
      reasoning: "Reviewer error — holding existing plan",
      analysis: null,
    };
  }
}

// ── Deterministic application of the AI's chosen action ─────────────────────
// Returns { applied, description } and MUTATES positionMeta when applied.
// Every threshold below is enforced HERE, in code — never trusted to the
// prompt. The model proposes; this function disposes.
async function applyReviewDecision(
  positionMeta,
  reviewResult,
  currentPrice,
  openSwingCount,
) {
  const symbol = reviewResult.symbol;
  const analysis = reviewResult.analysis || {};

  // Record the estimates on the position regardless of action, so the
  // journal can later score the prediction against the real outcome.
  positionMeta.lastReview = {
    at: new Date().toISOString(),
    action: reviewResult.action,
    confidence: reviewResult.confidence,
    thesisStatus: analysis.thesisStatus || null,
    momentum: analysis.momentum || null,
    lossType: analysis.lossType || null,
    recoveryProbabilityPct: analysis.recoveryProbabilityPct ?? null,
    expectedUpsideRemainingPct: analysis.expectedUpsideRemainingPct ?? null,
    maxAcceptableDrawdownPct: analysis.maxAcceptableDrawdownPct ?? null,
    expectedHoldingPeriod: analysis.expectedHoldingPeriod || null,
    // Advisory only: the exit monitor's own 1-minute tick already covers all
    // hard risk, so nothing currently reschedules on this. It is captured so
    // the cadence question can be answered from evidence later.
    reviewIntervalMinutes: analysis.reviewIntervalMinutes ?? null,
    scaleInCase: analysis.scaleInCase || "NONE",
  };

  // ── CLOSE ────────────────────────────────────────────────────────────────
  if (reviewResult.action === "CLOSE") {
    if (!config.reviewerAllowClose) {
      return { applied: false, description: "CLOSE disabled by config" };
    }
    if (reviewResult.confidence < config.reviewerMinConfidenceToClose) {
      return {
        applied: false,
        description:
          "CLOSE refused — confidence " +
          reviewResult.confidence +
          " below floor " +
          config.reviewerMinConfidenceToClose,
      };
    }
    // Queued, not executed here: the 1-minute exit monitor performs the close
    // through the same order + accounting path as every other exit.
    positionMeta.pendingReviewerAction = {
      type: "EXIT",
      reason: "AI_REVIEW_CLOSE",
      requestedAt: new Date().toISOString(),
      confidence: reviewResult.confidence,
    };
    return {
      applied: true,
      description:
        "CLOSE queued (confidence " +
        reviewResult.confidence +
        ") — the exit monitor will close it on its next tick",
    };
  }

  // ── TAKE_PARTIAL ─────────────────────────────────────────────────────────
  if (reviewResult.action === "TAKE_PARTIAL") {
    if (!config.reviewerAllowTakePartial) {
      return { applied: false, description: "TAKE_PARTIAL disabled by config" };
    }
    if (reviewResult.confidence < config.reviewerMinConfidenceToTakePartial) {
      return {
        applied: false,
        description:
          "TAKE_PARTIAL refused — confidence " +
          reviewResult.confidence +
          " below floor " +
          config.reviewerMinConfidenceToTakePartial,
      };
    }
    // Banking a partial on a loser is just a worse stop — never allowed.
    if (currentPrice <= positionMeta.entryPrice) {
      return {
        applied: false,
        description:
          "TAKE_PARTIAL refused — position is not in profit (banking part of a loss is just a worse stop)",
      };
    }
    if (positionMeta.partialDone || positionMeta.partialT1Done) {
      return {
        applied: false,
        description: "TAKE_PARTIAL refused — a partial was already banked",
      };
    }
    positionMeta.pendingReviewerAction = {
      type: "PARTIAL",
      reason: "AI_REVIEW_PARTIAL",
      fraction: config.reviewerTakePartialFraction,
      requestedAt: new Date().toISOString(),
      confidence: reviewResult.confidence,
    };
    return {
      applied: true,
      description:
        "TAKE_PARTIAL queued — " +
        Math.round(config.reviewerTakePartialFraction * 100) +
        "% will be banked on the next exit-monitor tick, floor moves to breakeven",
    };
  }

  // ── TIGHTEN ──────────────────────────────────────────────────────────────
  if (reviewResult.action === "TIGHTEN") {
    const planStopFraction =
      positionMeta.plan && positionMeta.plan.stopDistancePct
        ? positionMeta.plan.stopDistancePct / 100
        : config.stopLossPct;

    // v7: use the model's OWN stated maxAcceptableDrawdownPct when it gave a
    // sane one — it just committed to that level in writing, so honouring it
    // is more coherent than a fixed factor. Clamped so it can only ever be
    // tighter than the existing plan stop and never absurdly tight.
    const statedDrawdown = analysis.maxAcceptableDrawdownPct;
    const useStated =
      typeof statedDrawdown === "number" &&
      statedDrawdown > 0 &&
      statedDrawdown / 100 < planStopFraction;

    const stopDistanceFraction = useStated
      ? Math.max(statedDrawdown / 100, config.reviewerTightenMinStopPct)
      : planStopFraction * config.reviewerTightenStopFactor;

    const proposedStop = currentPrice * (1 - stopDistanceFraction);
    const existingFloor = positionMeta.lockedFloor || positionMeta.stopPrice;

    if (proposedStop > existingFloor) {
      // Ratchet UP only — never loosen.
      positionMeta.lockedFloor = Number(proposedStop.toFixed(4));
      if (proposedStop > positionMeta.stopPrice) {
        positionMeta.stopPrice = Number(proposedStop.toFixed(4));
      }
      positionMeta.tightenedByReviewerAt = new Date().toISOString();
      return {
        applied: true,
        description:
          "stop tightened to $" +
          proposedStop.toFixed(2) +
          " (was $" +
          existingFloor.toFixed(2) +
          ")" +
          (useStated
            ? " using the reviewer's stated " +
              statedDrawdown +
              "% maximum acceptable drawdown"
            : " using the default tighten factor"),
      };
    }
    return {
      applied: false,
      description:
        "TIGHTEN requested but computed stop $" +
        proposedStop.toFixed(2) +
        " is not above the current floor $" +
        existingFloor.toFixed(2) +
        " — no change",
    };
  }

  // ── EXTEND ───────────────────────────────────────────────────────────────
  if (reviewResult.action === "EXTEND") {
    // Guardrail 0: only DAY positions can be extended
    if (positionMeta.tradeType === "SWING") {
      return { applied: false, description: "already a SWING — no change" };
    }
    // Guardrail 1: confidence floor
    if (reviewResult.confidence < config.reviewerMinConfidenceToExtend) {
      return {
        applied: false,
        description:
          "EXTEND confidence " +
          reviewResult.confidence +
          " below floor " +
          config.reviewerMinConfidenceToExtend +
          " — closing at EOD as planned",
      };
    }
    // Guardrail 2: must be in profit (configurable)
    if (
      config.reviewerExtendRequiresProfit &&
      currentPrice <= positionMeta.entryPrice
    ) {
      return {
        applied: false,
        description:
          "EXTEND refused — position not in profit (losers are never extended)",
      };
    }
    // Guardrail 3: swing slot must be free
    if (openSwingCount >= config.maxSwingPositions) {
      return {
        applied: false,
        description: "EXTEND refused — swing slots full",
      };
    }
    // Guardrail 4: earnings blackout (if Finnhub configured)
    if (config.earningsBlackoutEnabled && finnhub.isConfigured()) {
      const earningsCheck = await finnhub.checkEarningsWithinDays(
        symbol,
        config.earningsBlackoutSwingDays,
      );
      if (earningsCheck.hasEarnings === true) {
        return {
          applied: false,
          description:
            "EXTEND refused — earnings on " +
            earningsCheck.earningsDate +
            " inside the swing window",
        };
      }
    }

    // Convert DAY → SWING deterministically
    positionMeta.tradeType = "SWING";
    const entryPrice = positionMeta.entryPrice;
    const stopDistanceFraction =
      positionMeta.plan && positionMeta.plan.stopDistancePct
        ? positionMeta.plan.stopDistancePct / 100
        : config.stopLossPct;

    // Extend the ladder: T2 (if missing) and T3 in the same R geometry
    if (!positionMeta.targetT2) {
      positionMeta.targetT2 = Number(
        (entryPrice * (1 + stopDistanceFraction * 2.0)).toFixed(4),
      );
    }
    if (!positionMeta.targetT3) {
      positionMeta.targetT3 = Number(
        (entryPrice * (1 + stopDistanceFraction * 3.5)).toFixed(4),
      );
    }
    // Swing trail % from ATR at entry, clamped 2-6% (same rule as planner)
    const atrPercent =
      positionMeta.entryConditions && positionMeta.entryConditions.atrPercent;
    positionMeta.swingTrailPct = Number(
      Math.min(0.06, Math.max(0.02, (atrPercent || 3) / 100)).toFixed(4),
    );
    // Map DAY partial state onto SWING tier flags so the swing exit engine
    // reads the position correctly: a day partial at T1 = swing T1 done,
    // and in that case the floor is already at least breakeven.
    if (positionMeta.partialDone && !positionMeta.partialT1Done) {
      positionMeta.partialT1Done = true;
      if (
        !positionMeta.lockedFloor ||
        positionMeta.lockedFloor < positionMeta.entryPrice
      ) {
        positionMeta.lockedFloor = positionMeta.entryPrice;
      }
    }
    // In-profit extension always protects breakeven at minimum
    if (
      currentPrice > entryPrice &&
      (!positionMeta.lockedFloor || positionMeta.lockedFloor < entryPrice)
    ) {
      positionMeta.lockedFloor = entryPrice;
    }
    positionMeta.extendedByReviewerAt = new Date().toISOString();

    return {
      applied: true,
      description:
        "EXTENDED to SWING — holds overnight, floor $" +
        (positionMeta.lockedFloor || positionMeta.stopPrice).toFixed(2) +
        ", T2 $" +
        positionMeta.targetT2 +
        ", T3 $" +
        positionMeta.targetT3 +
        " (Friday still closes everything)",
    };
  }

  return { applied: false, description: "HOLD — plan unchanged" };
}

module.exports = {
  reviewSinglePosition,
  applyReviewDecision,
  // Exported for tests and token measurement.
  buildReviewerEvidence,
  extractJsonObject,
  normaliseAnalysis,
  REVIEWER_SYSTEM_PROMPT,
  VALID_ACTIONS,
};
