// src/etoro-client.js
// All communication with the eToro Agent Portfolio API.
// Handles portfolio state, instrument lookup, opening and closing positions.
// Rate limit: 20 requests per minute — all calls spaced 3+ seconds apart.
//
// v5 (2026-07-04): NO LOGIC CHANGES HERE. findDuplicatePositions() already
// existed and works correctly — the bug was that nothing ever CALLED it.
// index.js v5 now calls it on every exit-monitor tick via
// reconcileDuplicatePositions(), with a Telegram alert on both detection
// and any failure to close the duplicate.
require("dotenv").config();
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { logger } = require("./logger");

const ETORO_BASE_URL = "https://public-api.etoro.com/api/v1";

// Cache resolved instrument IDs to avoid repeated lookups
const instrumentIdCache = {
  AMD: 1130,
  ASML: 1832,
  NVDA: 1137,
  AAPL: 1,
  MSFT: 2,
  TSLA: 3,
  AMZN: 4,
  GOOGL: 5,
  DE: 1526,
};

// Reverse cache: instrument ID (number) -> ticker symbol (string)
// Seeded with known eToro IDs so positions are labelled even before a lookup.
// The bot adds to this automatically whenever it resolves a ticker.
const instrumentNameCache = {
  1130: "AMD",
  1832: "ASML",
  1137: "NVDA",
  1: "AAPL",
  4: "AMZN",
  5: "GOOGL",
  2: "MSFT",
  3: "TSLA",
  1145: "META",
  1141: "QCOM",
  1126: "INTC",
  1138: "MU",
};

// ── Request helpers ────────────────────────────────────────────────────────

function buildRequestHeaders() {
  return {
    "x-request-id": uuidv4(),
    "x-api-key": process.env.ETORO_PUBLIC_API_KEY,
    "x-user-key": process.env.ETORO_AGENT_USER_KEY,
    "Content-Type": "application/json",
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function executeWithRetry(requestFunction, maximumRetries = 3) {
  for (let attempt = 1; attempt <= maximumRetries; attempt++) {
    try {
      return await requestFunction();
    } catch (error) {
      const httpStatus = error.response?.status;
      if (httpStatus === 429) {
        const waitTime = Math.min(15000 * attempt, 60000);
        logger.warn(
          `eToro rate limit hit — waiting ${waitTime / 1000}s before retry ${attempt}/${maximumRetries}`,
        );
        await sleep(waitTime);
      } else if (attempt === maximumRetries) {
        throw error;
      } else {
        logger.warn(
          `eToro request failed (attempt ${attempt}): ${error.message} — retrying in 3s`,
        );
        await sleep(3000);
      }
    }
  }
}

// ── Portfolio state ────────────────────────────────────────────────────────

async function fetchRawPortfolio() {
  logger.info("Fetching portfolio state from eToro...");
  return executeWithRetry(async () => {
    const response = await axios.get(
      `${ETORO_BASE_URL}/trading/info/real/pnl`,
      { headers: buildRequestHeaders() },
    );
    return response.data;
  });
}

function parsePortfolioFromRawData(rawPortfolioData) {
  const clientPortfolio = rawPortfolioData.clientPortfolio;

  // Calculate cash committed to pending orders
  const pendingOpenOrderCost = (clientPortfolio.ordersForOpen || [])
    .filter((order) => order.mirrorID === 0)
    .reduce((total, order) => total + (order.amount || 0), 0);

  const pendingCloseOrderCost = (clientPortfolio.orders || []).reduce(
    (total, order) => total + (order.amount || 0),
    0,
  );

  const availableCash =
    (clientPortfolio.credit || 0) -
    pendingOpenOrderCost -
    pendingCloseOrderCost;

  const totalUnrealizedProfitLoss = (clientPortfolio.positions || []).reduce(
    (total, position) => total + (position.unrealizedPnL?.pnL || 0),
    0,
  );

  const totalAmountInvested = (clientPortfolio.positions || []).reduce(
    (total, position) => total + (position.amount || 0),
    0,
  );

  const totalEquity =
    availableCash + totalAmountInvested + totalUnrealizedProfitLoss;

  const openPositions = (clientPortfolio.positions || []).map((position) => ({
    positionId: position.positionID,
    instrumentId: position.instrumentID,
    symbol: position.instrumentName || String(position.instrumentID),
    amountInvested: position.amount,
    isBuyPosition: position.isBuy,
    leverage: position.leverage,
    openPrice: position.openRate,
    units: position.units || position.amount || 0,
    unrealizedProfitLoss: position.unrealizedPnL?.pnL || 0,
    unrealizedProfitLossPercent:
      position.amount > 0
        ? (position.unrealizedPnL?.pnL || 0) / position.amount
        : 0,
    portfolioWeight: totalEquity > 0 ? position.amount / totalEquity : 0,
  }));

  return {
    totalEquity,
    availableCash,
    totalAmountInvested,
    totalUnrealizedProfitLoss,
    cashPercent: totalEquity > 0 ? availableCash / totalEquity : 0,
    openPositions,
    positionCount: openPositions.length,
  };
}

// ── Duplicate position detector ───────────────────────────────────────────
// Finds cases where the same stock has multiple open positions
// (caused by duplicate cycle bug) and returns the extras to close

function findDuplicatePositions(parsedPortfolio) {
  const symbolGroups = {};

  // Group positions by instrumentId
  for (const position of parsedPortfolio.openPositions) {
    const key = position.instrumentId;
    if (!symbolGroups[key]) symbolGroups[key] = [];
    symbolGroups[key].push(position);
  }

  const duplicatesToClose = [];

  for (const [instrumentId, positions] of Object.entries(symbolGroups)) {
    if (positions.length > 1) {
      // Sort by amount — keep the largest, close the smaller ones
      positions.sort((a, b) => b.amountInvested - a.amountInvested);
      const keep = positions[0];
      const extras = positions.slice(1);

      extras.forEach((extra) => {
        duplicatesToClose.push({
          symbol: extra.symbol || instrumentId,
          positionId: extra.positionId,
          instrumentId: extra.instrumentId,
          amount: extra.amountInvested,
          reason:
            "Duplicate position — keeping larger position " + keep.positionId,
        });
      });
    }
  }

  return duplicatesToClose;
}

// ── Instrument resolution ──────────────────────────────────────────────────

async function resolveTickerToInstrumentId(tickerSymbol) {
  const upperSymbol = tickerSymbol.toUpperCase();
  if (instrumentIdCache[upperSymbol]) {
    return instrumentIdCache[upperSymbol];
  }

  logger.info(`Resolving eToro instrument ID for ${upperSymbol}...`);
  return executeWithRetry(async () => {
    const response = await axios.get(
      `${ETORO_BASE_URL}/market-data/search?internalSymbolFull=${encodeURIComponent(upperSymbol)}`,
      { headers: buildRequestHeaders() },
    );

    const searchResults = response.data?.items || [];
    const exactMatch = searchResults.find(
      (item) => item.internalSymbolFull?.toUpperCase() === upperSymbol,
    );

    if (!exactMatch) {
      logger.warn(`${upperSymbol} not found on eToro instrument search`);
      return null;
    }

    const resolvedInstrumentId = exactMatch.instrumentId;
    instrumentIdCache[upperSymbol] = resolvedInstrumentId;
    instrumentNameCache[String(resolvedInstrumentId)] = upperSymbol;
    logger.info(
      `Resolved ${upperSymbol} → instrumentId ${resolvedInstrumentId}`,
    );
    return resolvedInstrumentId;
  });
}

// ── Reverse lookup: instrument ID -> ticker symbol ────────────────────────
// eToro's pnl endpoint returns instrumentID numbers, not ticker names.
// This resolves them so positions show as "AMD" not "1130".
async function resolveInstrumentIdToTicker(instrumentId) {
  const idKey = String(instrumentId);
  if (instrumentNameCache[idKey]) return instrumentNameCache[idKey];

  try {
    const response = await axios.get(
      `${ETORO_BASE_URL}/market-data/instruments?instrumentIds=${encodeURIComponent(idKey)}`,
      { headers: buildRequestHeaders() },
    );
    const items = response.data?.items || response.data || [];
    const match = Array.isArray(items) ? items[0] : null;
    const ticker =
      match?.internalSymbolFull || match?.symbolFull || match?.ticker;
    if (ticker) {
      instrumentNameCache[idKey] = ticker.toUpperCase();
      logger.info(`Resolved instrumentId ${idKey} → ${ticker.toUpperCase()}`);
      return ticker.toUpperCase();
    }
  } catch (error) {
    logger.warn(
      `Could not resolve instrumentId ${idKey} to a ticker: ${error.message}`,
    );
  }
  return idKey; // fall back to the number if lookup fails
}

// Label every position in a parsed portfolio with its real ticker symbol.
// Call this right after parsePortfolioFromRawData.
async function labelPositionsWithTickers(parsedPortfolio) {
  for (const position of parsedPortfolio.openPositions) {
    // Only resolve if symbol is still just the numeric ID
    if (!position.symbol || /^\d+$/.test(String(position.symbol))) {
      position.symbol = await resolveInstrumentIdToTicker(
        position.instrumentId,
      );
      await sleep(500); // gentle spacing for rate limit
    }
  }
  return parsedPortfolio;
}

// ── Trade execution ────────────────────────────────────────────────────────

async function openBuyPosition(instrumentId, dollarAmount, tickerSymbol) {
  const minimumPositionDollars = parseFloat(
    process.env.MINIMUM_POSITION_DOLLARS || "50",
  );

  if (dollarAmount < minimumPositionDollars) {
    logger.warn(
      `Position size $${dollarAmount.toFixed(2)} for ${tickerSymbol} is below minimum $${minimumPositionDollars} — skipping`,
    );
    return null;
  }

  if (process.env.TRADING_MODE === "dry_run") {
    logger.info(
      `[DRY RUN] Would open BUY ${tickerSymbol} for $${dollarAmount.toFixed(2)}`,
    );
    return {
      dryRun: true,
      symbol: tickerSymbol,
      amount: dollarAmount,
      instrumentId,
    };
  }

  logger.info(
    `Opening BUY position: ${tickerSymbol} | $${dollarAmount.toFixed(2)} | instrumentId=${instrumentId}`,
  );

  return executeWithRetry(async () => {
    const response = await axios.post(
      `${ETORO_BASE_URL}/trading/execution/market-open-orders/by-amount`,
      {
        InstrumentID: instrumentId,
        IsBuy: true,
        Leverage: 1,
        Amount: dollarAmount,
      },
      { headers: buildRequestHeaders() },
    );
    logger.info(
      `✅ Position opened: ${tickerSymbol} $${dollarAmount.toFixed(2)} — orderId: ${response.data?.orderId}`,
    );
    return response.data;
  });
}

async function closeExistingPosition(
  positionId,
  instrumentId,
  tickerSymbol,
  unitsToClose = null,
) {
  if (process.env.TRADING_MODE === "dry_run") {
    logger.info(
      `[DRY RUN] Would close ${tickerSymbol} positionId=${positionId}`,
    );
    return { dryRun: true, symbol: tickerSymbol, positionId };
  }

  logger.info(
    `Closing position: ${tickerSymbol} | positionId=${positionId}${unitsToClose ? ` | units=${unitsToClose}` : " (full close)"}`,
  );

  return executeWithRetry(async () => {
    const response = await axios.post(
      `${ETORO_BASE_URL}/trading/execution/market-close-orders/positions/${positionId}`,
      {
        InstrumentId: instrumentId,
        UnitsToDeduct: unitsToClose,
      },
      { headers: buildRequestHeaders() },
    );
    logger.info(`✅ Position closed: ${tickerSymbol} positionId=${positionId}`);
    return response.data;
  });
}

// Close a FRACTION of a position (for partial profit-taking). Fetches the
// position's current units and deducts the requested fraction. Falls back to
// a full close if units can't be determined.
async function closePartialPosition(
  positionId,
  instrumentId,
  tickerSymbol,
  fraction,
) {
  if (process.env.TRADING_MODE === "dry_run") {
    logger.info(
      `[DRY RUN] Would partial-close ${(fraction * 100).toFixed(0)}% of ${tickerSymbol}`,
    );
    return { dryRun: true, symbol: tickerSymbol, positionId, fraction };
  }

  let unitsToClose = null;
  try {
    const rawPortfolio = await fetchRawPortfolio();
    const parsed = parsePortfolioFromRawData(rawPortfolio);
    const position = (parsed.openPositions || []).find(
      (openPosition) => openPosition.positionId === positionId,
    );
    if (position && position.units > 0) {
      unitsToClose = position.units * fraction;
    }
  } catch (lookupError) {
    logger.warn(
      "Could not look up units for partial close of " +
        tickerSymbol +
        " — falling back to full close: " +
        lookupError.message,
    );
  }

  // If we couldn't compute units, close fully rather than risk an error
  return closeExistingPosition(
    positionId,
    instrumentId,
    tickerSymbol,
    unitsToClose,
  );
}

module.exports = {
  findDuplicatePositions,
  fetchRawPortfolio,
  parsePortfolioFromRawData,
  resolveTickerToInstrumentId,
  resolveInstrumentIdToTicker,
  labelPositionsWithTickers,
  openBuyPosition,
  closeExistingPosition,
  closePartialPosition,
  sleep,
  instrumentIdCache,
  instrumentNameCache,
};
