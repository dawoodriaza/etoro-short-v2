// v11.4 tests: the copy account's view, the live "real dollar" ratio, and a
// drawdown breaker that does not count commissions. The real capital ledger
// and halt flag are moved aside for the duration.
const fs = require("fs");
const path = require("path");

const ledgerPath = path.join(__dirname, "../data/capital-ledger.json");
const haltPath = path.join(__dirname, "../data/halt.flag");
const ledgerBackup = ledgerPath + ".test-backup-v11-4";

module.exports = {
  name: "copy view v11.4 (copy value, live ratio, breaker without commissions)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass: !!pass });
    const config = require("../src/config");
    const base = config.dayTradeCapital;
    const copyStart = config.realAccountCapital;

    const hadLedger = fs.existsSync(ledgerPath);
    if (hadLedger) fs.renameSync(ledgerPath, ledgerBackup);
    const hadHalt = fs.existsSync(haltPath);
    const write = (ledger) => fs.writeFileSync(ledgerPath, JSON.stringify({ baseCapital: base, ownerAdjustments: 0, dailyPnl: {}, ...ledger }));
    try {
      delete require.cache[require.resolve("../src/strategies/capital-manager")];
      const capital = require("../src/strategies/capital-manager");

      // the 2026-11-12 situation, scaled to whatever base the config has:
      // portfolio down 10.56%, of which 7.95% is commission
      write({ cumulativeRealizedPnl: -0.1056 * base, peakEffectiveCapital: 1.0033 * base, commissionsUntracked: 0.07 * base, commissionsBooked: 0.0095 * base });
      const view = capital.getCopyView();
      check("commissions = untracked + booked", Math.abs(view.commissions - 0.0795 * base) < 1e-6);
      check("trading equity adds the commissions back", Math.abs(view.tradingEquity - (1 - 0.1056 + 0.0795) * base) < 1e-6);
      check("copy value = copy start × trading equity / base", Math.abs(view.copyEquity - copyStart * (1 - 0.0261)) < 1e-6);
      check("live ratio = copy value / bot portfolio (above the start ratio)",
        Math.abs(view.ratio - view.copyEquity / view.effective) < 1e-12 && view.ratio > copyStart / base);

      const breaker = capital.checkDrawdownBreaker();
      check("breaker measures trading results: 2.9% down, not 10.9%", Math.abs(breaker.drawdownPct - (1.0033 - 0.9739) / 1.0033) < 1e-6);
      check("…so commissions alone do not halt trading", breaker.tripped === false && !fs.existsSync(haltPath) === !hadHalt);

      // a real trading loss past the limit still trips it
      if (!hadHalt) {
        write({ cumulativeRealizedPnl: -(config.maxDrawdownFromPeakPct + 0.02) * base, peakEffectiveCapital: base, commissionsUntracked: 0, commissionsBooked: 0 });
        const tripped = capital.checkDrawdownBreaker();
        check("a real trading drawdown past the limit still trips the breaker", tripped.tripped === true && fs.existsSync(haltPath));
        if (fs.existsSync(haltPath)) fs.unlinkSync(haltPath);
      }

      // the money formatter follows the live ratio once a provider is set
      const fmt = require("../src/notifications/format-helpers");
      fmt.setCopyRatioProvider(null);
      const before = fmt.toRealDollars(1000);
      fmt.setCopyRatioProvider(() => 0.04);
      check("real-dollar conversion uses the live ratio", Math.abs(fmt.toRealDollars(1000) - 40) < 1e-9 && Math.abs(before - (1000 * copyStart) / base) < 1e-9);
      fmt.setCopyRatioProvider(() => { throw new Error("x"); });
      check("…and falls back to the start ratio if the provider fails", Math.abs(fmt.toRealDollars(1000) - (1000 * copyStart) / base) < 1e-9);
      fmt.setCopyRatioProvider(null);
    } finally {
      if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
      if (hadLedger) fs.renameSync(ledgerBackup, ledgerPath);
      if (!hadHalt && fs.existsSync(haltPath)) fs.unlinkSync(haltPath);
      delete require.cache[require.resolve("../src/strategies/capital-manager")];
    }
    return results;
  },
};
