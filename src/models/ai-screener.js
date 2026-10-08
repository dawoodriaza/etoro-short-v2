// src/models/ai-screener.js
//
// THE ENTRY RISK GATE. One fast Haiku call per fully-formed trade plan,
// returning a decisive TAKE/SKIP veto. The AI never sets prices — trade
// planner geometry is authoritative.
//
// ═══════════════════════════════════════════════════════════════════════
// v7 (2026-07-25) — FULL PROMPT REWRITE.
//
// WHY THE ROLE IS "RISK OFFICER", NOT "PORTFOLIO MANAGER":
//   This call answers one binary question about one already-sized,
//   already-priced plan. Casting it as a portfolio manager would invite
//   it to re-do work it cannot do here — sizing, target selection,
//   portfolio construction — and every such invitation historically
//   turned into a rationalised rejection. The PM role lives in
//   ai-position-reviewer.js, where the model genuinely manages open risk
//   across a book. Matching the role to the actual decision is what makes
//   an institutional framing help rather than hurt.
//
// STRUCTURAL CHANGES FROM v6:
//   1. SYSTEM/USER SPLIT. Everything invariant (role, method, decision
//      rules, output contract) moved to a `system` string that is byte-
//      identical for every candidate in a scan. Everything that varies
//      (the evidence) is the user turn. This separates instruction from
//      data, which is what stops the model treating a data quirk as a
//      new instruction.
//   2. REASONING BEFORE VERDICT. The response JSON emits evidence checks
//      and three separated reads FIRST and `decision` LAST. JSON is
//      generated top-to-bottom, so the verdict is conditioned on reasoning
//      the model has already committed to in writing. This is deliberately
//      cheaper than extended thinking (~60 output tokens vs 1024+ minimum
//      thinking budget) and it lands in the journal, where thinking tokens
//      would not.
//   3. EXPLICIT `disqualifier` SLOT. The model must name the single
//      concrete blocking fact or write null. This directly targets the
//      v5.6.1 pathology (~100% rejection on vague, rationalisation-shaped
//      objections): a SKIP now requires filling a named-fact slot, and a
//      null disqualifier with a TAKE is the natural, low-effort path.
//   4. EVIDENCE SUFFICIENCY IS A FIELD, NOT A HOPE. `unavailableData`
//      forces the model to enumerate what it could NOT see before it
//      reasons, so absent data is stated rather than imagined.
//   5. CONFIDENCE MUST BE EXPLAINED. A bare 1-10 integer is unfalsifiable;
//      `confidenceRationale` makes the number auditable in the journal.
//
// EVERY v5.x/v6 BEHAVIOURAL FIX IS PRESERVED — each was traced from real
// production misbehaviour and dropping one would regress the bot:
//   · exact overnight thresholds (the model invented stricter ones)
//   · BAD-DAY rule computed in code and stated as fact
//   · "volume unavailable" must never be read as "zero volume"
//   · verified catalyst vs generic headline
//   · discovered-microcap pump profile
//   · default-to-TAKE when nothing concrete is wrong
require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const { logger } = require("../logger");
const config = require("../config");
const { sectorBucketFor } = require("../strategies/risk-manager");
// NOTE: market-context is deliberately NOT required here. The brief is built
// once per scan in index.js and passed in as context.briefText — importing it
// would add a needless require edge into etoro-client from a leaf module, and
// this codebase has already been bitten once by a circular require (see the
// v5 header in momentum-scanner.js, which silently killed every scan cycle).
const alerts = require("../notifications/alerts");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── SYSTEM PROMPT ──────────────────────────────────────────────────────────
// Invariant across every candidate in a scan. Keep it that way: anything
// varying per candidate belongs in the user turn.
const SCREENER_SYSTEM_PROMPT = `You are the entry risk officer on a systematic trading desk, holding the final veto on trade plans that already cleared the desk's quantitative filters.

ALREADY ENFORCED IN CODE — settled, do not re-litigate: VWAP trend, relative strength vs SPY, RSI band, volume floor, risk/reward geometry, sizing, stop and target placement, sector caps, cooldowns. Re-arguing these is the most common failure in this seat. In particular, RSI is already confirmed inside the acceptable band — never reject on RSI alone unless it is genuinely extreme.

YOUR ONLY QUESTION: is there a concrete, nameable fact making this plan untrustworthy DESPITE passing them?
Yes -> SKIP and name it. No -> TAKE. "Could fade" is not a reason: no trade is certain, and demanding certainty rejects everything.

METHOD — assess separately, then decide:
- MARKET: does the tape support new long risk? Use TONE, index alignment, breadth, volatility. Indices disagreeing is a caution, not a veto.
- TECHNICAL: does the setup hold on its own evidence — trend, RSI, relative strength, VWAP, volume?
- RISK: does geometry and exposure fit — stop vs this stock's ATR, size, sector already held, event proximity?
- DECIDE: market and risk can veto a good chart; a good chart cannot rescue a bad market read.

EVIDENCE RULES:
- "unavailable"/"unknown"/"n/a" means THE DESK COULD NOT MEASURE IT — not zero, and never itself a reason to skip.
- Never invent a price level, news event, earnings date, analyst action or peer move. Any numeric threshold you cite must be printed in this prompt.
- You have no browsing and no memory of prior scans.
- List what you needed but did not get in unavailableData; if it is load-bearing, lower confidence rather than guessing.

CONSISTENCY: identical evidence must always produce an identical verdict. Apply thresholds as written, not by feel; let confidence carry uncertainty, not the verdict.

CONFIDENCE 1-10 describes the strength of the EVIDENCE, not how much you like the trade: 1-3 thin or contradictory, 4-5 workable, 6-7 clean and factors agree, 8-10 strong alignment.

A SKIP REQUIRES ONE OF THESE, stated concretely:
- Named specific overhead resistance the plan must clear.
- Pump profile: a DISCOVERED ticker under ~$10 with an extreme move and no VERIFIED catalyst. A day move beyond ~25-30% is a pump top regardless of price, headline or technicals; generic "top movers" headlines are not catalysts.
- A SWING plan with no multi-day story — lone intraday spike, no trend history, no catalyst.
- A REAL printed volume number that is thin for a move this size. Never merely-unavailable volume.
- The session rule or bad-day rule in the user message applies.
- The plan contradicts itself.

CALIBRATION: across many plans, approve most clean watchlist setups in regular hours and reject most pump-profile discoveries. Approving everything and rejecting everything are both miscalibrations.

OUTPUT — JSON only, no markdown, no text outside the object, fields in this order:
{"unavailableData":"fields you needed but were not given, or: none","marketRead":"<=15 words","technicalRead":"<=15 words","riskRead":"<=15 words","disqualifier":"the ONE concrete blocking fact, or null","decision":"TAKE"|"SKIP","confidence":1-10,"confidenceRationale":"<=20 words naming what set this"}
disqualifier must be null whenever decision is TAKE.`;

// ── USER TURN: the evidence for ONE candidate ──────────────────────────────
function buildScreenerEvidence(plan, currentPositions, context) {
  const heldSymbols =
    (currentPositions || []).map((position) => position.symbol).join(", ") ||
    "none";
  const sector = sectorBucketFor(plan.symbol);

  // v5.7 preserved: NEWS_HIT is a GENERIC headline tag whose sentiment was
  // never checked. Presenting it as "Catalyst:" once got a +478% pump
  // approved twice. Only ANALYST_UPGRADE / INSIDER_BUY are verified.
  const isVerifiedCatalyst =
    plan.catalyst === "ANALYST_UPGRADE" || plan.catalyst === "INSIDER_BUY";
  const catalystLine = plan.catalystLabel
    ? isVerifiedCatalyst
      ? "Catalyst (VERIFIED " + plan.catalyst + "): " + plan.catalystLabel
      : "Headline (GENERIC, sentiment unverified — NOT a catalyst): " +
        plan.catalystLabel
    : "Catalyst: none";

  // v6 preserved: the BAD-DAY rule's applicability is computed
  // DETERMINISTICALLY in risk-manager (3+ losing closes AND net negative)
  // and stated as a fact. It is not the model's job to do the arithmetic.
  const todayPnl = context?.todayPnl;
  const badDayApplies = !!todayPnl?.badDayRuleApplies;
  const todayLine = todayPnl
    ? todayPnl.tradesClosed +
      " closed today (" +
      (todayPnl.losingTrades || 0) +
      " losers), won $" +
      todayPnl.realizedWin.toFixed(2) +
      " / lost $" +
      todayPnl.realizedLoss.toFixed(2)
    : "no trades closed yet today";

  const sectorMomentum = context?.brief
    ? describeSectorMomentum(context.brief, sector)
    : "unavailable";

  const briefBlock = context?.briefText || "MARKET BRIEF: unavailable.";

  const sessionLine = context?.session || "REGULAR";
  const isOvernight = sessionLine !== "REGULAR";

  return `${briefBlock}
SESSION: ${sessionLine}
DESK RESULTS TODAY: ${todayLine}
BAD-DAY RULE: ${badDayApplies ? "IN EFFECT — approve only setups you would call clearly strong" : "does NOT apply — do not mention today's P&L in your reasoning; a small red number is normal variance"} (computed in code; do not re-derive)
CURRENTLY HELD: ${heldSymbols}
${isOvernight ? buildSessionRuleBlock() : ""}
── INSTRUMENT: ${plan.symbol} ──
Sector: ${sector} · sector momentum today: ${sectorMomentum}
Source: ${plan.source}${plan.isFirstTimeDiscovered ? " (first-ever trade in this name — already half-sized)" : ""}
Daily ATR: ${plan.atrPercent != null ? plan.atrPercent + "% (volatility bucket " + plan.volatilityBucket + ")" : "unavailable"}
Avg dollar volume: ${plan.averageDollarVolume != null ? "$" + Number(plan.averageDollarVolume).toLocaleString("en-US") : "unavailable"}
${catalystLine}

── TECHNICAL ──
Setup: ${plan.setup} — ${plan.setupDetail}
Trend read: ${plan.trendDirection} · RSI ${plan.rsi ?? "unavailable"} · RS vs SPY ${plan.relativeStrength != null ? plan.relativeStrength.toFixed(2) + " pts" : "unavailable"} · ${plan.aboveVwap ? "above" : "below/at"} VWAP
Desk score: ${plan.score != null ? Number(plan.score).toFixed(0) + "/100" : "unavailable"}

── PLAN GEOMETRY (fixed — you do not set these) ──
Type: ${plan.tradeType}${plan.tradeType === "SWING" ? " (1-10 day hold, closes Friday at latest)" : " (intraday, force-closed before the US close)"} · Archetype: ${plan.archetype || "n/a"}
Entry $${plan.entryPrice} · Stop $${plan.stopPrice} (-${plan.stopDistancePct}%) · T1 $${plan.targetT1} · T2 $${plan.targetT2}${plan.targetT3 ? " · T3 $" + plan.targetT3 : ""}
Risk $${plan.riskDollars} (${plan.riskPctOfCapital}% of capital) · RRR ${plan.riskRewardRatio}

Return the JSON verdict for ${plan.symbol}.`;
}

// v6 preserved verbatim in substance: exact thresholds. The model repeatedly
// invented stricter ones ("RSI 66 is near the ceiling", "1.5 RS needed
// overnight") and rejected clean setups on numbers nobody configured.
function buildSessionRuleBlock() {
  return `
SESSION RULE (overnight only): thinner books, so demand a REAL warning signal. Overnight, volume is ALWAYS unavailable and regime ALWAYS UNKNOWN — that is the NORMAL STATE of an overnight scan, never a warning sign, alone or combined.
An overnight SKIP requires one of these EXACT conditions; do not invent others:
- RSI >= 74 (the overextended ceiling is 78; RSI 66 is NOT "near the ceiling" — never claim a lower ceiling such as 70)
- trend read is SIDEWAYS
- relative strength strictly under 1.0 pt vs SPY (1.2-1.8 is adequate — never invent a higher bar such as 1.5)
None present -> a BULLISH setup with healthy RSI and solid RS is a TAKE, overnight or not.
`;
}

// Stock-specific market context: is this name's own sector leading or lagging
// right now? Answers item 13's "evaluate a stock within its sector's context"
// using data the scan already computed.
function describeSectorMomentum(brief, sectorBucket) {
  if (!brief || !sectorBucket) return "unavailable";
  const leader = (brief.sectorLeaders || []).find(
    (entry) => entry.bucket === sectorBucket,
  );
  if (leader) {
    return "LEADING (" + leader.changePct.toFixed(2) + "% proxy move)";
  }
  const laggard = (brief.sectorLaggards || []).find(
    (entry) => entry.bucket === sectorBucket,
  );
  if (laggard) {
    return "LAGGING (" + laggard.changePct.toFixed(2) + "% proxy move)";
  }
  return "no decisive proxy move (or no mapped proxy for this sector)";
}

// ── Response parsing ───────────────────────────────────────────────────────
//
// v7: hardened. In v6 a stray sentence, a markdown fence variant, or a
// response truncated by max_tokens threw inside JSON.parse, and because the
// screener is fail-closed that meant the plan was silently SKIPPED. With
// every plan in a scan hitting the same failure at once, the bot simply
// stopped trading while looking healthy. Extracting the outermost JSON
// object first survives every one of those cases that is actually
// recoverable, and a genuine failure still fails closed — but now says so.
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

function clampConfidence(rawConfidence) {
  const parsed = parseInt(rawConfidence, 10);
  if (isNaN(parsed)) return 5;
  return Math.min(10, Math.max(1, parsed));
}

// Collapse the structured reads into one journal/Telegram-friendly line,
// so the existing consumers of `reasoning` keep working unchanged.
function composeReasoning(parsed) {
  const parts = [
    parsed.disqualifier ? "BLOCKER: " + parsed.disqualifier : null,
    parsed.marketRead ? "Market: " + parsed.marketRead : null,
    parsed.technicalRead ? "Technical: " + parsed.technicalRead : null,
    parsed.riskRead ? "Risk: " + parsed.riskRead : null,
    parsed.confidenceRationale ? "Confidence: " + parsed.confidenceRationale : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

async function screenCandidate(plan, currentPositions, context) {
  try {
    const response = await anthropic.messages.create({
      model: config.aiModel, // v8.7: one setting, see config.js
      // Haiku 5.5 thinks by default and its thinking is billed against
      // max_tokens; off by default here so a long reasoning pass cannot
      // truncate the JSON verdict. See config.aiThinking.
      ...(config.aiThinking ? {} : { thinking: { type: "disabled" } }),
      max_tokens: config.screenerMaxTokens,
      system: SCREENER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildScreenerEvidence(plan, currentPositions, context),
        },
      ],
    });

    const text = (response.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    const parsed = extractJsonObject(text);
    if (!parsed || (parsed.decision !== "TAKE" && parsed.decision !== "SKIP")) {
      throw new Error(
        "unparseable screener response" +
          (response.stop_reason === "max_tokens"
            ? " (hit max_tokens — raise DT_SCREENER_MAX_TOKENS)"
            : ""),
      );
    }

    const confidence = clampConfidence(parsed.confidence);

    // Confidence floor enforced in CODE, not trusted to the prompt.
    if (parsed.decision === "TAKE" && confidence < config.screenerMinConfidenceToTake) {
      logger.info(
        "🤖 " +
          plan.symbol +
          ": TAKE at confidence " +
          confidence +
          " is below floor " +
          config.screenerMinConfidenceToTake +
          " — downgraded to SKIP",
      );
      return {
        symbol: plan.symbol,
        decision: "SKIP",
        confidence,
        reasoning:
          "Low-confidence TAKE (" +
          confidence +
          "/10) downgraded by confidence floor · " +
          composeReasoning(parsed),
        analysis: parsed,
        errored: false,
      };
    }

    return {
      symbol: plan.symbol,
      decision: parsed.decision,
      confidence,
      reasoning: composeReasoning(parsed),
      // Structured fields kept intact for the decision journal — this is
      // what makes the reasoning auditable after the fact instead of a
      // sentence that scrolled past in a log.
      analysis: {
        unavailableData: parsed.unavailableData || "none",
        marketRead: parsed.marketRead || "",
        technicalRead: parsed.technicalRead || "",
        riskRead: parsed.riskRead || "",
        disqualifier: parsed.disqualifier || null,
        confidenceRationale: parsed.confidenceRationale || "",
      },
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

// v8 — IDENTICAL PLANS ARE NOT RE-SCREENED.
//
// Scans run every 10 minutes and a quiet or frozen tape rebuilds the same
// plan at the same price: 1,553 of 7,015 plans in the journal were
// identical-price re-plans within 30 minutes (AMD alone was re-screened 24
// times at a frozen $477.385 after the 2026-09-04 close). Each was a paid
// Haiku call, and the verdicts flip-flopped on identical evidence. Within
// config.screenerDedupeMinutes the previous verdict is reused; errored
// verdicts are never cached, so a transient failure is retried.
const recentVerdictsByFingerprint = new Map();

function planFingerprint(plan) {
  return [
    plan.symbol,
    plan.tradeType,
    Number(plan.entryPrice).toFixed(4),
    Math.round(Number(plan.score) || 0),
  ].join("|");
}

// Screen multiple PLANS in parallel (one Haiku call each).
async function screenCandidates(plans, currentPositions, context) {
  if (!plans || plans.length === 0) return [];
  const dedupeMs = Math.max(0, config.screenerDedupeMinutes || 0) * 60000;
  const nowMs = Date.now();
  for (const [key, entry] of recentVerdictsByFingerprint) {
    if (nowMs - entry.atMs > dedupeMs) recentVerdictsByFingerprint.delete(key);
  }
  const results = await Promise.all(
    plans.map(async (plan) => {
      const fingerprint = planFingerprint(plan);
      const cached = dedupeMs > 0 ? recentVerdictsByFingerprint.get(fingerprint) : null;
      if (cached) {
        return { ...cached.result, symbol: plan.symbol, reusedVerdict: true };
      }
      const result = await screenCandidate(plan, currentPositions, context);
      if (!result.errored && dedupeMs > 0) {
        recentVerdictsByFingerprint.set(fingerprint, { atMs: Date.now(), result });
      }
      return result;
    }),
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
    await alerts.clearAlert(
      "AI_SCREENER",
      "AI entry screener is responding again (" +
        results.length +
        " plan(s) screened).",
    );
  }

  const taken = results.filter((result) => result.decision === "TAKE");
  const reusedCount = results.filter((result) => result.reusedVerdict).length;
  logger.info(
    "🤖 AI screener: " +
      taken.length +
      "/" +
      results.length +
      " plans approved" +
      (reusedCount ? " (" + reusedCount + " identical plan(s) reused a recent verdict)" : ""),
  );
  return results;
}

module.exports = {
  screenCandidates,
  planFingerprint,
  // Exported for tests and for token measurement.
  buildScreenerEvidence,
  extractJsonObject,
  describeSectorMomentum,
  SCREENER_SYSTEM_PROMPT,
};
