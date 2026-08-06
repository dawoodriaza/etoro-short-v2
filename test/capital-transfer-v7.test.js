// v7.1 owner deposit/withdrawal tests. Isolates the real
// data/capital-ledger.json for the duration of the suite.
//
// The scenario that motivated this: withdrawing $3,000 from a ~$9,300
// account whose peak was $10,032 read as a 37% drawdown against a 15%
// limit — halt.flag written, all new entries stopped. And withdrawing far
// enough left the capital floor sizing against money no longer present.
//
// NOTE ON CONFIG: reads the RESOLVED config rather than assuming its own
// process.env.DT_* overrides applied — config is a shared singleton.
const fs = require("fs");
const path = require("path");

const realLedgerPath = path.join(__dirname, "../data/capital-ledger.json");
const ledgerBackupPath = realLedgerPath + ".transfer-test-backup";

module.exports = {
  name: "capital transfers v7.1 (owner deposits & withdrawals)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass });

    const config = require("../src/config");
    const base = config.dayTradeCapital;
    const floorPct = config.capitalFloorPctOfBase;

    const hadRealLedger = fs.existsSync(realLedgerPath);
    if (hadRealLedger) fs.renameSync(realLedgerPath, ledgerBackupPath);

    delete require.cache[require.resolve("../src/strategies/capital-manager")];
    const capitalManager = require("../src/strategies/capital-manager");

    const writeLedger = (ledger) => {
      fs.mkdirSync(path.dirname(realLedgerPath), { recursive: true });
      fs.writeFileSync(realLedgerPath, JSON.stringify(ledger, null, 2));
    };

    try {
      // ── A withdrawal must not read as a drawdown ────────────────────
      // Recreate the real shape: some trading losses, a peak above the
      // current equity, then the owner takes money out.
      writeLedger({
        baseCapital: base,
        ownerAdjustments: 0,
        cumulativeRealizedPnl: -base * 0.05, // down 5% from trading
        peakEffectiveCapital: base,
        dailyPnl: { "2026-07-21": -base * 0.05 },
      });

      const before = capitalManager.getCapitalState();
      const drawdownBefore =
        (before.peakEffectiveCapital - before.effectiveCapital) /
        before.peakEffectiveCapital;

      const withdrawal = -before.effectiveCapital * 0.35; // take out 35%
      const transfer = capitalManager.applyCapitalTransfer(
        withdrawal,
        "test withdrawal",
      );
      const after = capitalManager.getCapitalState();
      const drawdownAfter =
        (after.peakEffectiveCapital - after.effectiveCapital) /
        after.peakEffectiveCapital;

      check("withdrawal: applied successfully", transfer.applied === true);
      check(
        "withdrawal: effective capital drops by the withdrawn amount",
        Math.abs(
          after.effectiveCapital - (before.effectiveCapital + withdrawal),
        ) < 0.05,
      );
      check(
        "withdrawal: the drawdown PERCENTAGE is unchanged (a transfer is not a loss)",
        Math.abs(drawdownAfter - drawdownBefore) < 0.0001,
      );
      check(
        "withdrawal: the peak is rescaled DOWN, not left frozen",
        after.peakEffectiveCapital < before.peakEffectiveCapital,
      );
      check(
        "withdrawal: does NOT trip the drawdown breaker",
        capitalManager.checkDrawdownBreaker().tripped === false,
      );
      check(
        "withdrawal: is not recorded as trading P&L (no false losing day)",
        after.cumulativeRealizedPnl === before.cumulativeRealizedPnl,
      );
      check(
        "withdrawal: ownerAdjustments records the net transfer",
        Math.abs(after.ownerAdjustments - withdrawal) < 0.05,
      );
      check(
        "withdrawal: the capital base shrinks with it",
        after.effectiveBase < before.effectiveBase,
      );

      // ── The capital floor must scale with withdrawals ───────────────
      // Previously the floor was baseCapital(.env) × pct, so a large
      // withdrawal left the bot sizing against money that was gone.
      writeLedger({
        baseCapital: base,
        ownerAdjustments: 0,
        cumulativeRealizedPnl: 0,
        peakEffectiveCapital: base,
        dailyPnl: {},
      });
      const bigWithdrawal = -base * 0.8; // take out 80%
      capitalManager.applyCapitalTransfer(bigWithdrawal, "large test withdrawal");
      const afterBig = capitalManager.getCapitalState();
      const oldStyleFloor = base * floorPct; // what the floor used to be

      check(
        "floor: after an 80% withdrawal, capital is NOT clamped at the old .env-based floor",
        afterBig.effectiveCapital < oldStyleFloor,
      );
      check(
        "floor: effective capital tracks the real remaining balance",
        Math.abs(afterBig.effectiveCapital - base * 0.2) < 0.05,
      );

      // ── The floor MUST still protect against real trading losses ────
      // Scaling the floor with withdrawals must not weaken it against the
      // thing it was built for: the ledger bleeding out through losses.
      writeLedger({
        baseCapital: base,
        ownerAdjustments: 0,
        cumulativeRealizedPnl: 0,
        peakEffectiveCapital: base,
        dailyPnl: {},
      });
      capitalManager.recordRealizedPnl(-base * 0.95); // catastrophic losses
      const afterLosses = capitalManager.getCapitalState();
      check(
        "floor: catastrophic TRADING losses are still clamped at the floor",
        Math.abs(afterLosses.effectiveCapital - base * floorPct) < 0.05,
      );
      check(
        "floor: losses do NOT move the capital base (only transfers do)",
        afterLosses.effectiveBase === base &&
          afterLosses.ownerAdjustments === 0,
      );

      // ── Deposits work symmetrically ─────────────────────────────────
      writeLedger({
        baseCapital: base,
        ownerAdjustments: 0,
        cumulativeRealizedPnl: 0,
        peakEffectiveCapital: base,
        dailyPnl: {},
      });
      const beforeDeposit = capitalManager.getCapitalState();
      capitalManager.applyCapitalTransfer(base * 0.5, "test deposit");
      const afterDeposit = capitalManager.getCapitalState();
      check(
        "deposit: effective capital rises by the deposited amount",
        Math.abs(afterDeposit.effectiveCapital - base * 1.5) < 0.05,
      );
      check(
        "deposit: the peak scales up too, so a deposit is not free headroom",
        afterDeposit.peakEffectiveCapital > beforeDeposit.peakEffectiveCapital,
      );

      // ── A transfer must never HIDE an existing breach ───────────────
      // Proportional scaling preserves the drawdown %, so a book already
      // past the limit stays past it after a withdrawal.
      const breachPct = config.maxDrawdownFromPeakPct + 0.1;
      writeLedger({
        baseCapital: base,
        ownerAdjustments: 0,
        cumulativeRealizedPnl: -base * breachPct,
        peakEffectiveCapital: base,
        dailyPnl: {},
      });
      const breachedBefore = capitalManager.checkDrawdownBreaker();
      // Clear any halt the check just wrote, so we test the AFTER state cleanly.
      const haltPath = path.join(__dirname, "../data/halt.flag");
      if (fs.existsSync(haltPath)) fs.unlinkSync(haltPath);

      capitalManager.applyCapitalTransfer(-base * 0.2, "withdraw while underwater");
      const breachedAfter = capitalManager.checkDrawdownBreaker();
      check(
        "safety: a book already past the drawdown limit was breaching before the transfer",
        breachedBefore.drawdownPct >= config.maxDrawdownFromPeakPct,
      );
      check(
        "safety: it is STILL breaching after a withdrawal — a transfer cannot disarm the breaker",
        breachedAfter.drawdownPct >= config.maxDrawdownFromPeakPct,
      );
      if (fs.existsSync(haltPath)) fs.unlinkSync(haltPath);

      // ── Auto-detection via live equity ──────────────────────────────
      writeLedger({
        baseCapital: base,
        ownerAdjustments: 0,
        cumulativeRealizedPnl: 0,
        peakEffectiveCapital: base,
        dailyPnl: {},
      });
      // A drift well past capitalTransferDetectPct = treated as a transfer.
      const liveAfterWithdrawal = base * 0.6; // 40% gone
      // v7.3: a large drift must now persist across consecutive checks
      // before it is acted on, so drive the confirmation streak.
      const confirmCycles = config.capitalTransferConfirmCycles;
      let autoResult;
      for (let cycle = 0; cycle < confirmCycles + 2; cycle += 1) {
        autoResult = capitalManager.reconcileWithLiveEquity(liveAfterWithdrawal);
        if (autoResult.reconciled) break; // further calls start a fresh streak
      }
      const autoState = capitalManager.getCapitalState();
      check(
        "auto-detect: a large equity drop is classified as a transfer",
        autoResult.reconciled === true &&
          autoResult.treatedAsTransfer === true,
      );
      check(
        "auto-detect: effective capital matches the real live equity",
        Math.abs(autoState.effectiveCapital - liveAfterWithdrawal) < 0.05,
      );
      check(
        "auto-detect: the peak was rescaled, so no false drawdown",
        autoState.peakEffectiveCapital < base &&
          capitalManager.checkDrawdownBreaker().tripped === false,
      );

      // A SMALL drift stays on the old conservative path (likely a ghost
      // close, not a deliberate transfer) — peak must NOT be lowered.
      writeLedger({
        baseCapital: base,
        ownerAdjustments: 0,
        cumulativeRealizedPnl: 0,
        peakEffectiveCapital: base,
        dailyPnl: {},
      });
      const smallDriftEquity =
        base *
        (1 -
          (config.capitalReconciliationTolerancePct +
            config.capitalTransferDetectPct) /
            2); // between the two thresholds
      // A sub-threshold drift never enters the transfer path, so it needs no
      // confirmation streak — it corrects the ledger on the first call.
      const smallResult =
        capitalManager.reconcileWithLiveEquity(smallDriftEquity);
      check(
        "auto-detect: a SMALL unexplained drift is not treated as a transfer",
        smallResult.reconciled === true &&
          smallResult.treatedAsTransfer === false,
      );
      check(
        "auto-detect: a small drift never lowers the peak (conservative)",
        capitalManager.getCapitalState().peakEffectiveCapital >= base,
      );

      // ══ THE 2026-07-31 PHANTOM-WITHDRAWAL INCIDENT ═══════════════════
      // Exact live numbers: raw credit $8,274.24, two queued orders
      // reserving $6,550, one open position of $1,120, unrealized -$79.90.
      // Equity USED to be computed as (credit - pending + invested +
      // unrealized) = $2,764.34 instead of the true $9,314.34, and the
      // auto-detector turned the $6,596.66 gap into a "withdrawal".
      const etoroClient = require("../src/etoro-client");
      const incidentRaw = {
        clientPortfolio: {
          credit: 8274.24,
          positions: [
            {
              positionID: 1,
              instrumentID: 9287,
              amount: 1120,
              openRate: 16.4,
              isBuy: true,
              leverage: 1,
              unrealizedPnL: { pnL: -79.9 },
            },
          ],
          ordersForOpen: [
            { orderID: 1, instrumentID: 6434, amount: 3275, mirrorID: 0 },
            { orderID: 2, instrumentID: 1003, amount: 3275, mirrorID: 0 },
          ],
          orders: [],
        },
      };
      const incidentPortfolio =
        etoroClient.parsePortfolioFromRawData(incidentRaw);

      check(
        "incident: equity now INCLUDES cash reserved for pending orders ($9,314.34)",
        Math.abs(incidentPortfolio.totalEquity - 9314.34) < 0.01,
      );
      check(
        "incident: equity is NOT the old phantom $2,764.34",
        Math.abs(incidentPortfolio.totalEquity - 2764.34) > 1000,
      );
      check(
        "incident: availableCash still EXCLUDES reserved cash (affordability is a different question)",
        Math.abs(incidentPortfolio.availableCash - 1724.24) < 0.01,
      );
      check(
        "incident: the two queued orders are visible as pending",
        incidentPortfolio.pendingOrderCount === 2,
      );

      // Even if some other artefact produced a big drift, pending orders
      // must block the transfer path outright.
      writeLedger({
        baseCapital: base,
        ownerAdjustments: 0,
        cumulativeRealizedPnl: 0,
        peakEffectiveCapital: base,
        dailyPnl: {},
      });
      let blocked;
      for (let cycle = 0; cycle < confirmCycles + 2; cycle += 1) {
        blocked = capitalManager.reconcileWithLiveEquity(base * 0.3, {
          pendingOrderCount: 2,
        });
      }
      check(
        "incident guard: a huge drift is REFUSED while orders are pending",
        blocked.reconciled === false && blocked.blockedByPending === true,
      );
      check(
        "incident guard: the capital base is left completely untouched",
        Math.abs(capitalManager.getCapitalState().effectiveCapital - base) <
          0.01,
      );
      check(
        "incident guard: the drawdown peak is left untouched",
        Math.abs(capitalManager.getCapitalState().peakEffectiveCapital - base) <
          0.01,
      );

      // A transient one-off drift that then recovers must never act.
      writeLedger({
        baseCapital: base,
        ownerAdjustments: 0,
        cumulativeRealizedPnl: 0,
        peakEffectiveCapital: base,
        dailyPnl: {},
      });
      capitalManager.reconcileWithLiveEquity(base * 0.3); // one bad reading
      capitalManager.reconcileWithLiveEquity(base); // recovers
      capitalManager.reconcileWithLiveEquity(base); // stays healthy
      check(
        "incident guard: a single bad reading that recovers never rewrites capital",
        Math.abs(capitalManager.getCapitalState().effectiveCapital - base) <
          0.01,
      );

      // ── Guards ──────────────────────────────────────────────────────
      check(
        "guard: a zero transfer is rejected",
        capitalManager.applyCapitalTransfer(0, "noop").applied === false,
      );
      check(
        "guard: a non-numeric transfer is rejected",
        capitalManager.applyCapitalTransfer("lots", "bad").applied === false,
      );

      // ── Legacy ledgers migrate cleanly ──────────────────────────────
      writeLedger({
        baseCapital: base,
        cumulativeRealizedPnl: -100,
        peakEffectiveCapital: base,
        dailyPnl: {},
      }); // no ownerAdjustments field at all
      const migrated = capitalManager.getCapitalState();
      check(
        "migration: a pre-v7.1 ledger with no ownerAdjustments reads as 0",
        migrated.ownerAdjustments === 0 &&
          migrated.effectiveBase === base &&
          Math.abs(migrated.effectiveCapital - (base - 100)) < 0.05,
      );
    } finally {
      try {
        if (fs.existsSync(realLedgerPath)) fs.unlinkSync(realLedgerPath);
        if (hadRealLedger) fs.renameSync(ledgerBackupPath, realLedgerPath);
        const haltPath = path.join(__dirname, "../data/halt.flag");
        if (fs.existsSync(haltPath)) fs.unlinkSync(haltPath);
      } catch {
        /* best effort */
      }
    }

    return results;
  },
};
