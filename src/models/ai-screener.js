// src/models/ai-screener.js
//
// v5 (2026-07-04): failure ALERTING added. The screener is fail-closed
// (an unscreened plan is never traded — correct), but before v5 a dead
// Anthropic key / network problem meant every plan silently became SKIP
// and the bot just... stopped trading, with only warn-level log lines.
// Now: any screener error fires a throttled Telegram system alert, and if
// EVERY plan in a batch errored, a batch-level alert fires too.
//
// v4 design retained: the AI screens the COMPLETE TRADE PLAN and gives a
// decisive TAKE/SKIP veto. It does NOT set prices — trade-planner geometry
// is authoritative. One fast Haiku call per candidate.
require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const { logger } = require("../logger");
const { sectorBucketFor } = require("../strategies/risk-manager");
const alerts = require("../notifications/alerts");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildScreenerPrompt(plan, currentPositions, marketContext) {
  const heldSymbols =
    (currentPositions || []).map((position) => position.symbol).join(", ") ||
    "none";
  const sector = sectorBucketFor(plan.symbol);
  const regimeLine = marketContext?.regime
    ? marketContext.regime +
      " market (SPY range " +
      (marketContext.rangePct != null
        ? marketContext.rangePct.toFixed(2) + "%"
        : "n/a") +
      ")"
    : "unknown";
  const spyLine =
    typeof marketContext?.spyChangePercent === "number"
      ? marketContext.spyChangePercent.toFixed(2) + "%"
      : "n/a";

  return `You are a fast trading-desk risk screener. You receive ONE complete
trade plan and must give a decisive TAKE/SKIP verdict. The plan's geometry
(stop, targets, size) is already computed deterministically — you do NOT set
prices. Your only job: veto plans that look like traps despite passing the
quantitative filters.

TRADE PLAN: ${plan.symbol} (sector: ${sector})
Type: ${plan.tradeType}${plan.tradeType === "SWING" ? " (1-10 day hold, closes Friday at latest)" : " (intraday, force-closed before US close)"} · Archetype: ${plan.archetype || "n/a"}
Source: ${plan.source}${plan.isFirstTimeDiscovered ? " (first-ever trade in this name — already half-sized)" : ""}${plan.catalystLabel ? "\nCatalyst: " + plan.catalystLabel : ""}
Setup: ${plan.setup} — ${plan.setupDetail}
Entry $${plan.entryPrice} · Stop $${plan.stopPrice} (-${plan.stopDistancePct}%) · T1 $${plan.targetT1} · T2 $${plan.targetT2}${plan.targetT3 ? " · T3 $" + plan.targetT3 : ""}
Risk: $${plan.riskDollars} (${plan.riskPctOfCapital}% of capital) · RRR ${plan.riskRewardRatio}
Volatility: ${plan.volatilityBucket} (daily ATR ${plan.atrPercent != null ? plan.atrPercent + "%" : "n/a"})
Trend read: ${plan.trendDirection} · RSI ${plan.rsi ?? "n/a"} · RS vs SPY ${plan.relativeStrength != null ? plan.relativeStrength.toFixed(2) + " pts" : "n/a"} · ${plan.aboveVwap ? "above" : "below/at"} VWAP

MARKET CONTEXT:
Regime: ${regimeLine} · SPY today: ${spyLine}
${marketContext?.regime === "CHOP" ? "NOTE: choppy tape — demand stronger evidence of follow-through." : ""}
Currently held: ${heldSymbols}

VETO CHECKLIST — SKIP if any apply:
- The move looks exhausted (gap already faded, RSI blow-off, late-day chase)
- Breakout into obvious resistance / prior failure level
- Volume pattern smells like a single print or pump, not real participation
- ${plan.tradeType === "SWING" ? "The strength looks intraday-only — no reason it persists tomorrow" : "No realistic path to T1 in the next few hours"}
- A ${plan.source === "DISCOVERED" ? "discovered ticker you'd flag as low-quality/manipulation-prone (SPACs, penny-adjacent, meme squeeze late stage)" : "known name behaving out of character with no explanation"}

Respond with JSON only, no markdown:
{
  "decision": "TAKE" | "SKIP",
  "confidence": 1-10,
  "reasoning": "one or two sentences, specific to THIS plan"
}`;
}

async function screenCandidate(plan, currentPositions, marketContext) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: buildScreenerPrompt(plan, currentPositions, marketContext),
        },
      ],
    });

    const text = (response.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return {
      symbol: plan.symbol,
      decision: parsed.decision === "TAKE" ? "TAKE" : "SKIP",
      confidence: Math.min(10, Math.max(1, parseInt(parsed.confidence) || 5)),
      reasoning: parsed.reasoning || "",
      errored: false,
    };
  } catch (screenError) {
    logger.warn(
      "AI screener failed for " + plan.symbol + ": " + screenError.message,
    );
    // Fail-closed: an unscreened plan is never traded.
    return {
      symbol: plan.symbol,
      decision: "SKIP",
      confidence: 0,
      reasoning: "Screener error — skipping for safety",
      errored: true,
      errorMessage: screenError.message,
    };
  }
}

// Screen multiple PLANS in parallel (one Haiku call each).
async function screenCandidates(plans, currentPositions, marketContext) {
  if (!plans || plans.length === 0) return [];
  const results = await Promise.all(
    plans.map((plan) => screenCandidate(plan, currentPositions, marketContext)),
  );

  const erroredResults = results.filter((result) => result.errored);
  if (erroredResults.length > 0) {
    // v5: a dead AI screener silently kills all trading — make it LOUD.
    await alerts.systemAlert(
      "AI_SCREENER",
      "The AI entry screener got NO usable response for " +
        erroredResults.length +
        "/" +
        results.length +
        " plan(s) this scan (" +
        erroredResults[0].errorMessage +
        "). All errored plans were SKIPPED (fail-closed) — the bot cannot open " +
        "new positions while this persists. Check ANTHROPIC_API_KEY / network.",
    );
  } else if (results.length > 0) {
    // Screener produced real answers → clear any prior screener alert
    await alerts.clearAlert(
      "AI_SCREENER",
      "AI entry screener is responding again (" +
        results.length +
        " plan(s) screened).",
    );
  }

  const taken = results.filter((result) => result.decision === "TAKE");
  logger.info(
    "🤖 AI screener: " +
      taken.length +
      "/" +
      results.length +
      " plans approved",
  );
  return results;
}

module.exports = { screenCandidates };
