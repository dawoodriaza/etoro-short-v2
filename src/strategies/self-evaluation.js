// src/strategies/self-evaluation.js
//
// Reads the bot's own trade history and finds patterns — which setups work,
// which regimes hurt, whether high-score entries actually perform better.
// Produces a plain-English report with SUGGESTIONS, never auto-applied
// changes. You read it, you decide, you change config.js or .env yourself.
//
// Why not auto-apply? With a novice trader and a small sample of trades
// (dozens, not thousands), auto-tuning thresholds off recent history is how
// bots overfit to noise — a few unlucky trades in a choppy week can look
// like "this setup doesn't work" when it was really just a bad week for
// EVERYTHING. A human check-in prevents that trap.
require("dotenv").config();
const { logger } = require("../logger");
const performance = require("./performance-tracker");
const { escapeHtml, toRealDollars } = require("../notifications/format-helpers");

const MIN_TRADES_FOR_SUGGESTION = 15; // don't suggest changes on tiny samples
const MIN_TRADES_FOR_SUB_ANALYSIS = 8; // regime/session breakdowns need fewer since they're narrower cuts

// v8.1: judged on the whole trade (partials included, estimated for pre-v8
// records) — the raw runner-only pnlDollars made targeted winners look like
// losers and skewed every finding below.
function winRate(trades) {
  if (trades.length === 0) return null;
  const wins = trades.filter((t) => performance.tradeResultDollars(t) > 0).length;
  return (wins / trades.length) * 100;
}
function totalPnl(trades) {
  return trades.reduce((sum, t) => sum + performance.tradeResultDollars(t), 0);
}
function avgHoldMinutes(trades) {
  const withHold = trades.filter((t) => typeof t.heldMinutes === "number");
  if (withHold.length === 0) return null;
  return withHold.reduce((sum, t) => sum + t.heldMinutes, 0) / withHold.length;
}

// ── Individual analyses, each returns { finding, suggestion } or null ──────

function analyzeBySetup(trades) {
  const bySetup = {};
  for (const t of trades) {
    const key = t.setup || "UNKNOWN";
    (bySetup[key] = bySetup[key] || []).push(t);
  }
  const findings = [];
  for (const [setup, setupTrades] of Object.entries(bySetup)) {
    if (setupTrades.length < MIN_TRADES_FOR_SUB_ANALYSIS) continue;
    const wr = winRate(setupTrades);
    const pnl = totalPnl(setupTrades);
    findings.push({
      setup,
      trades: setupTrades.length,
      winRate: wr,
      pnl,
      finding:
        setup +
        ": " +
        setupTrades.length +
        " trades, " +
        wr.toFixed(0) +
        "% win rate, " +
        (pnl >= 0 ? "+" : "") +
        "$" +
        toRealDollars(pnl).toFixed(2) +
        " total",
      suggestion:
        wr < 35 && setupTrades.length >= MIN_TRADES_FOR_SUGGESTION
          ? "Win rate is low (" +
            wr.toFixed(0) +
            "%) over a meaningful sample (" +
            setupTrades.length +
            " trades). Consider disabling or tightening " +
            setup +
            " (e.g. raise its volume/RSI thresholds in config.js)."
          : null,
    });
  }
  return findings;
}

function analyzeByRegime(trades) {
  const byRegime = { TRENDING: [], CHOP: [], UNKNOWN: [] };
  for (const t of trades) {
    const regime = t.entryConditions?.regime || "UNKNOWN";
    (byRegime[regime] = byRegime[regime] || []).push(t);
  }
  const findings = [];
  for (const [regime, regimeTrades] of Object.entries(byRegime)) {
    if (regimeTrades.length < MIN_TRADES_FOR_SUB_ANALYSIS) continue;
    const wr = winRate(regimeTrades);
    findings.push({
      regime,
      trades: regimeTrades.length,
      winRate: wr,
      finding:
        regime +
        " regime: " +
        regimeTrades.length +
        " trades, " +
        wr.toFixed(0) +
        "% win rate",
    });
  }
  // Compare CHOP vs TRENDING directly if both have enough data
  const chop = byRegime.CHOP;
  const trending = byRegime.TRENDING;
  let suggestion = null;
  if (
    chop.length >= MIN_TRADES_FOR_SUB_ANALYSIS &&
    trending.length >= MIN_TRADES_FOR_SUB_ANALYSIS
  ) {
    const chopWr = winRate(chop);
    const trendWr = winRate(trending);
    if (trendWr - chopWr > 20) {
      suggestion =
        "CHOP-regime trades win " +
        chopWr.toFixed(0) +
        "% of the time vs " +
        trendWr.toFixed(0) +
        "% in TRENDING markets — a " +
        (trendWr - chopWr).toFixed(0) +
        "-point gap over " +
        chop.length +
        "+" +
        trending.length +
        " trades. Consider raising DT_CHOP_REGIME_SCORE_PENALTY " +
        "to be more selective in choppy conditions.";
    }
  }
  return { findings, suggestion };
}

function analyzeByScore(trades) {
  const withScore = trades.filter(
    (t) => typeof t.entryConditions?.score === "number",
  );
  if (withScore.length < MIN_TRADES_FOR_SUGGESTION) return null;
  const highScore = withScore.filter((t) => t.entryConditions.score >= 70);
  const lowScore = withScore.filter((t) => t.entryConditions.score < 70);
  if (
    highScore.length < MIN_TRADES_FOR_SUB_ANALYSIS ||
    lowScore.length < MIN_TRADES_FOR_SUB_ANALYSIS
  ) {
    return null;
  }
  const highWr = winRate(highScore);
  const lowWr = winRate(lowScore);
  return {
    finding:
      "Score ≥70 entries: " +
      highScore.length +
      " trades, " +
      highWr.toFixed(0) +
      "% win rate. Score <70 entries: " +
      lowScore.length +
      " trades, " +
      lowWr.toFixed(0) +
      "% win rate.",
    suggestion:
      highWr - lowWr > 15
        ? "Higher-scored setups are winning meaningfully more often (" +
          highWr.toFixed(0) +
          "% vs " +
          lowWr.toFixed(0) +
          "%). Consider raising DT_MAX_CANDIDATES filtering or being more " +
          "selective — the score is doing real work."
        : lowWr - highWr > 15
          ? "Counter-intuitively, lower-scored setups are winning MORE than " +
            "high-scored ones. This suggests the scoring weights may need " +
            "review — worth flagging to whoever built the scanner logic."
          : null,
  };
}

function analyzeByExitReason(trades) {
  const byReason = {};
  for (const t of trades) {
    const key = t.exitReason || "UNKNOWN";
    (byReason[key] = byReason[key] || []).push(t);
  }
  return Object.entries(byReason)
    .filter(([, list]) => list.length >= MIN_TRADES_FOR_SUB_ANALYSIS)
    .map(([reason, list]) => ({
      reason,
      trades: list.length,
      pnl: totalPnl(list),
      finding:
        reason +
        ": " +
        list.length +
        " trades, " +
        (totalPnl(list) >= 0 ? "+" : "") +
        "$" +
        toRealDollars(totalPnl(list)).toFixed(2),
    }));
}

function analyzeHoldTime(trades) {
  const avg = avgHoldMinutes(trades);
  if (avg == null || trades.length < MIN_TRADES_FOR_SUGGESTION) return null;
  return {
    avgHoldMinutes: avg,
    finding: "Average hold time: " + avg.toFixed(0) + " minutes",
  };
}

// v5.1 — TIER 3 UPGRADE: does the daily AI position reviewer's EXTEND
// decision (DAY → SWING, see models/ai-position-reviewer.js) actually help?
// Compares trades the reviewer extended against otherwise-similar DAY-
// originated trades that were NOT extended. This is the retrospective
// check the review asked for: "of the positions extended past their
// original close date, how many of those extensions paid off?"
function analyzeExtendedTrades(trades) {
  const dayOriginated = trades.filter(
    (t) => t.entryConditions?.tradeType !== "SWING", // opened as DAY, not natively SWING
  );
  const extended = dayOriginated.filter((t) => t.extendedByReviewer === true);
  const notExtended = dayOriginated.filter((t) => !t.extendedByReviewer);

  if (extended.length < MIN_TRADES_FOR_SUB_ANALYSIS) {
    return {
      hasEnoughData: false,
      extendedCount: extended.length,
      finding:
        extended.length +
        " reviewer-extended trade(s) so far — need " +
        MIN_TRADES_FOR_SUB_ANALYSIS +
        "+ for a meaningful comparison.",
    };
  }

  const extendedWr = winRate(extended);
  const extendedPnl = totalPnl(extended);
  const extendedAvgPnl = extendedPnl / extended.length;
  const baselineWr = notExtended.length ? winRate(notExtended) : null;
  const baselineAvgPnl = notExtended.length
    ? totalPnl(notExtended) / notExtended.length
    : null;

  // v7.5: extendedAvgPnl / baselineAvgPnl / the $1 suggestion threshold
  // below are all bot-account dollars and stay that way — they're only
  // compared against EACH OTHER, and that comparison is scale-invariant.
  // Only the STRINGS shown to the user are converted.
  const comparisonText =
    baselineWr != null
      ? " vs " +
        baselineWr.toFixed(0) +
        "% win rate / $" +
        toRealDollars(baselineAvgPnl).toFixed(2) +
        " avg for non-extended DAY trades (" +
        notExtended.length +
        ")"
      : " (no non-extended DAY trades to compare against yet)";

  let suggestion = null;
  if (baselineWr != null && notExtended.length >= MIN_TRADES_FOR_SUB_ANALYSIS) {
    if (extendedAvgPnl < baselineAvgPnl - 1) {
      suggestion =
        "Reviewer-extended trades are UNDERPERFORMING non-extended DAY " +
        "trades ($" +
        toRealDollars(extendedAvgPnl).toFixed(2) +
        " vs $" +
        toRealDollars(baselineAvgPnl).toFixed(2) +
        " avg). Consider raising DT_REVIEWER_MIN_CONF_EXTEND so only " +
        "higher-conviction extensions are allowed.";
    } else if (extendedAvgPnl > baselineAvgPnl + 1) {
      suggestion =
        "Reviewer-extended trades are OUTPERFORMING non-extended DAY " +
        "trades ($" +
        toRealDollars(extendedAvgPnl).toFixed(2) +
        " vs $" +
        toRealDollars(baselineAvgPnl).toFixed(2) +
        " avg) — the EXTEND mechanism appears to be adding real value.";
    }
  }

  return {
    hasEnoughData: true,
    extendedCount: extended.length,
    extendedWinRate: extendedWr,
    extendedAvgPnl,
    finding:
      "Reviewer EXTENDED " +
      extended.length +
      " trade(s): " +
      extendedWr.toFixed(0) +
      "% win rate, $" +
      toRealDollars(extendedAvgPnl).toFixed(2) +
      " avg P&L" +
      comparisonText,
    suggestion,
  };
}

function analyzeByArchetype(trades) {
  const byArchetype = {};
  for (const t of trades) {
    const key = t.plan?.archetype || "UNKNOWN";
    (byArchetype[key] = byArchetype[key] || []).push(t);
  }
  return Object.entries(byArchetype)
    .filter(([, list]) => list.length >= MIN_TRADES_FOR_SUB_ANALYSIS)
    .map(([archetype, list]) => ({
      archetype,
      trades: list.length,
      winRate: winRate(list),
      pnl: totalPnl(list),
      finding:
        archetype +
        ": " +
        list.length +
        " trades, " +
        winRate(list).toFixed(0) +
        "% win rate, " +
        (totalPnl(list) >= 0 ? "+" : "") +
        "$" +
        toRealDollars(totalPnl(list)).toFixed(2),
    }));
}

// ── Main report generator ───────────────────────────────────────────────────
function generateSelfEvaluation() {
  const history = performance.loadHistory();
  if (history.length < MIN_TRADES_FOR_SUB_ANALYSIS) {
    return {
      hasEnoughData: false,
      trades: history.length,
      message:
        "Only " +
        history.length +
        " trades recorded so far — need at least " +
        MIN_TRADES_FOR_SUB_ANALYSIS +
        " for a meaningful self-evaluation. Check back after more trading days.",
    };
  }

  const overallStats = performance.computeStats(history);
  const bySetup = analyzeBySetup(history);
  const regimeAnalysis = analyzeByRegime(history);
  const scoreAnalysis = analyzeByScore(history);
  const byExitReason = analyzeByExitReason(history);
  const holdTime = analyzeHoldTime(history);
  const archetypeAnalysis = analyzeByArchetype(history); // v5.1
  const extendedAnalysis = analyzeExtendedTrades(history); // v5.1 Tier-3 loop-close

  const suggestions = [
    ...bySetup.map((f) => f.suggestion).filter(Boolean),
    regimeAnalysis.suggestion,
    scoreAnalysis?.suggestion,
    extendedAnalysis?.suggestion,
  ].filter(Boolean);

  return {
    hasEnoughData: true,
    totalTrades: history.length,
    overallStats,
    bySetup,
    regimeFindings: regimeAnalysis.findings,
    scoreAnalysis,
    byExitReason,
    holdTime,
    archetypeFindings: archetypeAnalysis,
    extendedAnalysis,
    suggestions,
  };
}

// ── Plain-English Telegram formatting (novice-friendly, no jargon dump) ────
function formatSelfEvaluationForTelegram(report) {
  if (!report.hasEnoughData) {
    return "📈 <b>Weekly Self-Evaluation</b>\n\n" + escapeHtml(report.message);
  }

  const lines = ["📈 <b>Weekly Self-Evaluation</b>", ""];
  lines.push(
    "Over the last " +
      report.totalTrades +
      " trades: " +
      report.overallStats.winRate.toFixed(0) +
      "% win rate, " +
      (report.overallStats.totalPnl >= 0 ? "+" : "") +
      "$" +
      toRealDollars(report.overallStats.totalPnl).toFixed(2) +
      " total.",
  );
  lines.push("");

  if (report.bySetup.length > 0) {
    lines.push("<b>By setup type:</b>");
    report.bySetup.forEach((f) => lines.push("• " + escapeHtml(f.finding)));
    lines.push("");
  }

  if (report.regimeFindings.length > 0) {
    lines.push("<b>By market condition:</b>");
    report.regimeFindings.forEach((f) =>
      lines.push("• " + escapeHtml(f.finding)),
    );
    lines.push("");
  }

  if (report.scoreAnalysis) {
    lines.push("<b>Setup quality check:</b>");
    lines.push("• " + escapeHtml(report.scoreAnalysis.finding));
    lines.push("");
  }

  if (report.holdTime) {
    lines.push("<b>Timing:</b> " + escapeHtml(report.holdTime.finding));
    lines.push("");
  }

  if (report.archetypeFindings && report.archetypeFindings.length > 0) {
    lines.push("<b>By archetype:</b>");
    report.archetypeFindings.forEach((f) =>
      lines.push("• " + escapeHtml(f.finding)),
    );
    lines.push("");
  }

  if (report.extendedAnalysis) {
    lines.push("<b>Daily reviewer EXTEND decisions:</b>");
    lines.push("• " + escapeHtml(report.extendedAnalysis.finding));
    lines.push("");
  }

  if (report.suggestions.length > 0) {
    lines.push(
      "💡 <b>Suggestions to consider</b> (nothing changes automatically — you decide):",
    );
    report.suggestions.forEach((s, i) =>
      lines.push(i + 1 + ". " + escapeHtml(s)),
    );
  } else {
    lines.push(
      "No strong patterns yet — keep collecting data. Nothing concerning stands out.",
    );
  }

  return lines.join("\n");
}

module.exports = { generateSelfEvaluation, formatSelfEvaluationForTelegram };
