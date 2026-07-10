// src/models/ai-position-reviewer.js
//
// v5 NEW MODULE — TIER-2 AI: THE DAILY POSITION REVIEWER.
//
// This is the direct answer to: "if the AI determines a stock has another
// 2-3 days of upside with high confidence, why force-sell it today?"
//
// Once per day (Mon-Thu at config.reviewerHourET, BEFORE the EOD close
// routine) every open position gets ONE Haiku call. The AI does NOT set
// prices — same discipline as the entry screener. It picks one of three
// ACTIONS; the price math stays deterministic:
//
//   EXTEND  — DAY position converts to SWING: it survives tonight's EOD
//             close and keeps working its ladder. Deterministic guardrails
//             (enforced in code, NOT trusted to the AI):
//               · position must currently be in profit (configurable)
//               · a SWING slot must be free
//               · AI confidence ≥ config.reviewerMinConfidenceToExtend
//               · no earnings inside the next earningsBlackoutSwingDays
//                 (if Finnhub is configured)
//               · Friday still closes EVERYTHING (first-month rule) — an
//                 extension buys days, never a weekend
//             For a SWING position, EXTEND simply means HOLD (it already
//             survives overnight).
//
//   HOLD    — no change; the existing plan keeps running.
//
//   TIGHTEN — the stop/floor is pulled IN deterministically:
//               newStop = currentPrice × (1 − stopDistancePct ×
//                         config.reviewerTightenStopFactor)
//             ...and never moves DOWN (only ratchets up).
//
// Fail-safe: any error → HOLD (the existing plan is the safe default) and
// a throttled Telegram system alert fires so a dead reviewer is visible.
require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const { logger } = require("../logger");
const config = require("../config");
const finnhub = require("../data-sources/finnhub");
const alerts = require("../notifications/alerts");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildReviewerPrompt(reviewContext) {
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
  const headlineBlock =
    headlines.length > 0
      ? headlines
          .map(
            (article) =>
              "- [" + (article.source || "news") + "] " + article.headline,
          )
          .join("\n")
      : "(no recent headlines available)";

  return `You are an end-of-day position reviewer on a trading desk. It is
${easternWeekdayName} afternoon (ET), about 45 minutes before the close. You
review ONE open position and choose EXACTLY ONE action. You do NOT set
prices — stops and targets are computed deterministically by the system.

POSITION: ${symbol} [${positionMeta.tradeType || "DAY"}]
Setup at entry: ${positionMeta.setup || "n/a"} — ${plan.setupDetail || "n/a"}
Entry $${positionMeta.entryPrice} · Current $${currentPrice.toFixed(4)} (${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(1)}%)
Stop/floor: $${(positionMeta.lockedFloor || positionMeta.stopPrice).toFixed(4)}
Targets: T1 $${positionMeta.targetT1}${positionMeta.targetT2 ? " · T2 $" + positionMeta.targetT2 : ""}${positionMeta.targetT3 ? " · T3 $" + positionMeta.targetT3 : ""}
Held: ${heldDescription}
Partials taken: ${positionMeta.partialDone || positionMeta.partialT1Done ? "YES (winners already banked, remainder is a runner)" : "no"}

MARKET: SPY ${typeof marketContext.spyChangePercent === "number" ? marketContext.spyChangePercent.toFixed(2) + "% today" : "n/a"} · regime ${marketContext.regime || "UNKNOWN"}

RECENT HEADLINES (last 2 days):
${headlineBlock}

ACTIONS:
- "EXTEND": ONLY if this is a DAY position that shows real evidence the move
  persists into the next 1-3 sessions (trend intact, closing near highs, no
  exhaustion, no negative catalyst). It will then hold overnight as a SWING
  and keep its ladder. If in doubt, do NOT extend — the default day-trade
  discipline (close tonight) exists for a reason.
- "HOLD": keep the current plan unchanged (for a SWING this means keep
  holding; for a DAY this means it closes at today's EOD as planned).
- "TIGHTEN": the position looks tired, extended, or a negative catalyst
  appeared — the system will pull the stop meaningfully closer to lock in
  what's there.

Respond with JSON only, no markdown:
{
  "action": "EXTEND" | "HOLD" | "TIGHTEN",
  "confidence": 1-10,
  "reasoning": "one or two sentences specific to THIS position"
}`;
}

async function reviewSinglePosition(reviewContext) {
  const { symbol } = reviewContext;
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      messages: [
        { role: "user", content: buildReviewerPrompt(reviewContext) },
      ],
    });

    const text = (response.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const action = ["EXTEND", "HOLD", "TIGHTEN"].includes(parsed.action)
      ? parsed.action
      : "HOLD";

    return {
      symbol,
      action,
      confidence: Math.min(10, Math.max(1, parseInt(parsed.confidence) || 5)),
      reasoning: parsed.reasoning || "",
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
    };
  }
}

// ── Deterministic application of the AI's chosen action ─────────────────────
// Returns { applied, description } and MUTATES positionMeta when applied.
async function applyReviewDecision(
  positionMeta,
  reviewResult,
  currentPrice,
  openSwingCount,
) {
  const symbol = reviewResult.symbol;

  if (reviewResult.action === "TIGHTEN") {
    const stopDistancePct =
      (positionMeta.plan && positionMeta.plan.stopDistancePct
        ? positionMeta.plan.stopDistancePct / 100
        : config.stopLossPct) * config.reviewerTightenStopFactor;
    const proposedStop = currentPrice * (1 - stopDistancePct);
    const existingFloor = positionMeta.lockedFloor || positionMeta.stopPrice;

    if (proposedStop > existingFloor) {
      // Ratchet UP only — never loosen
      positionMeta.lockedFloor = Number(proposedStop.toFixed(4));
      if (proposedStop > positionMeta.stopPrice) {
        positionMeta.stopPrice = Number(proposedStop.toFixed(4));
      }
      return {
        applied: true,
        description:
          "stop tightened to $" +
          proposedStop.toFixed(2) +
          " (was $" +
          existingFloor.toFixed(2) +
          ")",
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

module.exports = { reviewSinglePosition, applyReviewDecision };
