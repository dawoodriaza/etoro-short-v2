// src/notifications/format-helpers.js
//
// Shared helpers for building Telegram messages under HTML parse mode.
//
// WHY THIS EXISTS: every message was built with Telegram's legacy "Markdown"
// parse mode, which treats a single underscore as an italic delimiter. Any
// two enum-style strings in the SAME message containing underscores
// (MOMENTUM_SURGE, TIME_EXIT_STALE, MOMENTUM_BREAKOUT, ...) got their
// underscores silently swallowed by Telegram — "MOMENTUM_SURGE" rendered as
// "MOMENTUMSURGE", "TIME_EXIT_STALE" as "TIMEEXITSTALE". HTML parse mode
// doesn't treat underscore as special at all, so switching removes the bug
// at the source; humanize() then makes the enum values pleasant to read.
const config = require("../config");

// Converts an AGENT PORTFOLIO dollar amount to YOUR real dollar amount,
// using the copy ratio (config.realAccountCapital / config.dayTradeCapital).
// Display-only — every internal risk/sizing calculation stays in agent
// dollars; this only touches what Telegram messages show you.
function toRealDollars(agentDollars) {
  if (typeof agentDollars !== "number" || isNaN(agentDollars)) return agentDollars;
  const ratio = config.realAccountCapital / config.dayTradeCapital;
  return agentDollars * ratio;
}

// v7.3 — THE ONE WAY TO PRINT MONEY IN A TELEGRAM MESSAGE.
//
// Takes an AGENT-account dollar figure and renders YOUR amount first, with
// the bot-account figure in brackets:  "$114.63 (bot $3275.00)"
//
// Why both: before this, the trade messages were scaled to the real account
// while every system alert printed raw agent dollars. The same position
// therefore appeared as "$114.63" in one message and "$3275.00" in the
// next, which made a genuine incident (a phantom withdrawal on 2026-07-31)
// far harder to read than it needed to be. Showing one number hides which
// account you are looking at; showing both makes it unambiguous and keeps
// Telegram reconcilable against the logs, portfolio-check and the ledger —
// all of which report agent dollars.
//
// When no separate real-account allocation is configured the ratio is 1 and
// the bracket is omitted, so single-account users see no clutter.
//
// v7.5: the bot-dollar bracket is now OFF by default — every Telegram
// figure shows only the real (copy-account) amount, per explicit request.
// Pass { includeBotAmount: true } at a call site that specifically needs
// the bracket back (e.g. for debugging a fill-mismatch investigation).
//
// NOTE: a few of these strings are also written to the log file verbatim —
// systemAlert() in alerts.js logs the exact same text it sends to Telegram.
// Those specific log lines (fill-mismatch/ghost/untracked-position alerts)
// will therefore show real-account dollars too, while the rest of the log
// file (position sizing, plan lines, scan output — none of which call this
// helper) continues to show bot-account dollars as before.
function formatDualAmount(agentDollars, options = {}) {
  if (typeof agentDollars !== "number" || isNaN(agentDollars)) {
    return String(agentDollars);
  }
  const ratio = config.realAccountCapital / config.dayTradeCapital;
  const signed = options.signed === true;
  const includeBotAmount = options.includeBotAmount === true;
  const render = (value) =>
    (signed && value >= 0 ? "+$" : value < 0 ? "-$" : "$") +
    Math.abs(value).toFixed(2);

  if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 1e-9) {
    return render(agentDollars);
  }
  const realAmount = render(agentDollars * ratio);
  return includeBotAmount
    ? realAmount + " (bot " + render(agentDollars) + ")"
    : realAmount;
}

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// "MOMENTUM_SURGE" -> "Momentum Surge", "TIME_EXIT_STALE" -> "Time Exit Stale",
// "SWING_T1_HIT" -> "Swing Target 1 Hit" (T1/T2/T3 are the profit targets).
function humanize(enumString) {
  if (!enumString) return "";
  return String(enumString)
    .split("_")
    .map(
      (word) =>
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ")
    .replace(/\bT([123])\b/g, "Target $1");
}

// Maps every exit-reason code to WHICH guard/mechanism triggered it and a
// plain-English explanation — so a CLOSED message says "Stop-Loss Guard:
// price hit the protective stop" instead of just "Stop Loss".
const EXIT_REASON_INFO = {
  STOP_LOSS: {
    trigger: "🛑 Stop-Loss Guard",
    detail: "price hit the protective stop before any profit was banked",
  },
  BREAKEVEN_STOP: {
    trigger: "⚖️ Breakeven Guard",
    detail:
      "trade was well in profit earlier, so the stop had been raised to entry — closed at roughly breakeven instead of a loss",
  },
  TRAILING_STOP: {
    trigger: "📉 Trailing-Stop Guard",
    detail: "price pulled back from its peak far enough to trigger the trailing stop on the runner",
  },
  MFE_GIVEBACK: {
    trigger: "💎 Profit-Keeper Guard",
    detail:
      "the trade gave back too much of its best profit (volatility-adjusted limit) — banked what was left instead of letting it decay further",
  },
  AGED_PROFIT_PROTECT: {
    trigger: "⏳ Aged-Trade Profit Guard",
    detail:
      "the trade was getting old and had already peaked in profit — took what was left as it faded rather than letting it turn into a loss",
  },
  TIME_EXIT_STALE: {
    trigger: "⏱️ Time-Based Cleanup",
    detail: "held past the max time window without enough profit to justify staying in",
  },
  STALE_RECOVERED: {
    trigger: "♻️ Recovered to Breakeven",
    detail:
      "time ran out while the trade was red; instead of selling at a loss the bot waited, and sold once it was back at breakeven",
  },
  SWING_STOP: {
    trigger: "🛑 Stop-Loss Guard",
    detail: "price hit the swing stop before any profit was locked in",
  },
  SWING_FLOOR_LOCK: {
    trigger: "🔒 Profit-Floor Guard",
    detail: "price pulled back to the ratcheted floor — exiting with the locked-in gain",
  },
  SWING_T3_COMPLETE: {
    trigger: "🏁 Final Target Reached",
    detail: "hit the last profit target — full plan completed",
  },
  SWING_TRAIL: {
    trigger: "📉 Trailing-Stop Guard",
    detail: "price pulled back from its peak far enough to trigger the swing trailing stop",
  },
  SWING_TIME_EXIT: {
    trigger: "⏱️ Max Hold Time",
    detail: "held the maximum allowed days for a swing trade",
  },
  EOD_FORCE_CLOSE: {
    trigger: "🔔 End-of-Day Rule",
    detail: "day-trade rule — force-closed before today's US market close",
  },
  FRIDAY_FORCE_CLOSE: {
    trigger: "🔔 Friday Close-All Rule",
    detail: "zero weekend exposure rule — everything closes before Friday's close",
  },
};

// Returns { trigger, detail } — falls back to a humanized reason if a new
// exit code is ever added here without an update.
function describeExitReason(reasonCode) {
  return (
    EXIT_REASON_INFO[reasonCode] || {
      trigger: humanize(reasonCode),
      detail: null,
    }
  );
}

module.exports = {
  escapeHtml,
  humanize,
  describeExitReason,
  toRealDollars,
  formatDualAmount,
};
