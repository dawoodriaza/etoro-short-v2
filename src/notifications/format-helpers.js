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

module.exports = { escapeHtml, humanize };
