// src/notifications/alerts.js
//
// v5 NEW MODULE — SYSTEM FAILURE ALERTS (Telegram).
//
// Requirement: if any IMPORTANT function is not getting a response (data
// provider down, eToro unreachable, AI screener erroring, discovery dark,
// scan crashing), a Telegram alert must fire so the problem is visible
// immediately — not discovered days later in logs.
//
// THROTTLING: the same failure repeating every scan must not spam Telegram
// every 60 seconds. Each alertKey fires at most once per
// config.alertThrottleMinutes (default 30). The first occurrence always
// alerts; repeats within the window are logged but not re-sent. When the
// window expires and the failure is STILL happening, it alerts again with
// an occurrence count so you can see it's ongoing.
//
// RECOVERY NOTICES: call clearAlert(alertKey) when the failing function
// succeeds again — if an alert had actually been sent for that key, a
// "recovered" message is sent once, closing the loop.
//
// Alerting itself NEVER throws — a Telegram outage must not break trading.
require("dotenv").config();
const { logger } = require("../logger");
const config = require("../config");
const notifications = require("./telegram");
const { escapeHtml, humanize } = require("./format-helpers");

// { alertKey: { lastSentAtMs, occurrencesSinceLastSent, everSent } }
const alertStateByKey = {};

async function systemAlert(alertKey, message) {
  try {
    const now = Date.now();
    const state = alertStateByKey[alertKey] || {
      lastSentAtMs: 0,
      occurrencesSinceLastSent: 0,
      everSent: false,
    };
    state.occurrencesSinceLastSent += 1;

    const throttleMs = config.alertThrottleMinutes * 60 * 1000;
    const withinThrottleWindow = now - state.lastSentAtMs < throttleMs;

    if (withinThrottleWindow) {
      alertStateByKey[alertKey] = state;
      logger.error(
        "ALERT (throttled, " +
          state.occurrencesSinceLastSent +
          "x since last send) [" +
          alertKey +
          "]: " +
          message,
      );
      return;
    }

    const repeatSuffix =
      state.everSent && state.occurrencesSinceLastSent > 1
        ? "\n<i>(occurred " +
          state.occurrencesSinceLastSent +
          " times since the last alert — problem is ONGOING)</i>"
        : "";

    state.lastSentAtMs = now;
    state.occurrencesSinceLastSent = 0;
    state.everSent = true;
    alertStateByKey[alertKey] = state;

    logger.error("ALERT [" + alertKey + "]: " + message);
    await notifications.sendTelegramMessage(
      "🚨 <b>System Alert — " +
        humanize(alertKey) +
        "</b>\n" +
        escapeHtml(message) +
        repeatSuffix,
    );
  } catch (alertError) {
    // Never let alerting break trading.
    logger.error(
      "Alert dispatch itself failed [" + alertKey + "]: " + alertError.message,
    );
  }
}

// Call when the previously-failing function succeeds again.
async function clearAlert(alertKey, recoveryMessage) {
  try {
    const state = alertStateByKey[alertKey];
    if (!state || !state.everSent) return; // nothing was ever alerted
    delete alertStateByKey[alertKey];
    logger.info("ALERT CLEARED [" + alertKey + "]");
    await notifications.sendTelegramMessage(
      "✅ <b>Recovered — " +
        humanize(alertKey) +
        "</b>\n" +
        escapeHtml(
          recoveryMessage || "The failing component is responding again.",
        ),
    );
  } catch (clearError) {
    logger.warn("Alert clear failed: " + clearError.message);
  }
}

module.exports = { systemAlert, clearAlert };
