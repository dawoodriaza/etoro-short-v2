// check-portfolio.js — read-only snapshot of the REAL eToro agent portfolio.
// Never places or closes any order — pure inspection.
//
// Usage:
//   node check-portfolio.js            # summary + open positions
//   node check-portfolio.js --raw      # also dump the raw API response
//
// Run this on the server (same directory as the bot) or on your laptop —
// both read .env for ETORO_PUBLIC_API_KEY / ETORO_AGENT_USER_KEY.
require("dotenv").config();
const etoroClient = require("./src/etoro-client");
const config = require("./src/config");
const { toRealDollars } = require("./src/notifications/format-helpers");

const showRaw = process.argv.includes("--raw");

(async () => {
  const raw = await etoroClient.fetchRawPortfolio();
  if (showRaw) {
    console.log("=== RAW API RESPONSE ===");
    console.log(JSON.stringify(raw, null, 2));
    console.log();
  }

  const portfolio = etoroClient.parsePortfolioFromRawData(raw);
  await etoroClient.labelPositionsWithTickers(portfolio);

  const ratio = config.realAccountCapital / config.dayTradeCapital;

  console.log("════════ PORTFOLIO SNAPSHOT ════════");
  console.log(
    "Agent portfolio: $" +
      portfolio.totalEquity.toFixed(2) +
      " total (" +
      "$" +
      portfolio.availableCash.toFixed(2) +
      " cash + $" +
      portfolio.totalAmountInvested.toFixed(2) +
      " invested)",
  );
  console.log(
    "Your real account (ratio " +
      (ratio * 100).toFixed(2) +
      "%): ~$" +
      toRealDollars(portfolio.totalEquity).toFixed(2) +
      " total",
  );
  console.log(
    "Unrealized P&L: " +
      (portfolio.totalUnrealizedProfitLoss >= 0 ? "+" : "") +
      "$" +
      portfolio.totalUnrealizedProfitLoss.toFixed(2) +
      " agent  (~" +
      (toRealDollars(portfolio.totalUnrealizedProfitLoss) >= 0 ? "+" : "") +
      "$" +
      toRealDollars(portfolio.totalUnrealizedProfitLoss).toFixed(2) +
      " yours)",
  );

  console.log();
  console.log(
    "OPEN POSITIONS (" + portfolio.positionCount + "):",
  );
  if (!portfolio.positionCount) {
    console.log("  (none)");
  }
  for (const p of portfolio.openPositions) {
    const pnlPct = (p.unrealizedProfitLossPercent * 100).toFixed(2);
    console.log(
      "  " +
        p.symbol.padEnd(8) +
        " invested $" +
        p.amountInvested.toFixed(2).padStart(9) +
        "  P&L " +
        (p.unrealizedProfitLoss >= 0 ? "+" : "") +
        "$" +
        p.unrealizedProfitLoss.toFixed(2).padStart(8) +
        " (" +
        (pnlPct >= 0 ? "+" : "") +
        pnlPct +
        "%)" +
        "  entry $" +
        p.openPrice +
        "  positionId " +
        p.positionId,
    );
  }
  console.log("═════════════════════════════════════");
})().catch((err) => {
  console.error("Failed to fetch portfolio:", err.response?.status, err.message);
  process.exit(1);
});
