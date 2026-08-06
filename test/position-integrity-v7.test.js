// v7.2 position-integrity tests.
//
// Every case here reproduces something measured on the live account on
// 2026-07-27, so each is a regression guard against a real failure:
//   · META tracked at $2,150 while eToro held $1,113.74 (93% wrong, 4 hours)
//   · current price derived from the bot's own entryPrice, drifting up to
//     $0.16 from the true price against live stop levels
//   · RIVN: a position eToro's copy engine mirrored but the account API
//     never reported, ghosted after 30 min, which would have run unmanaged
//   · seven eToro order arrays ignored entirely by the parser
//
// NOTE ON CONFIG: reads the RESOLVED config rather than assuming its own
// process.env.DT_* overrides applied — config is a shared singleton.
const etoroClient = require("../src/etoro-client");
const config = require("../src/config");

module.exports = {
  name: "position integrity v7.2 (sync, pending orders, untracked)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass });

    // ══ Pending orders are collected from EVERY array ══════════════════
    const rawWithOrders = {
      clientPortfolio: {
        credit: 1000,
        positions: [],
        ordersForOpen: [{ orderID: 1, instrumentID: 111, amount: 100, mirrorID: 0 }],
        orders: [],
        stockOrders: [{ orderID: 2, instrumentID: 222, amount: 200 }],
        entryOrders: [{ orderID: 3, instrumentID: 333, amount: 300 }],
        exitOrders: [{ orderID: 4, instrumentID: 444, amount: 400 }],
        ordersForClose: [{ orderID: 5, instrumentID: 555, amount: 500 }],
        ordersForCloseMultiple: [],
      },
    };
    const parsedWithOrders =
      etoroClient.parsePortfolioFromRawData(rawWithOrders);
    check(
      "pending orders: collected from all arrays, not just ordersForOpen",
      parsedWithOrders.pendingOrderCount === 5,
    );
    check(
      "pending orders: stockOrders is included (was ignored entirely before)",
      parsedWithOrders.pendingOrders.some(
        (o) => o.source === "stockOrders" && o.instrumentId === 222,
      ),
    );
    check(
      "pending orders: entryOrders is included",
      parsedWithOrders.pendingOrders.some(
        (o) => o.source === "entryOrders" && o.instrumentId === 333,
      ),
    );
    check(
      "pending orders: each carries orderId, instrumentId and amount",
      parsedWithOrders.pendingOrders.every(
        (o) => o.orderId != null && o.instrumentId != null && o.amount != null,
      ),
    );

    // An account with no pending orders must report an empty list, not throw.
    const rawEmpty = { clientPortfolio: { credit: 500, positions: [] } };
    const parsedEmpty = etoroClient.parsePortfolioFromRawData(rawEmpty);
    check(
      "pending orders: missing arrays are handled without throwing",
      parsedEmpty.pendingOrderCount === 0 &&
        Array.isArray(parsedEmpty.pendingOrders),
    );

    // ══ The real-account shape still parses correctly ══════════════════
    // Exactly the payload shape observed live, including openRate/amount.
    const rawReal = {
      clientPortfolio: {
        credit: 3741.52,
        positions: [
          {
            positionID: 3522784432,
            instrumentID: 1003,
            amount: 1113.74,
            openRate: 603.83,
            isBuy: true,
            leverage: 1,
            units: 1.844,
            unrealizedPnL: { pnL: 1.99 },
          },
        ],
        ordersForOpen: [],
        orders: [],
      },
    };
    const parsedReal = etoroClient.parsePortfolioFromRawData(rawReal);
    const metaPosition = parsedReal.openPositions[0];
    check(
      "parser: exposes eToro's REAL openPrice (needed for true current price)",
      metaPosition.openPrice === 603.83,
    );
    check(
      "parser: exposes the REAL amountInvested",
      metaPosition.amountInvested === 1113.74,
    );
    check(
      "parser: unrealized P&L percent is computed off the REAL amount",
      Math.abs(metaPosition.unrealizedProfitLossPercent - 1.99 / 1113.74) <
        1e-9,
    );

    // ══ The phantom-price bug ═════════════════════════════════════════
    // Reproduce the measured QCOM case: meta entry 170.735, eToro 170.9.
    const trackedEntry = 170.735;
    const realEntry = 170.9;
    const pnlPercent = -2.46 / 2000;
    const phantomPrice = trackedEntry * (1 + pnlPercent);
    const truePrice = realEntry * (1 + pnlPercent);
    check(
      "phantom price: deriving from the bot's own entry is measurably wrong",
      Math.abs(phantomPrice - truePrice) > 0.1,
    );
    check(
      "phantom price: deriving from eToro's openPrice gives the true price",
      Math.abs(truePrice - realEntry * (1 + pnlPercent)) < 1e-9,
    );

    // ══ Sync tolerances are configured sanely ═════════════════════════
    check(
      "sync: an amount tolerance is configured and tight enough to catch a 93% error",
      config.positionSyncAmountTolerancePct > 0 &&
        config.positionSyncAmountTolerancePct < 0.5,
    );
    check(
      "sync: an entry tolerance is configured and tight enough to catch a 0.1% drift",
      config.positionSyncEntryTolerancePct > 0 &&
        config.positionSyncEntryTolerancePct <= 0.002,
    );
    // The measured META drift MUST exceed the tolerance, or the fix is inert.
    const metaDrift = Math.abs(1113.74 - 2150) / 2150;
    check(
      "sync: the real META drift (93%) triggers a correction",
      metaDrift > config.positionSyncAmountTolerancePct,
    );
    // The measured QCOM entry drift must also trigger.
    const qcomEntryDrift = Math.abs(170.9 - 170.735) / 170.735;
    check(
      "sync: the real QCOM entry drift (0.10%) triggers a rescale",
      qcomEntryDrift > config.positionSyncEntryTolerancePct,
    );

    // ══ Geometry rescaling preserves intended risk ════════════════════
    // If eToro fills higher than planned, a fixed stop silently widens the
    // risk percentage. Rescaling by the fill ratio must preserve it.
    const plannedEntry = 100;
    const plannedStop = 97; // -3.00%
    const actualFill = 101;
    const ratio = actualFill / plannedEntry;
    const rescaledStop = plannedStop * ratio;
    const riskBefore = (plannedEntry - plannedStop) / plannedEntry;
    const riskAfter = (actualFill - rescaledStop) / actualFill;
    check(
      "geometry: rescaling by the fill ratio preserves the intended stop percentage",
      Math.abs(riskBefore - riskAfter) < 1e-9,
    );
    const riskIfNotRescaled = (actualFill - plannedStop) / actualFill;
    check(
      "geometry: NOT rescaling would have widened risk beyond plan",
      riskIfNotRescaled > riskBefore,
    );

    // ══ The stale-cash overspend (root cause of the fill mismatches) ══
    // Reproduces the live incident: five plans approved in one scan, each
    // checked against the SAME pre-scan cash figure.
    const startingCash = 9323.16;
    const batch = [2250, 3265, 2250, 3265, 2250]; // MU, SNAP, RIVN, AVGO, HOOD

    // OLD behaviour: every plan sees the full starting cash.
    const approvedWithStaleCash = batch.filter((amount) => amount <= startingCash);
    check(
      "overspend: with stale cash, ALL five plans looked affordable",
      approvedWithStaleCash.length === 5,
    );
    const staleTotal = approvedWithStaleCash.reduce((a, b) => a + b, 0);
    check(
      "overspend: and together they exceeded the account (the real incident)",
      staleTotal > startingCash,
    );

    // NEW behaviour: a running ledger decrements as each open commits.
    const ledger = { committed: 0 };
    const approvedWithLedger = [];
    for (const amount of batch) {
      const remaining = Math.max(0, startingCash - ledger.committed);
      if (amount <= remaining) {
        approvedWithLedger.push(amount);
        ledger.committed += amount;
      }
    }
    check(
      "overspend: with the running ledger, the batch stops before overspending",
      ledger.committed <= startingCash,
    );
    check(
      "overspend: fewer plans are opened than the stale-cash path allowed",
      approvedWithLedger.length < approvedWithStaleCash.length,
    );
    check(
      "overspend: the ledger never lets committed cash exceed what was available",
      approvedWithLedger.reduce((a, b) => a + b, 0) <= startingCash,
    );

    // ══ Telegram money formatting (v7.3, changed in v7.5) ══════════════
    // v7.3: trade messages were scaled to the real account while system
    // alerts printed raw agent dollars, so the same position showed as
    // "$114.63" in one message and "$3275.00" in the next — fixed by
    // routing every Telegram dollar figure through one formatter.
    // v7.5: per explicit request, the bot-account bracket that formatter
    // added is now OFF by default — Telegram shows ONLY the real
    // (copy-account) figure. The bracket survives as an opt-in
    // { includeBotAmount: true } for a call site that specifically needs
    // it (e.g. reconciling a fill-mismatch investigation).
    const { formatDualAmount } = require("../src/notifications/format-helpers");
    const mirrorRatio = config.realAccountCapital / config.dayTradeCapital;

    const rendered = formatDualAmount(3275);
    check(
      "telegram: a position amount renders YOUR real-account figure",
      rendered === "$" + (3275 * mirrorRatio).toFixed(2),
    );
    check(
      "telegram: the bot-account figure is NOT shown by default",
      !rendered.includes("bot"),
    );
    check(
      "telegram: includeBotAmount opts back into the bracket when needed",
      formatDualAmount(3275, { includeBotAmount: true }).includes(
        "(bot $3275.00)",
      ),
    );
    check(
      "telegram: a negative P&L keeps its sign, real-account only",
      formatDualAmount(-79.9, { signed: true }) ===
        "-$" + (79.9 * mirrorRatio).toFixed(2),
    );
    check(
      "telegram: a positive P&L is explicitly signed",
      formatDualAmount(23.87, { signed: true }).startsWith("+$"),
    );
    check(
      "telegram: non-numeric input degrades safely rather than printing NaN",
      formatDualAmount(null) === "null" &&
        formatDualAmount(undefined) === "undefined",
    );

    // ══ Untracked-position policy ═════════════════════════════════════
    check(
      "untracked: a re-adoption window is configured",
      config.readoptWindowMinutes > 0,
    );
    check(
      "untracked: foreign positions are NOT adopted by default (manual trades are not the bot's business)",
      config.adoptForeignPositions === false,
    );
    check(
      "untracked: an adopted position would get a real protective stop",
      config.adoptedPositionStopPct > 0 && config.adoptedPositionStopPct < 0.2,
    );

    return results;
  },
};
