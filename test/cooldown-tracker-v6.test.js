// v6 cooldown-tracker tests: loss-aware cooldown duration + re-entry
// justification. Isolates the real data/trade-cooldowns.json file for the
// duration of the test (same pattern as the sibling long-term bot's
// shock-detector test).
process.env.DT_TRADE_COOLDOWN_MINUTES = "30";
process.env.DT_LOSS_COOLDOWN_MULTIPLIER = "2.0";
process.env.DT_LOSS_REENTRY_MIN_SCORE_IMPROVEMENT = "15";

const fs = require("fs");
const path = require("path");

const realPath = path.join(__dirname, "../data/trade-cooldowns.json");
const backupPath = realPath + ".test-backup";

module.exports = {
  name: "cooldown-tracker v6 (loss-aware cooldown + re-entry justification)",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass });

    const hadRealFile = fs.existsSync(realPath);
    if (hadRealFile) fs.renameSync(realPath, backupPath);
    delete require.cache[require.resolve("../src/strategies/cooldown-tracker")];
    const cooldownTracker = require("../src/strategies/cooldown-tracker");

    try {
      // ── Non-loss exit: normal 30min cooldown ──
      cooldownTracker.startCooldown("AAA", { wasLoss: false, scoreAtExit: 60 });
      let status = cooldownTracker.checkCooldown("AAA");
      check(
        "non-loss exit: on cooldown with the BASE window",
        status.onCooldown === true && status.minutesRemaining <= 30,
      );
      let justification = cooldownTracker.getReentryJustification("AAA");
      check(
        "non-loss exit: no re-entry justification required",
        justification.requiresJustification === false,
      );

      // ── Loss exit: cooldown duration is MULTIPLIED ──
      cooldownTracker.startCooldown("BBB", { wasLoss: true, scoreAtExit: 60 });
      status = cooldownTracker.checkCooldown("BBB");
      check(
        "loss exit: cooldown remaining reflects the ×2 multiplier (~60min, not ~30min)",
        status.onCooldown === true && status.minutesRemaining > 30,
      );

      // ── Loss exit: re-entry needs a meaningfully stronger score ──
      justification = cooldownTracker.getReentryJustification("BBB");
      check(
        "loss exit: requires justification, minScore = priorScore + improvement",
        justification.requiresJustification === true &&
          justification.priorScore === 60 &&
          justification.minScore === 75,
      );

      // ── No record at all: never blocks ──
      status = cooldownTracker.checkCooldown("CCC");
      check(
        "unknown symbol: not on cooldown",
        status.onCooldown === false,
      );
      justification = cooldownTracker.getReentryJustification("CCC");
      check(
        "unknown symbol: no justification required",
        justification.requiresJustification === false,
      );

      // ── Backward-compat: an old bare-number record (pre-v6 format)
      // must still work and default to "not a loss" ──
      const cooldowns = JSON.parse(fs.readFileSync(realPath, "utf8"));
      cooldowns["DDD"] = Date.now(); // legacy format
      fs.writeFileSync(realPath, JSON.stringify(cooldowns, null, 2));
      status = cooldownTracker.checkCooldown("DDD");
      check(
        "legacy bare-timestamp record: still parses, uses base cooldown",
        status.onCooldown === true && status.minutesRemaining <= 30,
      );
      justification = cooldownTracker.getReentryJustification("DDD");
      check(
        "legacy record: treated as non-loss, no justification required",
        justification.requiresJustification === false,
      );
    } finally {
      if (fs.existsSync(realPath)) fs.unlinkSync(realPath);
      if (hadRealFile) fs.renameSync(backupPath, realPath);
    }

    return results;
  },
};
