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

// Cache resolved instrument IDs to avoid repeated lookups.
//
// v5.7 CRITICAL FIX: this used to be pre-seeded with hardcoded IDs
// (AMD: 1130, ASML: 1832, AAPL: 1, MSFT: 2, TSLA: 3, AMZN: 4, GOOGL: 5, ...).
// Verified live against eToro's own search API — 7 of 9 were WRONG:
//   AMD's real ID is 1832 (the cache had AMD -> 1130, which is actually
//   MICRON/MU); ASML's real ID is 4244 (the cache had ASML -> 1832, which
//   is actually AMD); AAPL/MSFT/TSLA/AMZN/GOOGL were mapped to 1/2/3/4/5 —
//   small placeholder-looking numbers that were never real eToro IDs.
//   Every "AMD" trade this bot ever placed was ACTUALLY trading Micron.
// Root cause: resolveTickerToInstrumentId() below returns straight from
// this cache on a hit, with NO verification against the real ticker —
// a wrong seed value is silently permanent for the life of the process.
// Fix: start EMPTY. Every symbol is resolved via the live instrument
// search on first use (already proven correct — AVGO/MRVL/MU all resolved
// right in production) and cached correctly in memory from then on.
const instrumentIdCache = {};

// Reverse cache: instrument ID (number) -> ticker symbol (string).
// Also started EMPTY for the same reason — the old hardcoded entries here
// were the mirror image of the same wrong IDs above. The bot populates
// this automatically and correctly whenever it resolves a ticker.
const instrumentNameCache = {};

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

// v7.2: eToro's pnl response carries SEVEN order arrays besides `positions`.
// Before this, only `ordersForOpen` and `orders` were read (for cash maths)
// and nothing else was ever looked at — so an order parked in `stockOrders`
// or `entryOrders` was completely invisible to the bot. A position that
// exists as a pending/queued order therefore looked identical to "does not
// exist", the ghost sweeper cleared its tracking, and if it later filled the
// bot had no record of it: no stop, no exit management, no EOD close.
const PENDING_ORDER_ARRAYS = [
  "ordersForOpen",
  "orders",
  "stockOrders",
  "entryOrders",
  "exitOrders",
  "ordersForClose",
  "ordersForCloseMultiple",
];

function collectPendingOrders(clientPortfolio) {
  const pendingOrders = [];
  for (const arrayName of PENDING_ORDER_ARRAYS) {
    const orders = clientPortfolio[arrayName];
    if (!Array.isArray(orders)) continue;
    for (const order of orders) {
      if (!order) continue;
      pendingOrders.push({
        source: arrayName,
        orderId: order.orderID ?? order.orderId ?? null,
        instrumentId: order.instrumentID ?? order.instrumentId ?? null,
        amount: order.amount ?? null,
        isBuy: order.isBuy,
        positionId: order.positionID ?? order.positionId ?? null,
        raw: order,
      });
    }
  }
  return pendingOrders;
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

  const pendingOrders = collectPendingOrders(clientPortfolio);

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

  // ══════════════════════════════════════════════════════════════════════
  // v7.3 CRITICAL FIX — EQUITY MUST INCLUDE CASH RESERVED FOR PENDING ORDERS.
  //
  // This used to be `availableCash + invested + unrealized`, i.e. it
  // subtracted pendingOpenOrderCost from the account's NET WORTH. But cash
  // reserved against an unfilled order has not left the account — it is
  // ring-fenced, not spent. Counting it as gone makes equity collapse and
  // then rebound purely as orders queue and fill.
  //
  // Measured live 2026-07-31: two queued orders of $3,275 reserved $6,550,
  // equity read $2,764.34 instead of the true $9,314.34, and the v7.1
  // owner-transfer auto-detection interpreted the difference as a $6,596.66
  // WITHDRAWAL. It rewrote the capital base from $10,000 to $3,403, cut the
  // drawdown peak from $10,032 to $2,962, and collapsed position sizing to
  // ~$114. No money had moved at all.
  //
  // availableCash below stays as it was — for "can I afford this trade?"
  // reserved cash genuinely is unavailable. The two figures answer
  // different questions and must not share one number.
  const totalEquity =
    (clientPortfolio.credit || 0) +
    totalAmountInvested +
    totalUnrealizedProfitLoss;

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
    // v7.2: every order eToro is holding for this account, from ALL of its
    // order arrays. A symbol appearing here is NOT a ghost — it is in flight.
    pendingOrders,
    pendingOrderCount: pendingOrders.length,
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

// eToro's own asset-class ids. 6 = ETF, 10 = Crypto.
const ASSET_CLASS_CRYPTO = 10;

// ══════════════════════════════════════════════════════════════════════
// v7.4 CRITICAL — REJECT CROSS-ASSET-CLASS TICKER COLLISIONS.
//
// The search endpoint matches on symbol alone and happily returns a
// CRYPTO token for an equity ticker. Measured 2026-08-06: "DIA" resolves
// to instrumentId 100580 — Diadata, a $0.11 crypto on eToro's Digital
// Currency exchange — not the SPDR Dow Jones ETF (~$450). The Dow ETF is
// not listed on eToro under that symbol at all.
//
// As a market-data bug this fabricated a "Dow +5.30%" reading fed
// straight into the AI prompts. As a TRADING bug it is far worse: this
// same resolver supplies the instrumentId used to open positions, so any
// watchlist ticker that collides with a crypto symbol would have real
// money placed on the wrong asset entirely. That is precisely the failure
// documented in the v5.7 note above, where every "AMD" trade was actually
// buying Micron.
//
// Equities and ETFs are what this bot trades, so crypto matches are now
// rejected unless a caller explicitly asks for them.
// ══════════════════════════════════════════════════════════════════════
async function resolveTickerToInstrumentId(tickerSymbol, options = {}) {
  const upperSymbol = tickerSymbol.toUpperCase();
  const allowCrypto = options.allowCrypto === true;

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
    const symbolMatches = searchResults.filter(
      (item) => item.internalSymbolFull?.toUpperCase() === upperSymbol,
    );

    // Prefer a tradeable non-crypto instrument; fall back only if the
    // caller opted in. Several symbols return more than one exact match.
    const acceptable = symbolMatches.filter(
      (item) =>
        allowCrypto || item.internalAssetClassId !== ASSET_CLASS_CRYPTO,
    );

    if (symbolMatches.length > 0 && acceptable.length === 0) {
      logger.warn(
        `${upperSymbol} on eToro is a ${symbolMatches[0].internalAssetClassName || "non-equity"} ` +
          `instrument (id ${symbolMatches[0].internalInstrumentId}, exchange ` +
          `"${symbolMatches[0].internalExchangeName || "?"}", rate ${symbolMatches[0].currentRate}) — ` +
          `NOT the equity/ETF this bot trades. Refusing to resolve it so no ` +
          `order or quote can ever use the wrong asset.`,
      );
      return null;
    }

    const exactMatch = acceptable[0];

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
    // v5.8 FIX: verified live response shape is
    // { instrumentDisplayDatas: [{ symbolFull: "DKNG", ... }] } — the old
    // code looked for response.data.items (doesn't exist) then fell back to
    // response.data itself (a plain object, not an array), so
    // Array.isArray(items) was always false and this ALWAYS silently
    // returned the raw numeric ID. Real-world impact: any held position
    // whose ticker isn't already cached from a forward lookup (e.g. DKNG,
    // removed from the watchlist so nothing re-resolves it) displayed as a
    // bare number instead of its symbol — and since manageOpenPositions/
    // eod-closer match position-meta.json by SYMBOL, that position was
    // silently treated as UNTRACKED: no stop enforcement, no EOD close.
    const items = response.data?.instrumentDisplayDatas || response.data?.items || [];
    const match = Array.isArray(items) ? items[0] : null;
    const ticker =
      match?.symbolFull || match?.internalSymbolFull || match?.ticker;
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
    // Log the FULL raw response — we've only ever logged orderId here, which
    // means a fill that lands smaller/larger than the requested dollarAmount
    // (partial fill, unit rounding, a leverage/margin quirk) has been
    // completely invisible. This makes the actual eToro response visible so
    // a requested-vs-filled mismatch can be diagnosed from the next trade.
    logger.info(
      `✅ Position opened: ${tickerSymbol} requested $${dollarAmount.toFixed(2)} — raw eToro response: ${JSON.stringify(response.data)}`,
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
  collectPendingOrders,
  PENDING_ORDER_ARRAYS,
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
