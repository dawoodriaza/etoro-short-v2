// src/strategies/eod-closer.js
//
// v5 (2026-07-04): added Telegram SYSTEM ALERTS (via notifications/alerts.js)
// for the two silent-failure paths — portfolio fetch failing right before
// close, and an individual force-close failing (which leaves a position
// open overnight/into the weekend by accident).
//
// v4 behavior retained:
//   1. META-FILTERED (account-safety fix) — only closes positions THIS
//      bot's meta file tracks; untracked positions are left alone.
//   2. MODE PARAMETER:
//        'DAY_ONLY' — Mon-Thu close: DAY positions only; SWING holds.
//        'ALL'      — Friday close: EVERYTHING, zero weekend exposure.
require("dotenv").config();
const { logger } = require("../logger");
const config = require("../config");
const alerts = require("../notifications/alerts");

async function forceCloseAllPositions(
  etoroClient,
  notifications,
  riskManager,
  performance,
  loadPositionMeta,
  savePositionMeta,
  mode, // 'DAY_ONLY' | 'ALL'
  extraHooks, // optional { onClosed(symbol, pnlDollars, meta, exitReason) }
) {
  const closeMode = mode === "ALL" ? "ALL" : "DAY_ONLY";

  let portfolio;
  try {
    const raw = await etoroClient.fetchRawPortfolio();
    portfolio = etoroClient.parsePortfolioFromRawData(raw);
    await etoroClient.labelPositionsWithTickers(portfolio);
  } catch (fetchError) {
    logger.error(
      "EOD closer: could not fetch portfolio — " + fetchError.message,
    );
    await alerts.systemAlert(
      "EOD_CLOSER",
      "EOD closer FAILED to fetch the portfolio (" +
        fetchError.message +
        "). " +
        (closeMode === "ALL"
          ? "Friday close did NOT run — positions may be open over the weekend."
          : "Today's EOD close did NOT run — DAY positions may stay open " +
            "overnight by accident.") +
        " Manual check required.",
    );
    return;
  }

  const meta = loadPositionMeta ? loadPositionMeta() : {};
  const allPositions = portfolio.openPositions || [];

  // SAFETY FILTER: only positions THIS bot opened (present in meta).
  const trackedPositions = [];
  for (const position of allPositions) {
    const symbol = (
      position.symbol || String(position.instrumentId)
    ).toUpperCase();
    const positionMeta = meta[symbol];
    if (!positionMeta) {
      logger.info(
        "EOD closer: " +
          symbol +
          " is NOT tracked by this bot — leaving it alone (likely another " +
          "bot's or a manual position)",
      );
      continue;
    }
    const tradeType = positionMeta.tradeType === "SWING" ? "SWING" : "DAY";
    if (closeMode === "DAY_ONLY" && tradeType === "SWING") {
      logger.info(
        "EOD closer: " +
          symbol +
          " is a SWING position — holding overnight (closes Friday at latest)",
      );
      continue;
    }
    trackedPositions.push({ position, positionMeta, symbol, tradeType });
  }

  if (trackedPositions.length === 0) {
    logger.info(
      "EOD closer (" +
        closeMode +
        "): nothing to close" +
        (allPositions.length > 0
          ? " (" +
            allPositions.length +
            " untracked/swing position(s) left as-is)"
          : ""),
    );
    return;
  }

  const exitReason =
    closeMode === "ALL" ? "FRIDAY_FORCE_CLOSE" : "EOD_FORCE_CLOSE";
  logger.info(
    "🔔 EOD closer (" +
      closeMode +
      "): force-closing " +
      trackedPositions.length +
      " tracked position(s)",
  );

  let closedCount = 0;
  let totalRealizedPnl = 0;
  const failedSymbols = [];

  for (const tracked of trackedPositions) {
    const { position, positionMeta, symbol, tradeType } = tracked;
    try {
      const pnlDollars = position.unrealizedProfitLoss || 0;
      const pnlPercent = (position.unrealizedProfitLossPercent || 0) * 100;
      await etoroClient.closeExistingPosition(
        position.positionId,
        position.instrumentId,
        symbol,
      );
      riskManager.recordClosedTradeResult(pnlDollars);
      if (performance) {
        const heldMinutes = positionMeta.openedAt
          ? Math.round((Date.now() - positionMeta.openedAt) / 60000)
          : null;
        performance.recordTrade({
          symbol,
          setup: positionMeta.setup,
          tradeType,
          source: positionMeta.source || "WATCHLIST",
          entryPrice: positionMeta.entryPrice,
          exitPrice: null,
          dollarAmount: positionMeta.dollarAmount,
          pnlDollars,
          pnlPercent,
          exitReason,
          confidence: positionMeta.confidence,
          openedAt: positionMeta.openedAt
            ? new Date(positionMeta.openedAt).toISOString()
            : null,
          heldMinutes,
          entryConditions: positionMeta.entryConditions || null,
          plan: positionMeta.plan || null,
          extendedByReviewer: !!positionMeta.extendedByReviewerAt, // v5.1 Tier-3
        });
      }
      if (extraHooks && typeof extraHooks.onClosed === "function") {
        try {
          extraHooks.onClosed(symbol, pnlDollars, positionMeta, exitReason);
        } catch (hookError) {
          logger.warn("EOD onClosed hook failed: " + hookError.message);
        }
      }
      delete meta[symbol];
      totalRealizedPnl += pnlDollars;
      closedCount++;
      logger.info(
        "  ✅ Force-closed " +
          symbol +
          " [" +
          tradeType +
          "] — P&L $" +
          pnlDollars.toFixed(2),
      );
      await etoroClient.sleep(2000);
    } catch (closeError) {
      logger.error(
        "  ❌ Failed to force-close " + symbol + ": " + closeError.message,
      );
      failedSymbols.push(symbol);
    }
  }

  if (savePositionMeta) savePositionMeta(meta);

  if (failedSymbols.length > 0) {
    // v5: a failed force-close is exactly the "AMD held over a risky window
    // by accident" failure mode — must be loud, not just a log line.
    await alerts.systemAlert(
      "EOD_CLOSER",
      (closeMode === "ALL" ? "FRIDAY" : "EOD") +
        " close FAILED for " +
        failedSymbols.length +
        " position(s): " +
        failedSymbols.join(", ") +
        ". " +
        (closeMode === "ALL"
          ? "These may stay open over the weekend."
          : "These may stay open overnight.") +
        " Close manually if needed.",
    );
  }

  await notifications.sendTelegramMessage(
    "🔔 *" +
      (closeMode === "ALL"
        ? "Friday close — ALL positions flat for the weekend"
        : "End of day — day-trade positions closed") +
      "*\n\n" +
      closedCount +
      "/" +
      trackedPositions.length +
      " closed · Realized: " +
      (totalRealizedPnl >= 0 ? "+" : "") +
      "$" +
      totalRealizedPnl.toFixed(2) +
      (failedSymbols.length > 0
        ? "\n⚠️ FAILED to close: " + failedSymbols.join(", ")
        : "") +
      (closeMode === "DAY_ONLY"
        ? "\n_Swing positions (if any) hold overnight — Friday closes everything._"
        : "\n_No weekend exposure._"),
  );
}

module.exports = {
  forceCloseAllPositions,
  FORCE_CLOSE_MINUTES_BEFORE_CLOSE: config.forceCloseMinutesBeforeClose,
};
