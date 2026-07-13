// src/notifications/telegram.js
//
// Uses its OWN bot token (DT_TELEGRAM_BOT_TOKEN) and chat id — keep this
// SEPARATE from your long-term bot's Telegram bot so the two don't mix
// messages in one chat. Create a second bot via @BotFather if you don't
// already have one.
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { logger } = require("../logger");

let telegramBot = null;

function initialiseTelegramBot() {
  const token = process.env.DT_TELEGRAM_BOT_TOKEN;

  if (!token) {
    logger.warn("DT_TELEGRAM_BOT_TOKEN not set — notifications disabled");
    return;
  }
  telegramBot = new TelegramBot(token, { polling: false });
  logger.info("Day-trade Telegram bot initialised");
}

async function sendTelegramMessage(text) {
  const chatId = process.env.DT_TELEGRAM_CHAT_ID;
  if (!telegramBot || !chatId) return;
  try {
    // HTML, not legacy Markdown — Markdown treats "_" as an italic delimiter,
    // which silently ate underscores out of every enum-style string
    // (MOMENTUM_SURGE -> MOMENTUMSURGE, TIME_EXIT_STALE -> TIMEEXITSTALE).
    // HTML has no such special-casing for plain text.
    await telegramBot.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch (sendError) {
    logger.warn("Telegram send failed: " + sendError.message);
  }
}

async function notifyBotStarted(dayTradeCapital) {
  await sendTelegramMessage(
    "🤖 *Day-Trade Bot Started*\n\n" +
      "Capital allocated: $" +
      dayTradeCapital.toFixed(2) +
      "\n" +
      "Max " +
      (process.env.DT_MAX_OPEN_POSITIONS || 3) +
      " positions, " +
      (process.env.DT_MAX_POSITION_PCT
        ? parseFloat(process.env.DT_MAX_POSITION_PCT) * 100
        : 8) +
      "% max per trade\n" +
      "Stop: -" +
      (process.env.DT_STOP_LOSS_PCT
        ? parseFloat(process.env.DT_STOP_LOSS_PCT) * 100
        : 2) +
      "% · Target: +" +
      (process.env.DT_TAKE_PROFIT_PCT
        ? parseFloat(process.env.DT_TAKE_PROFIT_PCT) * 100
        : 3) +
      "%\n" +
      "Daily loss limit: " +
      (process.env.DT_DAILY_LOSS_LIMIT_PCT
        ? parseFloat(process.env.DT_DAILY_LOSS_LIMIT_PCT) * 100
        : 5) +
      "%\n\n" +
      "_All positions force-close before market close. No overnight holds._",
  );
}

async function notifyPositionOpened(details) {
  await sendTelegramMessage(
    "✅ *DAY-TRADE OPENED: " +
      details.symbol +
      "*\n\n" +
      "Setup: " +
      details.setup +
      "\n" +
      "Entry: $" +
      details.entryPrice.toFixed(2) +
      " · Size: $" +
      details.dollarAmount.toFixed(2) +
      "\n" +
      "Stop: $" +
      details.stopPrice.toFixed(2) +
      " · Target: $" +
      details.targetPrice.toFixed(2) +
      "\n" +
      "Confidence: " +
      details.confidence +
      "/10\n\n" +
      "_" +
      details.reasoning +
      "_",
  );
}

async function notifyPositionClosed(details) {
  const isProfitable = details.pnlDollars >= 0;
  await sendTelegramMessage(
    (isProfitable ? "✅" : "🛑") +
      " *CLOSED: " +
      details.symbol +
      "*\n\n" +
      "Reason: " +
      details.exitReason +
      "\n" +
      "P&L: " +
      (isProfitable ? "+" : "") +
      "$" +
      details.pnlDollars.toFixed(2) +
      " (" +
      (isProfitable ? "+" : "") +
      details.pnlPercent.toFixed(2) +
      "%)",
  );
}

async function notifyDailyLossLimitHit(realizedLoss, limitDollars) {
  await sendTelegramMessage(
    "🛑 *Daily loss limit hit*\n\n" +
      "Realized loss: $" +
      realizedLoss.toFixed(2) +
      " / limit $" +
      limitDollars.toFixed(2) +
      "\n" +
      "No new trades until tomorrow. Existing positions still managed normally.",
  );
}

module.exports = {
  initialiseTelegramBot,
  sendTelegramMessage,
  notifyBotStarted,
  notifyPositionOpened,
  notifyPositionClosed,
  notifyDailyLossLimitHit,
};
