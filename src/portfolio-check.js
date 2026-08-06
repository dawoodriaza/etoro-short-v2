#!/usr/bin/env node
// src/portfolio-check.js — read-only snapshot of the REAL eToro account,
// cross-checked against what the bot thinks it's tracking.
//
// Run this any time you want to know "what does eToro actually show" or
// "does that match what the bot believes." Makes no trades, changes
// nothing — pure read.
//
//   node src/portfolio-check.js
//
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const etoroClient = require("./etoro-client");

const metaPath = path.join(__dirname, "../data/position-meta.json");

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return {};
  }
}

const money = (value) => "$" + Number(value || 0).toFixed(2);

(async () => {
  console.log("Fetching the REAL portfolio from eToro...\n");
  const raw = await etoroClient.fetchRawPortfolio();
  const parsed = etoroClient.parsePortfolioFromRawData(raw);
  await etoroClient.labelPositionsWithTickers(parsed);

  const meta = loadMeta();
  const liveBySymbol = {};
  for (const position of parsed.openPositions) {
    liveBySymbol[position.symbol.toUpperCase()] = position;
  }

  console.log("═══ LIVE ON ETORO (" + parsed.openPositions.length + " position(s)) ═══");
  if (parsed.openPositions.length === 0) {
    console.log("  (none)");
  }
  for (const position of parsed.openPositions) {
    const trackedByBot = !!meta[position.symbol.toUpperCase()];
    console.log(
      "  " +
        position.symbol.padEnd(6) +
        money(position.amountInvested).padStart(10) +
        "  open $" +
        position.openPrice +
        "  P&L " +
        (position.unrealizedProfitLoss >= 0 ? "+" : "") +
        money(position.unrealizedProfitLoss) +
        "  positionId=" +
        position.positionId +
        (trackedByBot ? "" : "  ⚠️  NOT tracked by the bot"),
    );
  }

  console.log(
    "\n═══ TRACKED BY THE BOT (" + Object.keys(meta).length + " position(s)) ═══",
  );
  if (Object.keys(meta).length === 0) {
    console.log("  (none)");
  }
  for (const [symbol, positionMeta] of Object.entries(meta)) {
    const isLive = !!liveBySymbol[symbol.toUpperCase()];
    const ageMinutes = Math.round(
      (Date.now() - (positionMeta.openedAt || Date.now())) / 60000,
    );
    console.log(
      "  " +
        symbol.padEnd(6) +
        money(positionMeta.dollarAmount).padStart(10) +
        "  " +
        (positionMeta.tradeType || "DAY").padEnd(5) +
        "  opened " +
        ageMinutes +
        "min ago" +
        (positionMeta.confirmedInPortfolioAt
          ? " (confirmed on eToro at " + positionMeta.confirmedInPortfolioAt + ")"
          : " (NEVER confirmed on eToro)") +
        (isLive ? "" : "  ⚠️  NOT currently live on eToro"),
    );
  }

  // v7.2: pending orders, from ALL of eToro's order arrays.
  console.log(
    "\n═══ PENDING ORDERS (" + (parsed.pendingOrders || []).length + ") ═══",
  );
  if ((parsed.pendingOrders || []).length === 0) {
    console.log("  (none)");
  }
  for (const order of parsed.pendingOrders || []) {
    console.log(
      "  instrumentId=" +
        order.instrumentId +
        "  " +
        money(order.amount) +
        "  from " +
        order.source +
        "  orderId=" +
        order.orderId,
    );
  }

  const liveOnly = parsed.openPositions.filter(
    (p) => !meta[p.symbol.toUpperCase()],
  );
  const trackedOnly = Object.keys(meta).filter(
    (symbol) => !liveBySymbol[symbol.toUpperCase()],
  );

  // v7.2: this used to compare symbol PRESENCE only, and so reported
  // "no mismatches" while META was tracked at $2,150 against a real
  // $1,113.74. Value drift is the mismatch that actually costs money.
  const valueDrift = [];
  for (const [symbol, positionMeta] of Object.entries(meta)) {
    const live = liveBySymbol[symbol.toUpperCase()];
    if (!live) continue;
    const trackedAmount = positionMeta.dollarAmount || 0;
    const amountDriftPct =
      trackedAmount > 0
        ? Math.abs(live.amountInvested - trackedAmount) / trackedAmount
        : 0;
    const entryDriftPct =
      positionMeta.entryPrice > 0
        ? Math.abs(live.openPrice - positionMeta.entryPrice) /
          positionMeta.entryPrice
        : 0;
    if (amountDriftPct > 0.02 || entryDriftPct > 0.002) {
      valueDrift.push({ symbol, live, positionMeta, amountDriftPct, entryDriftPct });
    }
  }

  console.log("\n═══ MISMATCHES ═══");
  if (
    liveOnly.length === 0 &&
    trackedOnly.length === 0 &&
    valueDrift.length === 0
  ) {
    console.log("  none — the bot's tracking matches the live account exactly.");
  }
  for (const position of liveOnly) {
    console.log(
      "  ⚠️  " +
        position.symbol +
        " is OPEN on eToro but the bot has NO record of it — untracked, no stop enforcement.",
    );
  }
  for (const symbol of trackedOnly) {
    console.log(
      "  ⚠️  " +
        symbol +
        " is tracked by the bot but NOT open on eToro — will be cleared as a ghost.",
    );
  }
  for (const drift of valueDrift) {
    if (drift.amountDriftPct > 0.02) {
      console.log(
        "  ⚠️  " +
          drift.symbol +
          " AMOUNT drift: bot tracks " +
          money(drift.positionMeta.dollarAmount) +
          " but eToro holds " +
          money(drift.live.amountInvested) +
          "  (" +
          (drift.amountDriftPct * 100).toFixed(0) +
          "% off)",
      );
    }
    if (drift.entryDriftPct > 0.002) {
      console.log(
        "  ⚠️  " +
          drift.symbol +
          " ENTRY drift: bot tracks $" +
          drift.positionMeta.entryPrice +
          " but eToro filled at $" +
          drift.live.openPrice +
          "  (" +
          (drift.entryDriftPct * 100).toFixed(2) +
          "% off)",
      );
    }
  }

  console.log(
    "\nEquity: " +
      money(parsed.totalEquity) +
      "  ·  available cash " +
      money(parsed.availableCash) +
      "  ·  invested " +
      money(parsed.totalAmountInvested) +
      "  ·  unrealized " +
      (parsed.totalUnrealizedProfitLoss >= 0 ? "+" : "") +
      money(parsed.totalUnrealizedProfitLoss),
  );
})().catch((error) => {
  console.error(
    "\n❌ Could not fetch the portfolio: " +
      (error.response ? JSON.stringify(error.response.data) : error.message),
  );
  process.exit(1);
});
