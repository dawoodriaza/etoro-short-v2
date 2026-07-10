// src/strategies/session-timing.js
//
// Time-of-day awareness. Intraday dynamics differ sharply by session:
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

  // Skip the opening auction window
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
