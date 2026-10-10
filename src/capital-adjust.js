#!/usr/bin/env node
// src/capital-adjust.js — declare a deposit or withdrawal to the bot.
//
// Run this on the server whenever you move money in or out of the eToro
// account. The bot also auto-detects large transfers on its next scan, but
// that is a heuristic on an equity gap; this is exact and immediate.
//
//   node src/capital-adjust.js -3000                "withdrew $3,000"
//   node src/capital-adjust.js -3000 "vacation"     with a note
//   node src/capital-adjust.js +500  "topped up"    deposit
//   node src/capital-adjust.js --status             show state, change nothing
//
// WHAT IT DOES
//   · moves the capital base, so position sizing and the capital floor
//     both follow the real account balance
//   · rescales the drawdown peak proportionally, so a withdrawal does not
//     read as a loss and cannot trip the circuit breaker
//   · leaves daily P&L untouched, so it never creates a "losing day" or
//     triggers de-risking
//
// It does NOT move money at eToro. Do the transfer in the eToro app first,
// then run this to tell the bot what you did.
require("dotenv").config();
const capitalManager = require("./strategies/capital-manager");

const money = (value) =>
  (value < 0 ? "-$" : "$") + Math.abs(Number(value)).toFixed(2);

function printStatus(heading) {
  const state = capitalManager.getCapitalState();
  const drawdownPct =
    state.peakEffectiveCapital > 0
      ? ((state.peakEffectiveCapital - state.effectiveCapital) /
          state.peakEffectiveCapital) *
        100
      : 0;

  console.log("\n" + heading);
  console.log("  base capital (.env DT_CAPITAL) : " + money(state.baseCapital));
  console.log("  owner deposits/withdrawals     : " + money(state.ownerAdjustments));
  console.log("  → capital base after transfers : " + money(state.effectiveBase));
  console.log("  realized trading P&L           : " + money(state.cumulativeRealizedPnl));
  console.log("  ═ effective capital            : " + money(state.effectiveCapital));
  console.log("  drawdown peak                  : " + money(state.peakEffectiveCapital));
  console.log(
    "  current drawdown               : " +
      drawdownPct.toFixed(1) +
      "%  (breaker trips at " +
      (require("./config").maxDrawdownFromPeakPct * 100).toFixed(0) +
      "%)",
  );
  console.log(
    "  halted                         : " +
      (capitalManager.isHalted() ? "YES — data/halt.flag exists" : "no"),
  );
}

const [rawAmount, rawNote] = process.argv.slice(2);

if (!rawAmount || rawAmount === "--status" || rawAmount === "-s") {
  printStatus("📊 Capital state (unchanged):");
  console.log(
    "\nTo declare a transfer:  node src/capital-adjust.js -3000 \"reason\"\n",
  );
  process.exit(0);
}

const amount = Number(rawAmount);
if (!Number.isFinite(amount) || amount === 0) {
  console.error(
    "\n❌ Amount must be a non-zero number.\n" +
      "   Negative = withdrawal, positive = deposit.\n" +
      "   e.g.  node src/capital-adjust.js -3000 \"vacation\"\n",
  );
  process.exit(1);
}

printStatus("📊 BEFORE:");

const result = capitalManager.applyCapitalTransfer(
  amount,
  rawNote || "declared manually via capital-adjust.js",
);

if (!result.applied) {
  console.error("\n❌ Not applied: " + result.reason + "\n");
  process.exit(1);
}

printStatus("✅ AFTER:");

console.log(
  "\nThe drawdown percentage is deliberately unchanged — a transfer is not\n" +
    "a loss. Position sizing now follows the real account balance.\n",
);

if (capitalManager.isHalted()) {
  console.log(
    "⚠️  data/halt.flag still exists from an EARLIER event, so new entries\n" +
      "   remain blocked. Delete it to resume:  rm data/halt.flag\n",
  );
}
