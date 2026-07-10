// src/strategies/session-timing.js
//
// Time-of-day awareness. Intraday dynamics differ sharply by session:
//   - Pre-market (before 9:30 ET): regular session hasn't started at all
//   - First few minutes after open: extreme volatility, wide spreads → skip
//   - Lunch chop (≈11:30-14:00 ET): low conviction, choppy → skip new entries
//   - Power hour and the rest: normal trading
//
// Returns whether NEW entries are allowed right now (exits always allowed).
require("dotenv").config();
const config = require("../config");

// Get current ET hour/minute using the same approach as market-hours.js
function getEasternHourMinute() {
  const now = new Date();
  const etString = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const [hourStr, minStr] = etString.split(":");
  return { hour: parseInt(hourStr), minute: parseInt(minStr) };
}

function minutesSinceOpen(hour, minute) {
  // market opens 9:30 ET
  return (hour - 9) * 60 + (minute - 30);
}

function isNewEntryAllowed() {
  const { hour, minute } = getEasternHourMinute();
  const sinceOpen = minutesSinceOpen(hour, minute);

  // 24/5 mode: the bot trades eToro's overnight-eligible names around the
  // clock, so the intraday micro-timing rules below (pre-market block,
  // opening-auction skip, lunch chop) don't apply — the market-hours gate
  // has already confirmed the 24/5 session is open. Allow the entry.
  if (config.trade24_5) {
    return { allowed: true, reason: "24/5 trading mode" };
  }

  // Regular session hasn't started yet at all (still pre-market) — this is
  // NOT the same as "just opened, spreads still settling." Distinguish them
  // so the log/Telegram message tells the truth about what's happening.
  //
  // PRE-MARKET ENTRIES (config.allowPremarketEntries):
  //   Off by default. When ON, entries are allowed once we're inside the
  //   pre-market window that begins config.premarketStartHourET ET (default
  //   4:00 = eToro extended-hours open). BEFORE that hour we still block,
  //   because there is no real two-sided market yet.
  //   ⚠️ REALITY CHECK: eToro executes most equity orders at the regular
  //   session. An order placed pre-market is typically QUEUED to the 9:30 ET
  //   open, so "pre-market" here mainly means "evaluate + queue early," not
  //   "fill at the pre-market price." Enable eyes-open.
  if (sinceOpen < 0) {
    if (config.allowPremarketEntries) {
      const nowMinutes = hour * 60 + minute;
      const premarketStartMinutes = config.premarketStartHourET * 60;
      if (nowMinutes >= premarketStartMinutes) {
        return { allowed: true, reason: "pre-market entries enabled" };
      }
      return {
        allowed: false,
        reason:
          "Before pre-market window (opens " +
          config.premarketStartHourET +
          ":00 ET)",
      };
    }
    return {
      allowed: false,
      reason:
        "Pre-market — regular session opens at 9:30 AM ET (" +
        Math.abs(sinceOpen) +
        " min from now)",
    };
  }

  // Skip the opening auction window (genuinely just opened, 0 to N min in)
  if (sinceOpen < config.skipFirstMinutesAfterOpen) {
    return {
      allowed: false,
      reason: "Opening auction window — waiting for spreads to settle",
    };
  }

  // Skip lunch chop
  if (config.skipLunchChop) {
    const afterLunchStart =
      hour > config.lunchStartHourET ||
      (hour === config.lunchStartHourET && minute >= config.lunchStartMinET);
    const beforeLunchEnd =
      hour < config.lunchEndHourET ||
      (hour === config.lunchEndHourET && minute < config.lunchEndMinET);
    if (afterLunchStart && beforeLunchEnd) {
      return {
        allowed: false,
        reason: "Lunch chop window — skipping new entries",
      };
    }
  }

  return { allowed: true };
}

module.exports = { isNewEntryAllowed, getEasternHourMinute };
