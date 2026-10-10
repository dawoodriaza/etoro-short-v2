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

// ── v9.1 — THE SHADOW LOG (data/shadow-log/) ────────────────────────────
//
// Two things the decision journal does NOT answer, both asked for by the
// owner, both LOGGING ONLY — nothing here can place, hold or close a real
// order:
//
//   paper-YYYY-MM-DD.jsonl      What would have happened if the bot had
//                               bought the moment the AI approved, instead
//                               of waiting for a dip. One PAPER_OPEN when an
//                               order is armed, a PAPER_MARK every minute,
//                               one PAPER_CLOSE when the SAME risk engine
//                               says that paper position would have exited.
//                               Makes "the dip never came and it would have
//                               been profitable" answerable from the log
//                               rather than from a replay weeks later.
//
//   minute-YYYY-MM-DD.jsonl     One line per REAL open position per minute:
//                               price, P&L, peak, the live stop and its kind,
//                               the state, and the exact exit conditions the
//                               engine is waiting on. POSITION_STATUS already
//                               records this but only every 10th tick, so
//                               "why didn't it sell here" had 10-minute holes
//                               in it. This has none.
//
// Kept in its own folder and its own files so the per-minute volume (a few
// thousand lines a day) cannot bloat the decision journal that every review
// script reads. Writing never throws, exactly as below.
const shadowDirectory = path.join(__dirname, "../../data/shadow-log");

function appendShadow(kind, eventType, payload) {
  try {
    if (!fs.existsSync(shadowDirectory)) {
      fs.mkdirSync(shadowDirectory, { recursive: true });
    }
    const todayDate = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
    fs.appendFileSync(
      path.join(shadowDirectory, kind + "-" + todayDate + ".jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        bahrainTime: getBahrainTimeString(),
        event: eventType,
        ...payload,
      }) + "\n",
      "utf8",
    );
  } catch (shadowError) {
    logger.warn("Shadow log write failed: " + shadowError.message);
  }
}

// Open paper positions survive a restart — otherwise every deploy silently
// truncates the comparison the folder exists to make.
const paperStatePath = path.join(shadowDirectory, "open-paper.json");

function readPaperState() {
  try {
    return JSON.parse(fs.readFileSync(paperStatePath, "utf8"));
  } catch {
    return {};
  }
}

function writePaperState(state) {
  try {
    if (!fs.existsSync(shadowDirectory)) {
      fs.mkdirSync(shadowDirectory, { recursive: true });
    }
    fs.writeFileSync(paperStatePath, JSON.stringify(state, null, 1), "utf8");
  } catch (stateError) {
    logger.warn("Shadow paper state write failed: " + stateError.message);
  }
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
  // v8: one record per scan — how many candidates survived each stage, why
  // the rest died, and which gate (if any) ended the scan. Answers "why did
  // it not trade?" without reconstructing it from thousands of rejections.
  scanFunnel: (funnel) => appendEvent("SCAN_FUNNEL", funnel),
  // v8: periodic per-position management state (HOLD / TRIM / RUNNER /
  // WEAKENING / EXIT) with P&L, peak, effective stop and the next trigger.
  positionStatus: (status) => appendEvent("POSITION_STATUS", status),
  // v8.1: realized account equity vs the capital ledger, whenever the gap is
  // material — the trail that makes an "unexplained equity change" traceable.
  equityDrift: (drift) => appendEvent("EQUITY_DRIFT", drift),
  // v8.1: one record per candidate per scan — its scan-time features and what
  // the bot finally did with it (see strategies/shadow-signals.js).
  shadowSignal: (signal) => appendEvent("SHADOW_SIGNAL", signal),
  // v8.2: an approved stock waiting to be bought on a dip — ARMED, then
  // FILLED / BLOCKED_AT_FILL / EXPIRED / CANCELLED, with the deepest dip seen.
  dipEntry: (details) => appendEvent("DIP_ENTRY", details),
  // v9.1 shadow log — logging only, see the block comment above
  paperOpen: (details) => appendShadow("paper", "PAPER_OPEN", details),
  paperMark: (details) => appendShadow("paper", "PAPER_MARK", details),
  paperClose: (details) => appendShadow("paper", "PAPER_CLOSE", details),
  positionMinute: (details) => appendShadow("minute", "POSITION_MINUTE", details),
  readPaperState,
  writePaperState,
  error: (where, message) => appendEvent("ERROR", { where, message }),
};

module.exports = journal;
