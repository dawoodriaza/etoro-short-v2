// v10.2 (Phase 1) tests: broker-side safety stop on orders, the per-order
// commission, eToro trade-history matching, and the rates timeout retry.
// No network: axios is stubbed for every eToro call, and the real capital
// ledger is moved aside for the duration (same pattern as the v6 suite).
const fs = require("fs");
const path = require("path");

const realLedgerPath = path.join(__dirname, "../data/capital-ledger.json");
const ledgerBackupPath = realLedgerPath + ".test-backup-v10-2";

module.exports = {
  name: "phase 1 v10.2 (broker stop, commission, eToro trade history)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass: !!pass });
    const config = require("../src/config");
    const axios = require("axios");

    // ── broker stop price ──────────────────────────────────────────────
    const planner = require("../src/strategies/trade-planner");
    const stop = planner.computeBrokerStopRate({ entryPrice: 100, stopPrice: 98 }, 1.5);
    check("broker stop = entry − 1.5 × stop distance (100/98 → 97)", stop === 97);
    check(
      "broker stop rounds DOWN, never closer (100/98.333 → 97.49)",
      planner.computeBrokerStopRate({ entryPrice: 100, stopPrice: 98.333 }, 1.5) === 97.49,
    );
    check(
      "sub-$1 stock keeps 4 decimals",
      planner.computeBrokerStopRate({ entryPrice: 0.5, stopPrice: 0.48 }, 1.5) === 0.47,
    );
    check("no stop when the plan stop is missing", planner.computeBrokerStopRate({ entryPrice: 100 }) === null);
    check(
      "no stop when the plan stop is above the entry",
      planner.computeBrokerStopRate({ entryPrice: 100, stopPrice: 101 }) === null,
    );
    check("defaults: enabled, 1.5×", config.brokerStopEnabled === true && config.brokerStopDistanceMultiplier === 1.5);

    // ── order body + rejection fallback (axios stubbed) ────────────────
    const client = require("../src/etoro-client");
    const originalPost = axios.post;
    const savedMode = process.env.TRADING_MODE;
    process.env.TRADING_MODE = "live";
    const bodies = [];
    try {
      axios.post = async (url, body) => {
        bodies.push(body);
        return { data: { orderForOpen: { orderID: 1 }, token: "t" } };
      };
      await client.openBuyPosition(1137, 1500, "NVDA", { stopLossRate: 205.1 });
      check("order carries StopLossRate", bodies[0].StopLossRate === 205.1 && bodies[0].IsNoStopLoss === false);
      check("order is still a plain unleveraged buy", bodies[0].IsBuy === true && bodies[0].Leverage === 1 && bodies[0].Amount === 1500);

      bodies.length = 0;
      await client.openBuyPosition(1137, 1500, "NVDA");
      check("no stop option → no StopLossRate field (old behaviour)", !("StopLossRate" in bodies[0]));

      bodies.length = 0;
      axios.post = async (url, body) => {
        bodies.push(body);
        if (body.StopLossRate) {
          const error = new Error("Request failed with status code 400");
          error.response = { status: 400, data: { errorCode: "InvalidStopLoss" } };
          throw error;
        }
        return { data: { orderForOpen: { orderID: 2 }, token: "t" } };
      };
      const fallback = await client.openBuyPosition(1137, 1500, "NVDA", { stopLossRate: 205.1 });
      check("a 400 with the stop is NOT retried with the same body", bodies.filter((b) => b.StopLossRate).length === 1);
      check("…the order is placed once more without the stop", bodies.length === 2 && !("StopLossRate" in bodies[1]));
      check("…and the result is flagged so the caller alerts", !!fallback.brokerStopRejected && fallback.orderForOpen.orderID === 2);
    } finally {
      axios.post = originalPost;
      if (savedMode === undefined) delete process.env.TRADING_MODE;
      else process.env.TRADING_MODE = savedMode;
    }

    // ── commission per order ───────────────────────────────────────────
    const perf = require("../src/strategies/performance-tracker");
    check("commission default is $1 per order", config.commissionPerOrderDollars === 1);
    check("commission: open + close = 2 orders", perf.commissionForTrade([]) === 2);
    check("commission: one partial adds an order", perf.commissionForTrade([{}]) === 3);
    const record = perf.buildClosedTradeRecord({
      symbol: "NVDA",
      positionMeta: { entryPrice: 100, dollarAmount: 1000, realizedPartialPnl: 5, partialFills: [{}] },
      livePosition: { positionId: 42, unrealizedProfitLoss: 10, unrealizedProfitLossPercent: 0.01, openPrice: 100 },
      exitReason: "TEST",
      heldMinutes: 5,
    });
    check("record keeps pnlDollars as the market result (stats unchanged)", record.pnlDollars === 15);
    check("record carries commission, net and eToro positionId", record.commissionDollars === 3 && record.netPnlDollars === 12 && record.positionId === 42);
    check(
      "pre-v10.2 record: net = best-known − estimated commission",
      perf.tradeNetDollars({ pnlDollars: 10, pnlAccountingVersion: 2, partialFills: [] }) === 8,
    );

    const hadLedger = fs.existsSync(realLedgerPath);
    if (hadLedger) fs.renameSync(realLedgerPath, ledgerBackupPath);
    try {
      delete require.cache[require.resolve("../src/strategies/capital-manager")];
      const capital = require("../src/strategies/capital-manager");
      const before = Number(capital.getCapitalState().effectiveCapital);
      capital.recordCommission(1);
      capital.recordCommission(2);
      const after = Number(capital.getCapitalState().effectiveCapital);
      const ledger = JSON.parse(fs.readFileSync(realLedgerPath, "utf8"));
      check("recordCommission lowers capital by $1 per order", Math.abs(before - after - 3) < 1e-9);
      check("…and tallies commissionsBooked", ledger.commissionsBooked === 3);
    } finally {
      if (fs.existsSync(realLedgerPath)) fs.unlinkSync(realLedgerPath);
      if (hadLedger) fs.renameSync(ledgerBackupPath, realLedgerPath);
      delete require.cache[require.resolve("../src/strategies/capital-manager")];
    }
    check("reconciliation tolerance tightened to 0.3%", config.capitalReconciliationTolerancePct === 0.003);

    // ── eToro trade-history matching ───────────────────────────────────
    const rows = [
      // a position closed in two pieces (partial + final): same open time/rate
      { positionId: 11, instrumentId: 1137, openTimestamp: "2026-10-26T14:12:02Z", openRate: 214.55, closeTimestamp: "2026-10-26T15:00:00Z", closeRate: 216, netProfit: 4 },
      { positionId: 12, instrumentId: 1137, openTimestamp: "2026-10-26T14:12:02Z", openRate: 214.55, closeTimestamp: "2026-10-26T16:10:00Z", closeRate: 215.46, netProfit: 2.23 },
      // a different stock opened at the same minute — must not be matched to NVDA
      { positionId: 13, instrumentId: 1001, openTimestamp: "2026-10-26T14:13:00Z", openRate: 50, closeTimestamp: "2026-10-26T15:00:00Z", closeRate: 51, netProfit: 9 },
      // an old position the bot has no record of
      { positionId: 14, instrumentId: 9255, openTimestamp: "2026-07-13T11:50:20Z", openRate: 19.3, closeTimestamp: "2026-07-13T13:21:02Z", closeRate: 19.14, netProfit: -0.58 },
    ];
    const history = [{ symbol: "NVDA", openedAt: "2026-10-26T14:12:06Z", entryPrice: 214.55, pnlDollars: 12.4, pnlAccountingVersion: 2 }];
    const { history: matched, summary } = perf.attachBrokerResults(history, rows);
    check("partial pieces are summed into one position", matched[0].brokerNetProfit === 6.23 && matched[0].brokerPieces === 2);
    check("close rate is the LAST piece's", matched[0].brokerCloseRate === 215.46);
    check("a different stock at the same minute is not matched (3% price check)", summary.matchedRecords === 1);
    check("orders = positions + closed pieces (3 + 4 = 7)", summary.brokerPositions === 3 && summary.brokerOrders === 7);
    check("unmatched eToro positions are reported", summary.unmatchedBrokerPositions === 2);
    const byId = perf.attachBrokerResults([{ symbol: "X", positionId: 13, openedAt: "2026-01-01T00:00:00Z", entryPrice: 1 }], rows);
    check("positionId match wins even when times differ", byId.history[0].brokerNetProfit === 9);

    // ── rates: one retry on a timeout only ─────────────────────────────
    const md = require("../src/data-sources/etoro-market-data");
    const originalGet = axios.get;
    let calls = 0;
    try {
      axios.get = async () => {
        calls++;
        if (calls === 1) {
          const error = new Error("timeout of 12000ms exceeded");
          error.code = "ECONNABORTED";
          throw error;
        }
        return { data: { rates: [{ instrumentID: 1137, ask: 1, bid: 0.9, date: "x" }] } };
      };
      const rates = await md.fetchBatchedRates([1137]);
      check("rates: a timeout is retried once and succeeds", calls === 2 && rates[1137].ask === 1);
      calls = 0;
      axios.get = async () => {
        calls++;
        const error = new Error("Request failed with status code 429");
        error.response = { status: 429 };
        throw error;
      };
      let threw = false;
      try { await md.fetchBatchedRates([1137]); } catch { threw = true; }
      check("rates: a non-timeout error is NOT retried", threw && calls === 1);
    } finally {
      axios.get = originalGet;
    }

    return results;
  },
};
