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
      // v7.10: shown in the operator's clock (computed live so it tracks
      // US daylight saving), with the ET anchor kept for traceability.
      return {
        allowed: false,
        reason:
          "Before pre-market window (opens " +
          marketHours.easternClockToLogZone(config.premarketStartHourET) +
          " " +
          marketHours.getLogTimeZoneLabel() +
          " / " +
          config.premarketStartHourET +
          ":00 ET)",
      };
    }
    return {
      allowed: false,
      reason:
        "Pre-market — regular session opens at " +
        marketHours.easternClockToLogZone(9, 30) +
        " " +
        marketHours.getLogTimeZoneLabel() +
        " (9:30 AM ET, " +
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

// ══════════════════════════════════════════════════════════════════════
// v8 — ENTRY CUTOFFS AROUND THE EOD FORCE-CLOSE (Eastern time).
//
// The EOD cron runs once, at (16:00 - forceCloseMinutesBeforeClose) ET, and
// only closes what is open at that moment. In 24/5 mode nothing stopped a
// new entry straight after it: META (07-10), META + GOOGL (07-31) and PLTR
// (08-07) were all opened on a Friday after 15:45 ET and carried into a
// weekend during which the exit monitor does not run at all.
//
// The pre-close window is the smaller, evidence-sized part: Mon-Thu
// entries in the last 30 minutes went 2 wins / 7, -$113, mostly
// force-closed before their own time budget could play out. Entries AFTER
// the Mon-Thu close remain allowed on purpose — that cohort was 8/12,
// +$81, and 24/5 mode holds it overnight by design.
const ET_WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
});
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function getEntryCutoffStatus(atDate) {
  const when = atDate || new Date();
  const weekday = WEEKDAY_INDEX[ET_WEEKDAY_FORMATTER.format(when)];
  const { hour, minute } = marketHours.getEasternHourMinute(when);
  const nowMinute = hour * 60 + minute;
  const forceCloseMinute = 16 * 60 - config.forceCloseMinutesBeforeClose;
  // v8.9: 12-hour for the reader — this label reaches Telegram in the
  // "dip order cancelled" message.
  const forceCloseLabel =
    marketHours.to12h(Math.floor(forceCloseMinute / 60), forceCloseMinute % 60) + " ET";

  if (weekday === 5 && config.fridayCloseAll && nowMinute >= forceCloseMinute) {
    return {
      blocked: true,
      gate: "FRIDAY_AFTER_CLOSE",
      reason:
        "the Friday " +
        forceCloseLabel +
        " force-close has run — a position opened now would be held all " +
        "weekend with no exit monitor",
    };
  }

  const windowMinutes =
    weekday === 5
      ? config.fridayNoEntryMinutesBeforeClose
      : config.eodNoEntryMinutesBeforeClose;
  if (
    weekday >= 1 &&
    weekday <= 5 &&
    windowMinutes > 0 &&
    nowMinute < forceCloseMinute &&
    nowMinute >= forceCloseMinute - windowMinutes
  ) {
    return {
      blocked: true,
      gate: "PRE_EOD_CLOSE",
      reason:
        "within " +
        windowMinutes +
        " min of the " +
        forceCloseLabel +
        " force-close — a new DAY trade would be closed before its time budget",
    };
  }

  return { blocked: false };
}

module.exports = {
  isNewEntryAllowed,
  getEasternHourMinute,
  isInPreOpenBlackoutWindow,
  isInOvernightDeadZone,
  getEntryCutoffStatus,
};
