// v6 capital-manager tests: live-equity reconciliation. Isolates the real
// data/capital-ledger.json for the duration of the test.
//
// NOTE ON CONFIG: this bot routes every module through one shared
// require("../config") singleton, evaluated ONCE (including its
// require("dotenv").config() call) the FIRST time anything requires it in
// the process. Because run-tests.js requires exit-logic-v6.test.js first
// (which requires risk-manager → config), config is already cached with
// whatever .env/defaults resolved at that point — setting process.env.DT_*
// here has NO effect on the already-evaluated config object. Rather than
// fight that (fragile: depends on test file ORDER), this suite reads the
// actual resolved config values and computes its expectations relative to
// THEM — correct regardless of what .env happens to contain or which test
// file loaded config first.
const fs = require("fs");
const path = require("path");

const realLedgerPath = path.join(__dirname, "../data/capital-ledger.json");
const realHaltPath = path.join(__dirname, "../data/halt.flag");
const ledgerBackupPath = realLedgerPath + ".test-backup";

module.exports = {
  name: "capital-manager v6 (live equity reconciliation)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass });

    const config = require("../src/config"); // whatever this resolved to — read, don't assume
    const base = config.dayTradeCapital;
    const floor = base * config.capitalFloorPctOfBase;
    const tolerancePct = config.capitalReconciliationTolerancePct;

    const hadRealLedger = fs.existsSync(realLedgerPath);
    if (hadRealLedger) fs.renameSync(realLedgerPath, ledgerBackupPath);
    const hadRealHalt = fs.existsSync(realHaltPath);

    delete require.cache[require.resolve("../src/strategies/capital-manager")];
    const capitalManager = require("../src/strategies/capital-manager");

    try {
      // Seed: baseCapital, no realized P&L yet → effective = base.
      let state = capitalManager.getCapitalState();
      check(
        "seed state: effectiveCapital starts at baseCapital ($" + base + ")",
        state.effectiveCapital === base,
      );

      // ── Drift WITHIN tolerance: no correction ──
      const withinToleranceEquity = base * (1 + tolerancePct * 0.5); // half the tolerance
      let result = capitalManager.reconcileWithLiveEquity(withinToleranceEquity);
      check(
        "drift within tolerance: not reconciled",
        result.reconciled === false,
      );
      state = capitalManager.getCapitalState();
      check(
        "drift within tolerance: ledger unchanged",
        state.effectiveCapital === base,
      );

      // ── v7.3: a large drift now needs CONFIRMATION across consecutive
      // checks before anything is rewritten. Added after a single bad
      // equity reading (cash reserved for two queued orders) was turned
      // into a $6,596.66 phantom withdrawal. reconcileRepeatedly() drives
      // the confirmation streak the way real scan cycles would.
      const confirmCycles = config.capitalTransferConfirmCycles;
      // Stops at the cycle that actually acts — calling further would start
      // a FRESH streak and return "awaiting" again, masking the result.
      const reconcileRepeatedly = (equity) => {
        let last;
        for (let cycle = 0; cycle < confirmCycles + 2; cycle += 1) {
          last = capitalManager.reconcileWithLiveEquity(equity);
          if (last.reconciled) break;
        }
        return last;
      };

      // A single sighting must NOT act — this is the guard that would have
      // prevented the 2026-07-31 incident.
      const firstSighting = capitalManager.reconcileWithLiveEquity(base * 1.2);
      check(
        "confirmation guard: one large drift sighting does NOT rewrite the ledger",
        firstSighting.reconciled === false &&
          firstSighting.awaitingConfirmation === true,
      );
      check(
        "confirmation guard: capital is untouched while awaiting confirmation",
        Math.abs(capitalManager.getCapitalState().effectiveCapital - base) <
          0.01,
      );

      // ── Drift BEYOND tolerance, CONFIRMED: ledger corrected ──
      const highEquity = base * 1.2; // 20% drift — comfortably beyond any sane tolerance
      result = reconcileRepeatedly(highEquity);
      check(
        "drift beyond tolerance: reconciled=true with the right drift figure",
        result.reconciled === true &&
          Math.abs(result.driftDollars - (highEquity - base)) < 0.01,
      );
      state = capitalManager.getCapitalState();
      check(
        "after reconciliation: effectiveCapital now matches live equity exactly",
        Math.abs(state.effectiveCapital - highEquity) < 0.01,
      );
      check(
        "after reconciliation: peak bumped up to the new high",
        Math.abs(state.peakEffectiveCapital - highEquity) < 0.01,
      );

      // ── Live equity far below the ledger ──
      //
      // SEMANTICS CHANGED IN v7.1. This case used to assert that the ledger
      // clamped at the capital floor and that the peak was never lowered.
      // Both were wrong for the case that actually produces a drop this
      // large in practice: the OWNER withdrawing money.
      //
      // Clamping at a floor derived from the fixed .env base meant sizing
      // against money no longer in the account, and freezing the peak meant
      // a withdrawal read as a catastrophic drawdown — a $3,000 withdrawal
      // from a $9,300 account with a $10,032 peak scored 37% against a 15%
      // limit and halted the bot. A drop beyond DT_CAPITAL_TRANSFER_DETECT_PCT
      // is now classified as an owner transfer: the base moves with it and
      // the peak is rescaled proportionally, which leaves the drawdown
      // PERCENTAGE untouched. See capital-transfer-v7.test.js for the full
      // behaviour, including proof that a transfer cannot hide an existing
      // breach.
      const belowFloorEquity = floor * 0.5; // well under the floor
      result = reconcileRepeatedly(belowFloorEquity);
      check(
        "live equity below the floor: still reconciles (large drift)",
        result.reconciled === true,
      );
      check(
        "live equity far below the ledger: classified as an owner transfer",
        result.treatedAsTransfer === true,
      );
      state = capitalManager.getCapitalState();
      check(
        "owner transfer: effectiveCapital follows the REAL balance, not a stale floor",
        Math.abs(state.effectiveCapital - belowFloorEquity) < 0.01,
      );
      check(
        "owner transfer: the peak is rescaled down so no false drawdown is reported",
        state.peakEffectiveCapital < highEquity,
      );

      // ── Invalid input is a safe no-op ──
      result = capitalManager.reconcileWithLiveEquity(null);
      check("invalid liveEquity input: safe no-op", result.reconciled === false);
      result = capitalManager.reconcileWithLiveEquity(-50);
      check(
        "negative liveEquity input: safe no-op",
        result.reconciled === false,
      );
    } finally {
      if (fs.existsSync(realLedgerPath)) fs.unlinkSync(realLedgerPath);
      if (hadRealLedger) fs.renameSync(ledgerBackupPath, realLedgerPath);
      if (!hadRealHalt && fs.existsSync(realHaltPath)) {
        fs.unlinkSync(realHaltPath);
      }
    }

    return results;
  },
};
