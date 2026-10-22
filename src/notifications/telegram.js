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

// v9.2 — COMMANDS FROM YOUR PHONE. Polls Telegram (no webhook: the server has
// no public HTTPS) and answers ONLY the configured chat id, so nobody else who
// finds the bot can read positions. Read-only: no command can trade.
//
// v10: (1) the commands are registered with Telegram, so the "/" menu button
// on the phone lists them with a one-line description; (2) every reply
// carries tap-buttons for the other views, and a tap runs that view (button
// presses are checked against the same chat id); (3) replies longer than
// Telegram's 4,096-character limit are split on line breaks instead of
// failing.
//
// commands: [{ command: "/status", description: "...", handler, button? }]
const MAX_MESSAGE = 3900;

function splitMessage(text) {
  const parts = [];
  let rest = String(text || "");
  while (rest.length > MAX_MESSAGE) {
    let cut = rest.lastIndexOf("\n", MAX_MESSAGE);
    if (cut < MAX_MESSAGE / 2) cut = MAX_MESSAGE;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

function keyboardFor(commands) {
  const buttons = commands
    .filter((c) => c.button)
    .map((c) => ({ text: c.button, callback_data: "cmd:" + c.command }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { inline_keyboard: rows };
}

async function sendReply(chatId, text, keyboard) {
  const parts = splitMessage(text);
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    try {
      await telegramBot.sendMessage(chatId, parts[i], {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(last && keyboard ? { reply_markup: keyboard } : {}),
      });
    } catch (sendError) {
      logger.warn("Telegram reply failed: " + sendError.message);
    }
  }
}

function startCommandListener(commands) {
  const chatId = String(process.env.DT_TELEGRAM_CHAT_ID || "");
  if (!telegramBot || !chatId) return;
  const byName = {};
  for (const c of commands) byName[c.command] = c;
  for (const c of commands) for (const alias of c.aliases || []) byName[alias] = c;
  const keyboard = keyboardFor(commands);

  try {
    telegramBot.startPolling({ restart: true });
  } catch (pollError) {
    logger.warn("Telegram command polling failed to start: " + pollError.message);
    return;
  }
  // The phone's "/" menu. Failure is harmless — typed commands still work.
  telegramBot
    .setMyCommands(
      commands
        .filter((c) => c.description)
        .map((c) => ({ command: c.command.replace(/^\//, ""), description: c.description.slice(0, 256) })),
    )
    .catch((e) => logger.warn("Telegram command menu not set: " + e.message));

  const run = async (name) => {
    const c = byName[name] || byName["/help"];
    try {
      await sendReply(chatId, await c.handler(), keyboard);
    } catch (cmdError) {
      logger.warn("Telegram command " + name + " failed: " + cmdError.message);
      await sendReply(chatId, "⚠️ " + name + " failed: " + cmdError.message, keyboard);
    }
  };

  telegramBot.on("polling_error", (e) => logger.warn("Telegram polling: " + (e.code || e.message)));
  telegramBot.on("message", async (msg) => {
    if (!msg || !msg.text || String(msg.chat.id) !== chatId) return;
    const command = msg.text.trim().toLowerCase().replace(/^\/\s+/, "/").split(/[\s@]/)[0];
    await run(command);
  });
  telegramBot.on("callback_query", async (query) => {
    const fromChat = query && query.message && String(query.message.chat.id);
    try {
      await telegramBot.answerCallbackQuery(query.id);
    } catch {}
    if (fromChat !== chatId || !String(query.data || "").startsWith("cmd:")) return;
    await run(query.data.slice(4));
  });
  logger.info("Telegram commands ON: " + commands.map((c) => c.command).join(" ") + " (menu + buttons)");
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
  startCommandListener,
  initialiseTelegramBot,
  sendTelegramMessage,
  notifyBotStarted,
  notifyPositionOpened,
  notifyPositionClosed,
  notifyDailyLossLimitHit,
};
