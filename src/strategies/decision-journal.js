// src/strategies/decision-journal.js
//
// v4 NEW MODULE — STRUCTURED, ANALYZABLE DECISION LOGGING.
//
// Winston logs are for humans watching the bot live. This journal is for
// ANALYSIS: every decision the bot makes — scans, gate blocks, candidate
// rejections (with the exact stage and reason), plans built, AI verdicts,
// trades opened and closed with their full plan echoed back — is appended
// as ONE JSON object per line to a daily file:
//
//   data/journal/decisions-YYYY-MM-DD.jsonl
//
// One-per-line JSON means the whole history is trivially analyzable later:
//   - load into pandas / a script / even Claude for weekly review
//   - answer questions like "what % of DISCOVERED swing trades hit T2?",
//     "which rejection stage kills the most candidates?", "does the CHOP
//     penalty actually improve outcomes?"
//
// EVENT TYPES (the `event` field):
//   SCAN_START, SCAN_SKIPPED, GATE_BLOCK, DISCOVERY_RESULT,
//   CANDIDATE_REJECTED, CANDIDATE_SCORED, PLAN_BUILT, PLAN_REJECTED,
//   AI_DECISION, TRADE_OPENED, EXIT_DECISION, TRADE_CLOSED, EOD_SUMMARY,
//   ERROR
//
// Writing NEVER throws — a journaling failure must never break trading.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { logger } = require("../logger");

const journalDirectory = path.join(__dirname, "../../data/journal");

function getJournalFilePathForToday() {
  const todayDate = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  }); // YYYY-MM-DD in market time so a trading day = one file
  return path.join(journalDirectory, "decisions-" + todayDate + ".jsonl");
}

function getBahrainTimeString() {
  return new Date().toLocaleString("en-US", {
    timeZone: "Asia/Bahrain",
    hour12: true,
  });
}

// Append one event. `payload` is any JSON-serializable object.
function appendEvent(eventType, payload) {
  try {
    if (!fs.existsSync(journalDirectory)) {
      fs.mkdirSync(journalDirectory, { recursive: true });
    }
    const record = {
      ts: new Date().toISOString(),
      bahrainTime: getBahrainTimeString(),
      event: eventType,
      ...payload,
    };
    fs.appendFileSync(
      getJournalFilePathForToday(),
      JSON.stringify(record) + "\n",
    );
  } catch (journalError) {
    // Never let journaling break trading — log once and move on.
    logger.warn("Decision journal write failed: " + journalError.message);
  }
}

// Convenience wrappers so call sites read cleanly and field names stay
// consistent across the codebase (consistency is what makes the file
// analyzable later).
const journal = {
  scanStart: (context) => appendEvent("SCAN_START", context),
  scanSkipped: (reason, context) =>
    appendEvent("SCAN_SKIPPED", { reason, ...context }),
  gateBlock: (gate, reason) => appendEvent("GATE_BLOCK", { gate, reason }),
  discoveryResult: (discoveredSymbols) =>
    appendEvent("DISCOVERY_RESULT", { discoveredSymbols }),
  candidateRejected: (symbol, stage, reason, snapshot) =>
    appendEvent("CANDIDATE_REJECTED", { symbol, stage, reason, snapshot }),
  candidateScored: (candidate) =>
    appendEvent("CANDIDATE_SCORED", {
      symbol: candidate.symbol,
      source: candidate.source || "WATCHLIST",
      setup: candidate.setup,
      score: candidate.score,
      rsi: candidate.rsi,
      relativeStrength: candidate.relativeStrength,
      aboveVwap: candidate.aboveVwap,
      atrPercent: candidate.atrPercent,
    }),
  planBuilt: (plan) => appendEvent("PLAN_BUILT", { plan }),
  // v7.11: `snapshot` carries the STRUCTURED state at rejection time.
  //
  // Until now the only machine-readable field was the reason string, with
  // the score buried in prose ("score 58 below the entry floor of 80") and
  // no price recorded at all. That makes the most important question of the
  // coming month unanswerable: "what would a floor of 65 have earned?"
  // needs a number and an entry price to measure forward returns from.
  //
  // With ~90% of candidates rejected by the floor, these records are the
  // bulk of the evidence — a month of few trades still yields thousands of
  // labelled counterfactuals. Optional and backward compatible.
  planRejected: (symbol, rejectReason, snapshot) =>
    appendEvent("PLAN_REJECTED", {
      symbol,
      rejectReason,
      ...(snapshot ? { snapshot } : {}),
    }),
  // v7: `analysis` carries the model's structured reads (separated market /
  // technical / risk verdicts, the named disqualifier, what data it could not
  // see, and the reviewer's probability estimates). Optional and backward
  // compatible — the point is that a decision can be audited later against
  // the evidence it claimed, instead of one sentence that scrolled past.
  aiDecision: (symbol, decision, confidence, reasoning, analysis) =>
    appendEvent("AI_DECISION", {
      symbol,
      decision,
      confidence,
      reasoning,
      ...(analysis ? { analysis } : {}),
    }),
  tradeOpened: (plan) => appendEvent("TRADE_OPENED", { plan }),
  exitDecision: (symbol, action, reason, currentPrice, meta) =>
    appendEvent("EXIT_DECISION", {
      symbol,
      action,
      reason,
      currentPrice,
      tradeType: meta?.tradeType || "DAY",
      entryPrice: meta?.entryPrice,
      heldMinutes: meta?.openedAt
        ? Math.round((Date.now() - meta.openedAt) / 60000)
        : null,
    }),
  tradeClosed: (outcome) => appendEvent("TRADE_CLOSED", outcome),
  // Observation-only: what price did AFTER a time-based exit (see
  // exit-shadow-tracker.js) — never affects trading, just builds evidence
  // for whether DT_MAX_HOLD_MINUTES should change.
  exitShadowCheckpoint: (data) => appendEvent("EXIT_SHADOW_CHECKPOINT", data),
  eodSummary: (summary) => appendEvent("EOD_SUMMARY", summary),
  error: (where, message) => appendEvent("ERROR", { where, message }),
};

module.exports = journal;
