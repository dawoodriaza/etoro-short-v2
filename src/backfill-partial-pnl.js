#!/usr/bin/env node
// src/backfill-partial-pnl.js — ESTIMATE the partial profit that trade
// records written before v8 never captured.
//
// Before v8 a partial exit sold units and realized cash on eToro, but the
// closed-trade record only held the LAST leg (the runner's P&L). The
// 2026-09 audit measured ≈ +$1,008 missing across 57 of 210 trades; 17
// winning trades were recorded as losses.
//
// This script does NOT change pnlDollars — the recorded leg stays as it was.
// It ADDS, to every pre-v8 record:
//   estimatedPartialPnlDollars   partial profit estimated from the journal
//   estimatedTradePnlDollars     pnlDollars + the estimate
//   partialEstimate              { partials, originalDollarAmount, method, backfilledAt }
//
// Estimate per partial = original size × share sold × (decision price /
// entry − 1), from the EXIT_DECISION PARTIAL events in the decision journal.
// Original size is the planned amount; when the record's dollarAmount had
// already been shrunk by the partial (v7.3+), the smaller of the plan and
// the un-shrunk amount. The decision price is eToro's own P&L-derived price
// at the tick that fired, so the error is the few-seconds slippage to fill.
//
// Run it while the book is flat — the live bot also writes trade-history.json.
//
//   node src/backfill-partial-pnl.js                 # dry run: what would be added
//   node src/backfill-partial-pnl.js --apply         # write (backs the file up first)
//   node src/backfill-partial-pnl.js --data-dir PATH # use a copy of the data dir
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const config = require("./config");

const ESTIMATE_METHOD =
  "journal EXIT_DECISION PARTIAL price x share sold x original planned size (v8.1 backfill)";

function partialFractionFor(reason) {
  switch (reason) {
    case "TARGET_1_HIT":
      return config.partialExitFraction;
    case "PROFIT_STALL_LOCK":
      return config.profitStallLockFraction;
    case "AI_REVIEW_PARTIAL":
      return config.reviewerTakePartialFraction;
    case "SWING_T1_HIT":
      return 1 / 3;
    case "SWING_T2_HIT":
      return 0.5;
    default:
      return config.partialExitFraction;
  }
}

// partialEvents: [{ tsMs, reason, price }] for this trade's symbol.
// Returns null for records that already carry true (v8) accounting.
function estimatePartialPnl(trade, partialEvents) {
  if (!trade || trade.pnlAccountingVersion === 2) return null;
  const openMs = Date.parse(trade.openedAt);
  const closeMs = Date.parse(trade.closedAt);
  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs) || !(trade.entryPrice > 0)) {
    return { dollars: 0, partials: [], originalDollarAmount: trade.dollarAmount || null };
  }
  const matching = (partialEvents || [])
    .filter((event) => event.tsMs >= openMs - 60000 && event.tsMs <= closeMs + 60000)
    .sort((a, b) => a.tsMs - b.tsMs);
  const fractions = matching.map((event) => partialFractionFor(event.reason));
  const keptShare = fractions.reduce((kept, fraction) => kept * (1 - fraction), 1);

  const planned = trade.plan && trade.plan.positionDollars;
  const recorded = Number(trade.dollarAmount) || 0;
  let originalDollarAmount = planned || recorded;
  if (planned && matching.length && keptShare > 0 && recorded / planned < 0.7) {
    originalDollarAmount = Math.min(planned, recorded / keptShare);
  }

  let remainingShare = 1;
  let dollars = 0;
  const partials = matching.map((event, index) => {
    const shareSold = remainingShare * fractions[index];
    const partialDollars = originalDollarAmount * shareSold * (event.price / trade.entryPrice - 1);
    remainingShare -= shareSold;
    dollars += partialDollars;
    return {
      at: new Date(event.tsMs).toISOString(),
      reason: event.reason,
      price: event.price,
      shareSold: Number(shareSold.toFixed(4)),
      dollars: Number(partialDollars.toFixed(2)),
    };
  });
  return {
    dollars: Number(dollars.toFixed(2)),
    partials,
    originalDollarAmount: Number(Number(originalDollarAmount).toFixed(2)),
  };
}

function loadPartialEventsBySymbol(journalDir) {
  const bySymbol = new Map();
  if (!fs.existsSync(journalDir)) return bySymbol;
  for (const file of fs.readdirSync(journalDir).filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of fs.readFileSync(path.join(journalDir, file), "utf8").split("\n")) {
      if (!line.includes('"EXIT_DECISION"') || !line.includes('"PARTIAL"')) continue;
      try {
        const event = JSON.parse(line);
        if (event.event !== "EXIT_DECISION" || event.action !== "PARTIAL") continue;
        const symbol = String(event.symbol || "").toUpperCase();
        if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
        bySymbol.get(symbol).push({
          tsMs: Date.parse(event.ts),
          reason: event.reason,
          price: Number(event.currentPrice),
        });
      } catch {
        /* truncated tail line */
      }
    }
  }
  return bySymbol;
}

function backfill(history, eventsBySymbol, nowIso) {
  let legacy = 0;
  let alreadyDone = 0;
  let withPartials = 0;
  let estimateTotal = 0;
  let bookedTotal = 0;
  const changes = [];
  for (const trade of history) {
    if (trade.pnlAccountingVersion === 2) continue;
    legacy++;
    bookedTotal += Number(trade.pnlDollars) || 0;
    if (trade.estimatedPartialPnlDollars != null) {
      alreadyDone++;
      estimateTotal += trade.estimatedPartialPnlDollars;
      continue;
    }
    const estimate = estimatePartialPnl(
      trade,
      eventsBySymbol.get(String(trade.symbol || "").toUpperCase()),
    );
    trade.estimatedPartialPnlDollars = estimate.dollars;
    trade.estimatedTradePnlDollars = Number(((Number(trade.pnlDollars) || 0) + estimate.dollars).toFixed(2));
    trade.partialEstimate = {
      partials: estimate.partials,
      originalDollarAmount: estimate.originalDollarAmount,
      method: ESTIMATE_METHOD,
      backfilledAt: nowIso,
    };
    if (estimate.partials.length) {
      withPartials++;
      changes.push(trade);
    }
    estimateTotal += estimate.dollars;
  }
  return { legacy, alreadyDone, withPartials, estimateTotal, bookedTotal, changes };
}

module.exports = { estimatePartialPnl, partialFractionFor, backfill, loadPartialEventsBySymbol };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dataDirIndex = argv.indexOf("--data-dir");
  const dataDir =
    dataDirIndex !== -1 && argv[dataDirIndex + 1]
      ? path.resolve(argv[dataDirIndex + 1])
      : path.join(__dirname, "../data");
  const apply = argv.includes("--apply");
  const historyPath = path.join(dataDir, "trade-history.json");
  const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
  const eventsBySymbol = loadPartialEventsBySymbol(path.join(dataDir, "journal"));
  const result = backfill(history, eventsBySymbol, new Date().toISOString());

  const money = (value) => (value >= 0 ? "+$" : "-$") + Math.abs(value).toFixed(2);
  console.log("\n═══ PARTIAL P&L BACKFILL (" + (apply ? "APPLY" : "dry run") + ") ═══");
  console.log("  pre-v8 records               : " + result.legacy + (result.alreadyDone ? " (" + result.alreadyDone + " already backfilled)" : ""));
  console.log("  records with a partial found : " + result.withPartials);
  console.log("  recorded (runner-only) P&L   : " + money(result.bookedTotal));
  console.log("  estimated partial profit     : " + money(result.estimateTotal));
  console.log("  estimated whole-trade P&L    : " + money(result.bookedTotal + result.estimateTotal));
  const flipped = history.filter(
    (trade) => trade.pnlAccountingVersion !== 2 && trade.pnlDollars < 0 && trade.estimatedTradePnlDollars > 0,
  ).length;
  console.log("  losses that were really wins : " + flipped);
  result.changes
    .sort((a, b) => b.estimatedPartialPnlDollars - a.estimatedPartialPnlDollars)
    .slice(0, 8)
    .forEach((trade) =>
      console.log(
        "    " + String(trade.symbol).padEnd(6) + " " + trade.openedAt.slice(0, 16) +
          "  recorded " + money(trade.pnlDollars).padStart(9) +
          "  + partial " + money(trade.estimatedPartialPnlDollars).padStart(9),
      ),
    );

  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply (while the book is flat).\n");
  } else {
    const backupPath = historyPath.replace(/\.json$/, ".pre-partial-backfill-" + Date.now() + ".json");
    fs.copyFileSync(historyPath, backupPath);
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
    console.log("\n✅ Written. Backup: " + backupPath + "\n");
  }
}
