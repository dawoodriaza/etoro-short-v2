// src/strategies/performance-tracker.js
//
// Records every closed trade and computes the metrics that actually tell you
// whether the bot makes money: win rate, average win, average loss, profit
// factor, expectancy. Without this you can only know if the bot works by
// watching the account balance — this makes it measurable.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { logger } = require("../logger");
const { humanize, toRealDollars } = require("../notifications/format-helpers");

const tradeLogPath = path.join(__dirname, "../../data/trade-history.json");
const dataDir = path.dirname(tradeLogPath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function loadHistory() {
  try {
    if (!fs.existsSync(tradeLogPath)) return [];
    return JSON.parse(fs.readFileSync(tradeLogPath, "utf8"));
  } catch {
    return [];
  }
}
function saveHistory(history) {
  try {
    fs.writeFileSync(tradeLogPath, JSON.stringify(history, null, 2));
  } catch (saveError) {
    logger.warn("Could not save trade history: " + saveError.message);
  }
}

function recordTrade(trade) {
  // trade: { symbol, setup, entryPrice, exitPrice, dollarAmount, pnlDollars,
  //          pnlPercent, exitReason, openedAt, closedAt, confidence }
  const history = loadHistory();
  history.push({
    ...trade,
    closedAt: trade.closedAt || new Date().toISOString(),
  });
  saveHistory(history);
}

function computeStats(history) {
  const trades = history || loadHistory();
  if (trades.length === 0) {
    return { totalTrades: 0 };
  }
  const wins = trades.filter((t) => t.pnlDollars > 0);
  const losses = trades.filter((t) => t.pnlDollars <= 0);
  const grossWin = wins.reduce((sum, t) => sum + t.pnlDollars, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnlDollars, 0));
  const totalPnl = grossWin - grossLoss;

  const winRate = (wins.length / trades.length) * 100;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const profitFactor =
    grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  // expectancy per trade in dollars
  const expectancy =
    (winRate / 100) * avgWin - ((100 - winRate) / 100) * avgLoss;

  // per-setup breakdown — which setups actually work
  const bySetup = {};
  for (const t of trades) {
    const key = t.setup || "UNKNOWN";
    if (!bySetup[key]) bySetup[key] = { trades: 0, wins: 0, pnl: 0 };
    bySetup[key].trades++;
    if (t.pnlDollars > 0) bySetup[key].wins++;
    bySetup[key].pnl += t.pnlDollars;
  }

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    expectancy,
    totalPnl,
    bySetup,
  };
}

// v7.5: every dollar figure here is stored in trade-history.json as BOT
// (agent-account) dollars — computeStats() just sums pnlDollars as recorded.
// Run each one through toRealDollars() before it reaches Telegram, so this
// report matches every other Telegram message and your actual account.
// Win rate / profit factor are RATIOS and are unaffected by the copy scale.
function formatStatsForTelegram(stats) {
  if (!stats.totalTrades) return "No trades recorded yet.";
  const money = (value) =>
    (value >= 0 ? "+" : "") + "$" + toRealDollars(value).toFixed(2);
  const setupLines = Object.entries(stats.bySetup)
    .map(
      ([setup, s]) =>
        "  " +
        humanize(setup) +
        ": " +
        s.wins +
        "/" +
        s.trades +
        " win, " +
        money(s.pnl),
    )
    .join("\n");
  return (
    "📊 <b>Day-Trade Performance</b>\n\n" +
    "Trades: " +
    stats.totalTrades +
    " (" +
    stats.wins +
    "W / " +
    stats.losses +
    "L)\n" +
    "Win rate: " +
    stats.winRate.toFixed(1) +
    "%\n" +
    "Avg win: $" +
    toRealDollars(stats.avgWin).toFixed(2) +
    " · Avg loss: $" +
    toRealDollars(stats.avgLoss).toFixed(2) +
    "\n" +
    "Profit factor: " +
    (stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)) +
    "\n" +
    "Expectancy/trade: $" +
    toRealDollars(stats.expectancy).toFixed(2) +
    "\n" +
    "Total P&L: " +
    money(stats.totalPnl) +
    "\n\n" +
    "By setup:\n" +
    setupLines
  );
}

module.exports = {
  recordTrade,
  computeStats,
  formatStatsForTelegram,
  loadHistory,
};
