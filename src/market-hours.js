// src/market-hours.js — reused as-is from the long-term bot, plus a Bahrain
// time helper for console logging (Bahrain time only, 12-hour AM/PM format).
//
// dotenv MUST be loaded here, not inherited: TRADE_24_5 below is read from
// process.env at MODULE LOAD time. Without this line it only worked because
// index.js happened to load dotenv earlier in its require chain — any
// standalone script requiring this module first would silently get 24/5
// mode OFF and revert the analysis window to 4 AM-8 PM ET.
require("dotenv").config();

const ET_TIME_ZONE = "America/New_York";

// US market holidays
const US_MARKET_HOLIDAYS_2026 = new Set([
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
]);

// -------------------------
// SINGLE ET SNAPSHOT (CORE FIX)
// -------------------------
// ═══════════════════════════════════════════════════════════════════════
// P0 FIX (2026-07-27) — THE MIDNIGHT HOUR-24 BUG.
//
// `hour12: false` does NOT pin the hour cycle. On Node 20 (which is what
// the production server runs — v20.20.2) it resolves to the h24 cycle, so
// 00:30 ET formats as "24:30" and parses to hour === 24. On Node 22 the
// same call yields "00:30". The bug is therefore INVISIBLE in local
// testing and only ever appears in production.
//
// Confirmed on the server:
//   node v20.20.2 · 00:30 ET → "24:30" → hour 24
//   both toLocaleString AND Intl.formatToParts are affected
//
// What it broke, every day between 00:00 and 00:59 ET:
//   · market-regime.js  (24-9)*60 = 900 minutes "since the open", clamped
//     to 390 — a dead overnight tape was classified as a COMPLETED
//     trading session, from stale range data.
//   · market-data.js    RVOL compared midnight volume against a FULL
//     day's expected volume, crushing volumeRatio and penalising every
//     candidate. (The guard above it returns null for pre-market, but
//     900 > 0 sailed straight past it.)
//   · this file         every hour comparison in isRegularMarketHours /
//     isExtendedHours / getMarketStatus saw hour 24.
//
// Observed live on 2026-07-27: scans at 00:00 and 00:30 ET approved 0/3
// plans; the 01:00 ET scan — the moment the bug stopped firing — approved
// 6/6 and opened five positions at once.
//
// THE FIX: pin hourCycle to "h23" (verified on the server to return 0),
// and normalise defensively afterwards so a future runtime quirk cannot
// reintroduce this silently.
// ═══════════════════════════════════════════════════════════════════════
function normaliseHour(rawHour) {
  return Number.isFinite(rawHour) ? rawHour % 24 : rawHour;
}

function getMarketTime() {
  const now = new Date();

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIME_ZONE,
    hourCycle: "h23", // NOT hour12:false — see the block comment above
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = dtf.formatToParts(now);

  const get = (type) => Number(parts.find((p) => p.type === type)?.value);

  const etDate = new Date(
    now.toLocaleString("en-US", { timeZone: ET_TIME_ZONE }),
  );

  return {
    hour: normaliseHour(get("hour")),
    minute: get("minute"),
    weekday: etDate.getDay(),
    date: etDate.toLocaleDateString("en-CA"),
  };
}

// THE single source of truth for "what time is it in New York". Every
// module that used to roll its own hour12:false parse now calls this, so
// the fix above can never drift out of sync between modules again.
// `atDate` is optional and exists so tests can pin a moment in time.
function getEasternHourMinute(atDate) {
  const when = atDate || new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIME_ZONE,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(when);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { hour: normaliseHour(get("hour")), minute: get("minute") };
}

// Minutes since the 09:30 ET open. NEGATIVE before the open — callers rely
// on that sign to tell "pre-market" from "the session is running".
function getMinutesSinceEasternOpen(atDate) {
  const { hour, minute } = getEasternHourMinute(atDate);
  return (hour - 9) * 60 + (minute - 30);
}

// -------------------------
function isWeekendET() {
  const { weekday } = getMarketTime();
  return weekday === 0 || weekday === 6;
}

function isUSMarketHoliday() {
  const { date } = getMarketTime();
  return US_MARKET_HOLIDAYS_2026.has(date);
}

function minutesSinceMidnight(hour, minute) {
  return hour * 60 + minute;
}

// -------------------------
// SESSION LOGIC (FIXED & CLEAN)
// -------------------------
function isRegularMarketHours() {
  if (isWeekendET() || isUSMarketHoliday()) return false;

  const { hour, minute } = getMarketTime();
  const t = minutesSinceMidnight(hour, minute);

  const OPEN = 9 * 60 + 30;
  const CLOSE = 16 * 60;

  return t >= OPEN && t < CLOSE;
}

function isExtendedHours() {
  if (isWeekendET() || isUSMarketHoliday()) return false;

  const { hour, minute } = getMarketTime();
  const t = minutesSinceMidnight(hour, minute);

  const EXT_OPEN = 4 * 60;
  const EXT_CLOSE = 20 * 60;

  return t >= EXT_OPEN && t < EXT_CLOSE;
}

// -------------------------
// 24/5 TRADING (eToro overnight-eligible stocks: TSLA, NVDA, AAPL, META, …)
// -------------------------
// eToro lets you trade a set of popular US stocks nearly around the clock,
// 5 days a week — roughly a CONTINUOUS session from Sunday 20:00 ET through
// Friday 20:00 ET. When DT_TRADE_24_5=true the bot's analysis/exit cycle
// runs across that whole window instead of only 4:00–20:00 ET, so it can
// enter and manage these names overnight like a manual trader would.
//
// eToro may still have brief daily maintenance breaks and only fills the
// 24/5-eligible instruments — a non-eligible order outside regular hours
// just fails, and the bot already alerts + retries on open failures. Read
// straight from env to keep this module dependency-free (no config import).
const TRADE_24_5 = process.env.DT_TRADE_24_5 === "true";

function is24x5MarketOpen() {
  // Keep US holidays closed — eligibility/fills are unreliable on holidays.
  if (isUSMarketHoliday()) return false;

  const { weekday, hour, minute } = getMarketTime();
  const t = minutesSinceMidnight(hour, minute);
  const SUNDAY_OPEN = 20 * 60; // Sunday 8:00 PM ET
  const FRIDAY_CLOSE = 20 * 60; // Friday 8:00 PM ET

  if (weekday === 6) return false; // Saturday — closed
  if (weekday === 0) return t >= SUNDAY_OPEN; // Sunday — opens 8 PM ET
  if (weekday === 5) return t < FRIDAY_CLOSE; // Friday — closes 8 PM ET
  return true; // Mon–Thu — open all day
}

function shouldRunAnalysisCycle() {
  if (TRADE_24_5) return is24x5MarketOpen();
  return isRegularMarketHours() || isExtendedHours();
}

function getMarketStatus() {
  if (TRADE_24_5) return is24x5MarketOpen() ? "TRADING_24_5" : "24_5_CLOSED";
  if (isWeekendET()) return "WEEKEND_CLOSED";
  if (isUSMarketHoliday()) return "HOLIDAY_CLOSED";
  if (isRegularMarketHours()) return "REGULAR_HOURS";
  if (isExtendedHours()) return "EXTENDED_HOURS";
  return "CLOSED";
}

// -------------------------
// Console/log wall-clock time. The timezone used to be hardcoded to
// Asia/Bahrain; it is now configurable, because a hardcoded label silently
// lies the moment you travel — logs kept reading "7:00 AM Bahrain" while
// the operator was in Pakistan (UTC+5), two hours ahead. Read straight
// from process.env rather than via config.js so this module stays
// dependency-free and cannot participate in a require cycle.
//
// Set DT_LOG_TIMEZONE to any IANA zone, e.g. Asia/Karachi.
const LOG_TIME_ZONE = process.env.DT_LOG_TIMEZONE || "Asia/Bahrain";
// Label shown next to the time — defaults to the city part of the zone.
const LOG_TIME_ZONE_LABEL =
  process.env.DT_LOG_TIMEZONE_LABEL ||
  LOG_TIME_ZONE.split("/").pop().replace(/_/g, " ");

function getCurrentLocalTime() {
  return new Date().toLocaleString("en-US", {
    timeZone: LOG_TIME_ZONE,
    hour12: true,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getLogTimeZoneLabel() {
  return LOG_TIME_ZONE_LABEL;
}

// Kept as an alias so existing callers keep working unchanged; it now
// honours DT_LOG_TIMEZONE like everything else.
function getCurrentBahrainTime() {
  return getCurrentLocalTime();
}

// -------------------------
function getDebugSnapshot() {
  const { hour, minute } = getMarketTime();
  return {
    etHour: hour,
    etMinute: minute,
    minutesSinceMidnight: hour * 60 + minute,
    status: getMarketStatus(),
  };
}

// v7.2 — OVERNIGHT SCAN FREEZE. Wall-clock, in the LOG timezone (Bahrain by
// default, configurable — see LOG_TIME_ZONE above), NOT tied to the US
// session. Purely a cost/quiet-hours control: it blocks NEW-TRADE scanning
// only. Deliberately independent of every US-market concept (ET, sessions,
// holidays) because it's answering a different question — "is it the
// operator's overnight" — not "is the market open."
function getOvernightFreezeWindow() {
  return {
    enabled: process.env.DT_OVERNIGHT_FREEZE_ENABLED !== "false", // default ON
    startHour: Number(process.env.DT_OVERNIGHT_FREEZE_START_HOUR ?? 23),
    startMinute: Number(process.env.DT_OVERNIGHT_FREEZE_START_MIN ?? 30),
    endHour: Number(process.env.DT_OVERNIGHT_FREEZE_END_HOUR ?? 9),
    endMinute: Number(process.env.DT_OVERNIGHT_FREEZE_END_MIN ?? 30),
    // v7.4: which clock the window is measured against. Defaults to the
    // log timezone (the operator's own wall clock), which is right when
    // the freeze exists for quiet hours.
    //
    // Set DT_OVERNIGHT_FREEZE_TIMEZONE=America/New_York to anchor it to
    // the MARKET clock instead. That matters because Bahrain has no DST
    // and the US does: a window fixed in Bahrain time silently slides an
    // hour against the market twice a year. Anchored to ET, a 00:00-04:00
    // freeze always covers exactly the overnight dead zone — and quietly
    // becomes 07:00-11:00 Bahrain in summer, 08:00-12:00 in winter, with
    // no intervention.
    timeZone:
      process.env.DT_OVERNIGHT_FREEZE_TIMEZONE || LOG_TIME_ZONE,
  };
}

// Human label for whichever clock the freeze window is measured against.
// Must NOT reuse the log-timezone label: once the window is anchored to
// America/New_York while logs still read Bahrain, printing "Bahrain" beside
// an ET window is actively misleading — it made a correctly-frozen 03:37 ET
// scan look like a bug at 10:37 Bahrain.
function getFreezeTimeZoneLabel() {
  const zone = getOvernightFreezeWindow().timeZone;
  if (zone === "America/New_York") return "ET";
  return zone.split("/").pop().replace(/_/g, " ");
}

// True when "now" (in LOG_TIME_ZONE) falls inside [start, end), where the
// window crosses midnight (e.g. 23:30 -> 09:30 next day).
function isInOvernightFreezeWindow(atDate) {
  const window = getOvernightFreezeWindow();
  if (!window.enabled) return false;

  const when = atDate || new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: window.timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(when);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const nowMinuteOfDay = normaliseHour(get("hour")) * 60 + get("minute");

  const startMinuteOfDay = window.startHour * 60 + window.startMinute;
  const endMinuteOfDay = window.endHour * 60 + window.endMinute;

  if (startMinuteOfDay === endMinuteOfDay) return false; // degenerate: no window
  if (startMinuteOfDay < endMinuteOfDay) {
    // Window does not cross midnight (not this bot's default, but handled).
    return nowMinuteOfDay >= startMinuteOfDay && nowMinuteOfDay < endMinuteOfDay;
  }
  // Crosses midnight: "in the window" means >= start OR < end.
  return nowMinuteOfDay >= startMinuteOfDay || nowMinuteOfDay < endMinuteOfDay;
}

module.exports = {
  getMarketTime,
  isWeekendET,
  isUSMarketHoliday,
  isRegularMarketHours,
  isExtendedHours,
  shouldRunAnalysisCycle,
  getMarketStatus,
  getCurrentBahrainTime,
  getCurrentLocalTime,
  getLogTimeZoneLabel,
  getDebugSnapshot,
  // P0 fix: the single source of truth for Eastern wall-clock time.
  getEasternHourMinute,
  getMinutesSinceEasternOpen,
  normaliseHour,
  getOvernightFreezeWindow,
  isInOvernightFreezeWindow,
  getFreezeTimeZoneLabel,
};
