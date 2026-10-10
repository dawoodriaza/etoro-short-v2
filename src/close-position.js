#!/usr/bin/env node
// src/close-position.js — manually close a position, with the SAME
// bookkeeping the bot's own exit path performs.
//
//   node src/close-position.js RIVN                 # dry run, shows the plan
//   node src/close-position.js RIVN --confirm       # actually closes it
//   node src/close-position.js RIVN --fraction 0.5 --confirm   # close half
//   node src/close-position.js --all --confirm      # close EVERYTHING
//   node src/close-position.js --list               # just show what's open
//
// WHY THIS EXISTS AS ITS OWN SCRIPT (not a flag on index.js): index.js
// boots the schedulers, the price stream and the Telegram bot. Running it
// to place one order would start a second live trading process alongside
// the pm2 one. This script does exactly one thing and exits.
//
// WHY THE ACCOUNTING MATTERS: closing a position on eToro without updating
// the bot's own records is precisely what creates the ghost positions,
// capital drift and phantom P&L this codebase has spent a lot of effort
// eliminating. So a close here also:
//   · records realized P&L to the capital ledger (compounding + de-risk)
//   · records it against the daily loss limit
//   · starts the loss-aware cooldown so the bot doesn't instantly re-enter
//   · writes the trade to performance history and the decision journal
//   · removes the position from position-meta.json
//
// Positions the bot never tracked (a manual trade, or one it lost track of)
// can still be closed — the bookkeeping steps that need meta are skipped
// and that is stated explicitly rather than silently guessed at.
//
// DRY RUN IS THE DEFAULT. Nothing is sent to eToro without --confirm.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const etoroClient = require("./etoro-client");
const riskManager = require("./strategies/risk-manager");
const capitalManager = require("./strategies/capital-manager");
const cooldownTracker = require("./strategies/cooldown-tracker");
const performance = require("./strategies/performance-tracker");
const journal = require("./strategies/decision-journal");
const { withPositionLock } = require("./position-lock"); // v8.1: shared with the live bot

const positionMetaPath = path.join(__dirname, "../data/position-meta.json");
const money = (value) => "$" + Number(value || 0).toFixed(2);

function loadPositionMeta() {
  try {
    if (!fs.existsSync(positionMetaPath)) return {};
    return JSON.parse(fs.readFileSync(positionMetaPath, "utf8"));
  } catch {
    return {};
  }
}

function savePositionMeta(meta) {
  const directory = path.dirname(positionMetaPath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(positionMetaPath, JSON.stringify(meta, null, 2));
}

// ── Arguments ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const confirm = argv.includes("--confirm");
const closeAll = argv.includes("--all");
const listOnly = argv.includes("--list");

const fractionIndex = argv.indexOf("--fraction");
const fraction =
  fractionIndex !== -1 ? Number(argv[fractionIndex + 1]) : 1;

const symbolArgument = argv.find(
  (arg, index) =>
    !arg.startsWith("--") &&
    !(fractionIndex !== -1 && index === fractionIndex + 1),
);

if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
  console.error("\n❌ --fraction must be between 0 and 1 (e.g. 0.5 for half).\n");
  process.exit(1);
}

if (!listOnly && !closeAll && !symbolArgument) {
  console.error(
    "\nUsage:\n" +
      "  node src/close-position.js <SYMBOL>                 dry run\n" +
      "  node src/close-position.js <SYMBOL> --confirm       close it\n" +
      "  node src/close-position.js <SYMBOL> --fraction 0.5 --confirm\n" +
      "  node src/close-position.js --all --confirm          close everything\n" +
      "  node src/close-position.js --list                   show open positions\n",
  );
  process.exit(1);
}

(async () => {
  const raw = await etoroClient.fetchRawPortfolio();
  const portfolio = etoroClient.parsePortfolioFromRawData(raw);
  await etoroClient.labelPositionsWithTickers(portfolio);
  const meta = loadPositionMeta();

  console.log("\n═══ OPEN ON ETORO (" + portfolio.openPositions.length + ") ═══");
  for (const position of portfolio.openPositions) {
    const tracked = meta[position.symbol.toUpperCase()] ? "tracked" : "UNTRACKED";
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
        "  [" +
        tracked +
        "]",
    );
  }
  if ((portfolio.pendingOrders || []).length > 0) {
    console.log(
      "\n  NOTE: " +
        portfolio.pendingOrders.length +
        " order(s) are QUEUED but unfilled. Those are not positions and " +
        "cannot be closed here — cancel them in the eToro app.",
    );
  }

  if (listOnly) {
    console.log("");
    return;
  }

  // ── Pick targets ─────────────────────────────────────────────────────
  const targets = closeAll
    ? portfolio.openPositions
    : portfolio.openPositions.filter(
        (position) =>
          position.symbol.toUpperCase() === symbolArgument.toUpperCase(),
      );

  if (targets.length === 0) {
    console.error(
      "\n❌ No open position found for " +
        (closeAll ? "--all" : symbolArgument.toUpperCase()) +
        " on eToro. Nothing to close.\n",
    );
    process.exit(1);
  }

  console.log("\n═══ WOULD CLOSE ═══");
  for (const position of targets) {
    const positionMeta = meta[position.symbol.toUpperCase()];
    console.log(
      "  " +
        position.symbol +
        "  " +
        (fraction < 1 ? (fraction * 100).toFixed(0) + "% of " : "ALL of ") +
        money(position.amountInvested) +
        "  realizing " +
        (position.unrealizedProfitLoss >= 0 ? "+" : "") +
        money(position.unrealizedProfitLoss * fraction) +
        (positionMeta
          ? ""
          : "   ⚠️  not tracked by the bot — no cooldown/performance record will be written"),
    );
  }

  if (!confirm) {
    console.log(
      "\nDRY RUN — nothing sent to eToro. Re-run with --confirm to execute.\n",
    );
    return;
  }

  // ── Execute ──────────────────────────────────────────────────────────
  console.log("\n═══ EXECUTING ═══");
  // v8.1: under the SAME position lock as the live bot (a lock file shared
  // across processes), with positions and meta re-read inside it. The bot
  // may have trimmed or closed a position while this script showed its plan;
  // before this, both processes could write conflicting copies of the meta.
  await withPositionLock("manual-close", async () => {
    const meta = loadPositionMeta();
    const freshPortfolio = etoroClient.parsePortfolioFromRawData(
      await etoroClient.fetchRawPortfolio(),
    );
    await etoroClient.labelPositionsWithTickers(freshPortfolio);
    const livePositionsById = new Map(
      freshPortfolio.openPositions.map((livePosition) => [
        String(livePosition.positionId),
        livePosition,
      ]),
    );
    let metaChanged = false;

    for (const target of targets) {
      const position = livePositionsById.get(String(target.positionId));
      if (!position) {
        console.log(
          "  ⏭  " + target.symbol + " is no longer open (closed while waiting) — skipped",
        );
        continue;
      }
      const symbol = position.symbol.toUpperCase();
      const positionMeta = meta[symbol];
      const legPnlDollars = (position.unrealizedProfitLoss || 0) * fraction;

      try {
        if (fraction < 1) {
          await etoroClient.closePartialPosition(
            position.positionId,
            position.instrumentId,
            symbol,
            fraction,
          );
          console.log(
            "  ✅ " + symbol + " partial close sent (" + (fraction * 100).toFixed(0) + "%)",
          );
          // v8: a partial realizes cash now (ledger) but does NOT end the
          // trade. Its P&L rides on the meta until the final close — the same
          // accounting as the bot's own partial path — instead of being
          // written as a separate "trade" with its own cooldown.
          capitalManager.recordRealizedPnl(legPnlDollars);
          if (positionMeta) {
            if (!positionMeta.originalDollarAmount) {
              positionMeta.originalDollarAmount =
                positionMeta.dollarAmount || position.amountInvested;
            }
            positionMeta.realizedPartialPnl = Number(
              ((positionMeta.realizedPartialPnl || 0) + legPnlDollars).toFixed(2),
            );
            positionMeta.partialFills = (positionMeta.partialFills || []).concat([
              {
                at: new Date().toISOString(),
                reason: "MANUAL_PARTIAL",
                fraction,
                pnlDollars: Number(legPnlDollars.toFixed(2)),
              },
            ]);
            if (typeof positionMeta.dollarAmount === "number") {
              positionMeta.dollarAmount = Number(
                (positionMeta.dollarAmount * (1 - fraction)).toFixed(2),
              );
            }
            // Flag the tier as banked so the bot's own ladder doesn't double-sell.
            positionMeta.partialDone = true;
            if (
              !positionMeta.lockedFloor ||
              positionMeta.lockedFloor < positionMeta.entryPrice
            ) {
              positionMeta.lockedFloor = positionMeta.entryPrice;
            }
            metaChanged = true;
          }
        } else {
          await etoroClient.closeExistingPosition(
            position.positionId,
            position.instrumentId,
            symbol,
          );
          console.log("  ✅ " + symbol + " closed");

          // ── Bookkeeping, mirroring the bot's own exit path ─────────────
          // The ledger gets only the final leg (partials were booked when
          // they filled); the daily tracker and cooldown judge the WHOLE trade.
          capitalManager.recordRealizedPnl(legPnlDollars);
          if (positionMeta) {
            const heldMinutes = Math.round(
              (Date.now() - (positionMeta.openedAt || Date.now())) / 60000,
            );
            const closedTrade = performance.buildClosedTradeRecord({
              symbol,
              positionMeta,
              livePosition: position,
              exitReason: "MANUAL_CLOSE",
              heldMinutes,
            });
            riskManager.recordClosedTradeResult(closedTrade.pnlDollars);
            cooldownTracker.startCooldown(symbol, {
              wasLoss: closedTrade.pnlDollars < 0,
              scoreAtExit:
                (positionMeta.plan && positionMeta.plan.score) ??
                (positionMeta.entryConditions &&
                  positionMeta.entryConditions.score) ??
                null,
            });
            performance.recordTrade(closedTrade);
            journal.tradeClosed({
              symbol,
              tradeType: positionMeta.tradeType || "DAY",
              source: positionMeta.source || "WATCHLIST",
              exitReason: "MANUAL_CLOSE",
              pnlDollars: closedTrade.pnlDollars,
              pnlPercent: Number(closedTrade.pnlPercent.toFixed(2)),
              partialPnlDollars: closedTrade.partialPnlDollars,
              heldMinutes,
              plan: positionMeta.plan || null,
            });
            delete meta[symbol];
            metaChanged = true;
          } else {
            riskManager.recordClosedTradeResult(legPnlDollars);
            console.log(
              "     (untracked — realized P&L recorded to the capital ledger, " +
                "but no cooldown/performance entry since there was no plan)",
            );
          }
        }
      } catch (closeError) {
        console.error(
          "  ❌ " +
            symbol +
            " FAILED: " +
            (closeError.response
              ? JSON.stringify(closeError.response.data)
              : closeError.message),
        );
      }

      await etoroClient.sleep(2000); // respect the rate limit between orders
    }

    if (metaChanged) savePositionMeta(meta);
  });

  // ── Verify against the real account ──────────────────────────────────
  console.log("\n═══ VERIFYING ═══");
  await etoroClient.sleep(3000);
  const afterRaw = await etoroClient.fetchRawPortfolio();
  const after = etoroClient.parsePortfolioFromRawData(afterRaw);
  await etoroClient.labelPositionsWithTickers(after);
  console.log("  open positions now: " + after.openPositions.length);
  for (const position of after.openPositions) {
    console.log(
      "    " + position.symbol + "  " + money(position.amountInvested),
    );
  }
  console.log("  equity: " + money(after.totalEquity));
  const capitalState = capitalManager.getCapitalState();
  console.log("  effective capital: " + money(capitalState.effectiveCapital));
  console.log("");
})().catch((error) => {
  console.error(
    "\n❌ " +
      (error.response ? JSON.stringify(error.response.data) : error.message) +
      "\n",
  );
  process.exit(1);
});
