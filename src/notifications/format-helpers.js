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
  TRAILING_STOP: {
    trigger: "📉 Trailing-Stop Guard",
    detail: "price pulled back from its peak far enough to trigger the trailing stop on the runner",
  },
  TIME_EXIT_STALE: {
    trigger: "⏱️ Time-Based Cleanup",
    detail: "held past the max time window without enough profit to justify staying in",
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

module.exports = { escapeHtml, humanize, describeExitReason };
