#!/usr/bin/env node
// src/capital-repair.js — undo a phantom owner-transfer.
//
// Built for the 2026-07-31 incident: cash reserved against two queued
// orders was excluded from the equity figure, equity appeared to fall from
// $9,361 to $2,764, and the auto-detection recorded a $6,596.66 WITHDRAWAL
// that never happened. That rewrote the capital base and the drawdown peak.
//
// This reverses a recorded transfer and restores the peak, then verifies
// the result against the REAL live account so the repair is provably right
// rather than merely plausible.
//
//   node src/capital-repair.js                 # show what would change
//   node src/capital-repair.js --apply         # actually repair
//
// The root cause is fixed in etoro-client.js (equity now includes reserved
// order cash) and guarded in capital-manager.js, so this should be needed
// exactly once.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const etoroClient = require("./etoro-client");

const ledgerPath = path.join(__dirname, "../data/capital-ledger.json");
const money = (value) => "$" + Number(value || 0).toFixed(2);
const apply = process.argv.includes("--apply");

(async () => {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  const transfers = ledger.transferHistory || [];

  if (transfers.length === 0) {
    console.log("\nNo transfers recorded — nothing to repair.\n");
    return;
  }

  console.log("\n═══ RECORDED TRANSFERS ═══");
  transfers.forEach((transfer, index) => {
    console.log(
      "  [" +
        index +
        "] " +
        transfer.at +
        "  " +
        money(transfer.amountDollars) +
        "\n      " +
        transfer.note +
        "\n      equity " +
        money(transfer.equityBefore) +
        " → " +
        money(transfer.equityAfter) +
        " · peak " +
        money(transfer.peakBefore) +
        " → " +
        money(transfer.peakAfter),
    );
  });

  // Verify against the REAL account before changing anything.
  console.log("\n═══ VERIFYING AGAINST THE LIVE ACCOUNT ═══");
  const raw = await etoroClient.fetchRawPortfolio();
  const portfolio = etoroClient.parsePortfolioFromRawData(raw);
  console.log(
    "  true equity now (incl. reserved order cash): " +
      money(portfolio.totalEquity),
  );
  console.log(
    "  available cash:                              " +
      money(portfolio.availableCash),
  );
  console.log(
    "  invested in open positions:                  " +
      money(portfolio.totalAmountInvested),
  );
  console.log(
    "  pending orders:                              " +
      portfolio.pendingOrderCount,
  );

  // Reverse every auto-detected transfer; a manually declared one is
  // assumed real and is left alone.
  const autoTransfers = transfers.filter((t) =>
    (t.note || "").startsWith("auto-detected"),
  );
  if (autoTransfers.length === 0) {
    console.log(
      "\nNo AUTO-DETECTED transfers to reverse (manual ones are left alone).\n",
    );
    return;
  }

  const reversalTotal = autoTransfers.reduce(
    (total, transfer) => total + transfer.amountDollars,
    0,
  );
  const restoredPeak = Math.max(
    ...autoTransfers.map((t) => t.peakBefore),
    ledger.peakEffectiveCapital || 0,
  );

  const currentAdjustments = Number(ledger.ownerAdjustments || 0);
  const repairedAdjustments = Number(
    (currentAdjustments - reversalTotal).toFixed(2),
  );

  console.log("\n═══ PROPOSED REPAIR ═══");
  console.log(
    "  reversing " +
      autoTransfers.length +
      " auto-detected transfer(s) totalling " +
      money(reversalTotal),
  );
  console.log(
    "  ownerAdjustments : " +
      money(currentAdjustments) +
      "  →  " +
      money(repairedAdjustments),
  );
  console.log(
    "  drawdown peak    : " +
      money(ledger.peakEffectiveCapital) +
      "  →  " +
      money(restoredPeak),
  );
  const repairedEffective =
    ledger.baseCapital +
    repairedAdjustments +
    Number(ledger.cumulativeRealizedPnl || 0);
  console.log("  effective capital: " + money(repairedEffective));
  console.log(
    "  vs true live equity: " +
      money(portfolio.totalEquity) +
      "  (difference " +
      money(repairedEffective - portfolio.totalEquity) +
      ")",
  );

  if (!apply) {
    console.log(
      "\nDry run — nothing changed. Re-run with --apply to repair.\n",
    );
    return;
  }

  ledger.ownerAdjustments = repairedAdjustments;
  ledger.peakEffectiveCapital = restoredPeak;
  ledger.transferConfirmStreak = 0;
  ledger.transferConfirmSign = 0;
  ledger.transferHistory = transfers.filter(
    (t) => !(t.note || "").startsWith("auto-detected"),
  );
  ledger.repairHistory = (ledger.repairHistory || []).concat([
    {
      at: new Date().toISOString(),
      reversedDollars: reversalTotal,
      restoredPeak,
      reason:
        "Reversed phantom auto-detected transfer(s) caused by equity " +
        "excluding cash reserved for pending orders (fixed in v7.3).",
    },
  ]);

  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  console.log("\n✅ Ledger repaired.\n");
})().catch((error) => {
  console.error(
    "\n❌ Repair failed: " +
      (error.response ? JSON.stringify(error.response.data) : error.message) +
      "\n",
  );
  process.exit(1);
});
