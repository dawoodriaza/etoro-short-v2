// src/market-hours.js — reused as-is from the long-term bot, plus a Bahrain
// time helper for console logging (Bahrain time only, 12-hour AM/PM format).

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
function getMarketTime() {
  const now = new Date();

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIME_ZONE,
    hour12: false,
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
    hour: get("hour"),
    minute: get("minute"),
    weekday: etDate.getDay(),
    date: etDate.toLocaleDateString("en-CA"),
  };
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
function getCurrentBahrainTime() {
  return new Date().toLocaleString("en-US", {
    timeZone: "Asia/Bahrain",
    hour12: true,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
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

module.exports = {
  getMarketTime,
  isWeekendET,
  isUSMarketHoliday,
  isRegularMarketHours,
  isExtendedHours,
  shouldRunAnalysisCycle,
  getMarketStatus,
  getCurrentBahrainTime,
  getDebugSnapshot,
};
