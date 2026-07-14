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
//
// v5.6.1: PROMPT REWRITE. Traced from real journal data that the screener
// was rejecting ~100% of plans over weeks — including clean watchlist
// setups (ANET, AVGO) with unremarkable, filter-passing RSI/volume
// numbers. Root cause: the old prompt was pure "find a reason to reject"
// with vague, rationalization-friendly criteria ("smells like a pump",
// "screams exhaustion") and NO counterbalancing instruction for when to
// say TAKE. Rewritten to require CONCRETE, specific evidence for a SKIP,
// with an explicit default-to-TAKE instruction when nothing concrete is
// wrong. Also explicitly tells the model not to treat "volume data
// unavailable" text as if it meant "zero volume" (see the matching fix in
// momentum-scanner.js's describeVolume()).
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
  const sessionLine = marketContext?.session || "REGULAR";
  const todayPnl = marketContext?.todayPnl;
  const todayLine = todayPnl
    ? todayPnl.tradesClosed +
      " trade(s) closed today, won $" +
      todayPnl.realizedWin.toFixed(2) +
      " / lost $" +
      todayPnl.realizedLoss.toFixed(2)
    : "no trades closed yet today";
  // v5.7: NEWS_HIT is a GENERIC headline tag (e.g. "Top stock movements in
  // today's session") whose sentiment was never checked — presenting it as
  // "Catalyst:" misled the model into approving VEEE (+478% pump) twice.
  // Only ANALYST_UPGRADE / INSIDER_BUY are verified-bullish catalysts.
  const catalystLine = plan.catalystLabel
    ? plan.catalyst === "ANALYST_UPGRADE" || plan.catalyst === "INSIDER_BUY"
      ? "\nCatalyst (verified " + plan.catalyst + "): " + plan.catalystLabel
      : "\nRecent headline (GENERIC, sentiment unverified — NOT a real catalyst): " +
        plan.catalystLabel
    : "";

  return `You are a fast trading-desk risk screener. You receive ONE complete
trade plan that has ALREADY PASSED deterministic quantitative filters —
VWAP trend, relative strength vs SPY, RSI range, volume-ratio floor, and
risk/reward geometry are all already enforced by code before you ever see
this plan. The plan's price levels (stop, targets, size) are also already
computed — you do NOT set prices.

YOUR JOB, PRECISELY: catch the specific cases where the numbers technically
pass but something concrete makes this plan untrustworthy anyway — not to
re-litigate judgments the quantitative filters already made correctly.
If nothing concrete is wrong, your default answer is TAKE. A clean setup
that merely "could" fade, or that isn't a slam-dunk certainty, is NOT a
reason to SKIP — no trade is ever certain, and requiring certainty means
rejecting everything regardless of quality.

TRADE PLAN: ${plan.symbol} (sector: ${sector})
Type: ${plan.tradeType}${plan.tradeType === "SWING" ? " (1-10 day hold, closes Friday at latest)" : " (intraday, force-closed before US close)"} · Archetype: ${plan.archetype || "n/a"}
Source: ${plan.source}${plan.isFirstTimeDiscovered ? " (first-ever trade in this name — already half-sized)" : ""}${catalystLine}
Setup: ${plan.setup} — ${plan.setupDetail}
Entry $${plan.entryPrice} · Stop $${plan.stopPrice} (-${plan.stopDistancePct}%) · T1 $${plan.targetT1} · T2 $${plan.targetT2}${plan.targetT3 ? " · T3 $" + plan.targetT3 : ""}
Risk: $${plan.riskDollars} (${plan.riskPctOfCapital}% of capital) · RRR ${plan.riskRewardRatio}
Volatility: ${plan.volatilityBucket} (daily ATR ${plan.atrPercent != null ? plan.atrPercent + "%" : "n/a"})
Trend read: ${plan.trendDirection} · RSI ${plan.rsi ?? "n/a"} (already confirmed within acceptable range by code — do not re-reject on RSI alone unless it's genuinely extreme) · RS vs SPY ${plan.relativeStrength != null ? plan.relativeStrength.toFixed(2) + " pts" : "n/a"} · ${plan.aboveVwap ? "above" : "below/at"} VWAP

MARKET CONTEXT:
Session: ${sessionLine} · Regime: ${regimeLine} · SPY today: ${spyLine}
Bot's results today: ${todayLine}
${marketContext?.regime === "CHOP" ? "NOTE: choppy tape — demand stronger evidence of follow-through." : ""}
Currently held: ${heldSymbols}

SESSION RULE: in an OVERNIGHT/EXTENDED session, books are thinner, spreads
wider, and momentum less reliable. A MARGINAL setup — RSI within ~4 points
of the 78 overextended ceiling, or SIDEWAYS trend in an UNKNOWN regime, or
volume unknown — that would be a borderline TAKE in regular hours is a
SKIP overnight. A clean setup (trend + strong RS + healthy RSI) is still
a TAKE overnight.

BAD-DAY RULE: if the bot has 3+ closed losers and is net negative today,
raise the bar — the tape may not fit this strategy today; approve only
setups you'd call clearly strong, not merely acceptable.

SKIP ONLY for a CONCRETE, SPECIFIC reason — not a vague feeling:
- The setup's OWN description states the volume is unavailable/unknown for
  this ticker (i.e. literally says so) — that alone is NOT a red flag by
  itself; do not treat "unavailable" as if it meant "zero." Only skip on
  volume grounds if a REAL number is shown and it looks thin for a move
  this size.
- The stock is at or through a well-known, specific resistance level you
  can name (not just "some resistance might exist somewhere")
- This is a DISCOVERED (not watchlist) lower-priced ticker (roughly under
  $10) with an extreme move and no VERIFIED catalyst — a legitimate
  manipulation/pump red flag. A day move beyond ~25-30% is a pump TOP
  regardless of price, headlines, or how strong the technicals look —
  generic "top movers today" headlines are NOT a catalyst and do not
  excuse this.
- A SWING plan where nothing about the move suggests it's a multi-day
  story (pure single-session spike with no news, no trend history)
- Something in the plan is internally inconsistent or doesn't add up

CALIBRATION: across many plans you should approve MOST clean watchlist
setups in regular hours and reject most pump-profile discoveries. If you
notice you would approve absolutely everything (or reject everything),
you are mis-calibrated — the two rules above (SESSION, BAD-DAY) are where
legitimate SKIPs on watchlist names come from. Be CONSISTENT: the same
facts must always produce the same decision.

Respond with JSON only, no markdown:
{
  "decision": "TAKE" | "SKIP",
  "confidence": 1-10,
  "reasoning": "one or two sentences, citing the SPECIFIC concrete fact that drove your decision"
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
