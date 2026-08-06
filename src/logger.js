// src/logger.js
// Centralised logger — records all decisions, trades, and errors with timestamps.
// Also maintains:
//   - trade-journal.json  : every buy/sell with reasoning
//   - performance.json    : portfolio snapshots for daily/weekly reports
//   - peak-equity.json    : tracks all-time high for drawdown protection

const winston = require("winston");
const path = require("path");
const fs = require("fs");

// v7.5 — LOG TIMESTAMPS IN THE OPERATOR'S TIMEZONE, NOT SERVER UTC.
//
// The server's system clock is Etc/UTC (verified via `timedatectl`), and
// winston.format.timestamp() stamps every line from that clock. Every log
// line in this file has therefore always been printed in UTC — three hours
// behind what every "X Bahrain" message in the console output implied.
//
// Reuses the same DT_LOG_TIMEZONE the rest of the bot already uses for its
// "Bahrain" labels (see market-hours.js), read directly from process.env
// rather than requiring config.js — this module must stay dependency-free
// so nothing can create a require cycle through it.
const LOG_DISPLAY_TIME_ZONE = process.env.DT_LOG_TIMEZONE || "Asia/Bahrain";

function formatLogTimestamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOG_DISPLAY_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(new Date())
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return (
    parts.year +
    "-" +
    parts.month +
    "-" +
    parts.day +
    " " +
    parts.hour +
    ":" +
    parts.minute +
    ":" +
    parts.second
  );
}

const logDirectory = path.join(__dirname, "../logs");
if (!fs.existsSync(logDirectory))
  fs.mkdirSync(logDirectory, { recursive: true });

const dataDirectory = path.join(__dirname, "../data");
if (!fs.existsSync(dataDirectory))
  fs.mkdirSync(dataDirectory, { recursive: true });

// ── Log format ─────────────────────────────────────────────────────────────

const timestampedFormat = winston.format.combine(
  winston.format.timestamp({ format: formatLogTimestamp }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    const extraData = Object.keys(metadata).length
      ? " " + JSON.stringify(metadata)
      : "";
    return `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}${extraData}`;
  }),
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: timestampedFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        timestampedFormat,
      ),
    }),
    new winston.transports.File({
      filename: path.join(logDirectory, "agent.log"),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 20,
    }),
    new winston.transports.File({
      filename: path.join(logDirectory, "errors.log"),
      level: "error",
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
});

// ── Trade journal ──────────────────────────────────────────────────────────
// Every buy and sell is recorded here with full reasoning from all AI models.
// Open logs/trade-journal.json to see all decisions.

const tradeJournalPath = path.join(logDirectory, "trade-journal.json");

function recordTradeDecision(tradeRecord) {
  try {
    let journal = [];
    if (fs.existsSync(tradeJournalPath)) {
      journal = JSON.parse(fs.readFileSync(tradeJournalPath, "utf8"));
    }
    journal.push({ ...tradeRecord, recordedAt: new Date().toISOString() });
    fs.writeFileSync(tradeJournalPath, JSON.stringify(journal, null, 2));
  } catch (error) {
    logger.error("Failed to write trade journal: " + error.message);
  }
}

// ── Portfolio snapshots ────────────────────────────────────────────────────
// Saved after every cycle — used for daily and weekly performance reports.

const performanceLogPath = path.join(logDirectory, "performance.json");

function recordPortfolioSnapshot(portfolioState) {
  try {
    let snapshots = [];
    if (fs.existsSync(performanceLogPath)) {
      snapshots = JSON.parse(fs.readFileSync(performanceLogPath, "utf8"));
    }
    snapshots.push({
      ...portfolioState,
      snapshotTime: new Date().toISOString(),
    });
    if (snapshots.length > 2000) snapshots = snapshots.slice(-2000);
    fs.writeFileSync(performanceLogPath, JSON.stringify(snapshots, null, 2));
  } catch (error) {
    logger.error("Failed to write performance snapshot: " + error.message);
  }
}

// ── Daily trade log ────────────────────────────────────────────────────────
// Accumulates trades made today — reset each day for daily summary.

const dailyTradeLogPath = path.join(dataDirectory, "daily-trades.json");

function recordDailyTrade(tradeRecord) {
  try {
    let todayTrades = [];
    const today = new Date().toISOString().split("T")[0];

    if (fs.existsSync(dailyTradeLogPath)) {
      const stored = JSON.parse(fs.readFileSync(dailyTradeLogPath, "utf8"));
      // Reset if it's a new day
      if (stored.date === today) {
        todayTrades = stored.trades || [];
      }
    }

    todayTrades.push({ ...tradeRecord, time: new Date().toISOString() });
    fs.writeFileSync(
      dailyTradeLogPath,
      JSON.stringify({ date: today, trades: todayTrades }, null, 2),
    );
  } catch (error) {
    logger.error("Failed to record daily trade: " + error.message);
  }
}

function getTodayTrades() {
  try {
    if (!fs.existsSync(dailyTradeLogPath)) return [];
    const stored = JSON.parse(fs.readFileSync(dailyTradeLogPath, "utf8"));
    const today = new Date().toISOString().split("T")[0];
    return stored.date === today ? stored.trades || [] : [];
  } catch (error) {
    return [];
  }
}

// ── Weekly trade accumulator ────────────────────────────────────────────────
// Accumulates all trades from Mon-Fri for the weekly Friday report.

const weeklyTradeLogPath = path.join(dataDirectory, "weekly-trades.json");

function recordWeeklyTrade(tradeRecord) {
  try {
    let weekData = { weekStart: "", trades: [] };
    const now = new Date();
    // Week starts on Monday
    const dayOfWeek = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    const weekStart = monday.toISOString().split("T")[0];

    if (fs.existsSync(weeklyTradeLogPath)) {
      const stored = JSON.parse(fs.readFileSync(weeklyTradeLogPath, "utf8"));
      if (stored.weekStart === weekStart) {
        weekData = stored;
      } else {
        // New week — archive last week and start fresh
        const archivePath = path.join(
          dataDirectory,
          "week-" + stored.weekStart + ".json",
        );
        fs.writeFileSync(archivePath, JSON.stringify(stored, null, 2));
        weekData = { weekStart, trades: [] };
      }
    } else {
      weekData = { weekStart, trades: [] };
    }

    weekData.trades.push({ ...tradeRecord, time: new Date().toISOString() });
    fs.writeFileSync(weeklyTradeLogPath, JSON.stringify(weekData, null, 2));
  } catch (error) {
    logger.error("Failed to record weekly trade: " + error.message);
  }
}

function getThisWeekTrades() {
  try {
    if (!fs.existsSync(weeklyTradeLogPath)) return [];
    return JSON.parse(fs.readFileSync(weeklyTradeLogPath, "utf8")).trades || [];
  } catch (error) {
    return [];
  }
}

// ── Peak equity tracker ─────────────────────────────────────────────────────
// Tracks all-time high equity for drawdown protection calculations.

const peakEquityPath = path.join(logDirectory, "peak-equity.json");

function updatePeakEquity(currentEquity) {
  try {
    let peakData = {
      peakEquity: currentEquity,
      recordedAt: new Date().toISOString(),
    };
    if (fs.existsSync(peakEquityPath)) {
      const stored = JSON.parse(fs.readFileSync(peakEquityPath, "utf8"));
      if (stored.peakEquity > currentEquity) {
        return stored.peakEquity; // keep existing peak — do not write
      }
    }
    fs.writeFileSync(peakEquityPath, JSON.stringify(peakData, null, 2));
    return currentEquity;
  } catch (error) {
    return currentEquity;
  }
}

function getPeakEquity() {
  try {
    if (fs.existsSync(peakEquityPath)) {
      return JSON.parse(fs.readFileSync(peakEquityPath, "utf8")).peakEquity;
    }
  } catch (error) {}
  return parseFloat(process.env.PORTFOLIO_STARTING_CAPITAL || "250");
}

module.exports = {
  logger,
  recordTradeDecision,
  recordPortfolioSnapshot,
  recordDailyTrade,
  getTodayTrades,
  recordWeeklyTrade,
  getThisWeekTrades,
  updatePeakEquity,
  getPeakEquity,
};
