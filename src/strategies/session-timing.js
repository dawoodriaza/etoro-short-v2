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
const marketHours = require("../market-hours"); // P0 fix: single ET clock source

// Get current ET hour/minute using the same approach as market-hours.js
// P0 FIX (2026-07-27): delegated to market-hours.js so there is exactly ONE
// implementation of "what time is it in New York" in the codebase. The old
// local copy parsed `hour12: false`, which on the production server's Node
// 20 returns hour 24 at 00:xx ET — see the block comment in market-hours.js.
function getEasternHourMinute() {
  return marketHours.getEasternHourMinute();
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

// v6 (2026-07-21): PRE-OPEN / OPEN-VOLATILITY BUY BLACKOUT — pure TIME
// check only (kept out of isNewEntryAllowed on purpose: SPY-weakness is
// evaluated by the caller, which already has a fresh SPY quote fetched for
// the regime classifier — this module stays free of a market-data
// dependency). True from (open - preOpenBlackoutMinutesBefore) through
// (open + postOpenBlackoutMinutesAfter) ET.
//
// WHY THIS IS A SEPARATE GATE, NOT PART OF isNewEntryAllowed: in 24/5 mode
// (config.trade24_5 = true, confirmed live on this deployment),
// isNewEntryAllowed() above returns {allowed:true} immediately and skips
// every check in this file — there is currently NO pre-open protection at
// all when 24/5 trading is on. The caller applies this blackout regardless
// of trade24_5, closing that gap.
function isInPreOpenBlackoutWindow() {
  const { hour, minute } = getEasternHourMinute();
  const sinceOpen = minutesSinceOpen(hour, minute); // negative before 9:30 ET
  return (
    sinceOpen >= -config.preOpenBlackoutMinutesBefore &&
    sinceOpen < config.postOpenBlackoutMinutesAfter
  );
}

// ══════════════════════════════════════════════════════════════════════
// v7.4 — OVERNIGHT DEAD ZONE (Eastern time).
//
// Measured across 114 closed trades: ALL 16 trades entered between 00:00
// and 04:00 ET lost money, netting -$170.05 at a 31% win rate. Crucially
// the conviction-score filter does NOT rescue this window — the three
// high-score overnight trades lost fastest of all, -$27.07 each against a
// 0% win rate. Every other session is profitable once the score gate is
// applied, so 24/5 trading stays enabled and only this window closes.
//
// Mechanically this window has: no session volume to measure, a regime
// classifier that is definitionally blind (it needs 45 minutes of regular
// session), the widest spreads of the day, and too little liquidity for a
// position to move in your favour before the open gaps it.
//
// Deliberately independent of DT_TRADE_24_5 — that flag bypasses every
// other session gate, which is exactly why this one cannot rely on it.
// Blocks NEW ENTRIES only; exits, stops and EOD closes never consult it.
function isInOvernightDeadZone(atDate) {
  if (!config.overnightDeadZoneEnabled) return false;
  const { hour } = atDate
    ? marketHours.getEasternHourMinute(atDate)
    : getEasternHourMinute();
  const start = config.overnightDeadZoneStartHourET;
  const end = config.overnightDeadZoneEndHourET;
  if (start === end) return false;
  // Handles a window that wraps past midnight as well as a simple one.
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

module.exports = {
  isNewEntryAllowed,
  getEasternHourMinute,
  isInPreOpenBlackoutWindow,
  isInOvernightDeadZone,
};
