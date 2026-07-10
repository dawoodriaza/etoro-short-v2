// src/strategies/cooldown-tracker.js
//
// After ANY exit (win or loss) on a symbol, block re-entry for a cooldown
// window. Prevents whipsaw: a stock that just stopped you out is often still
// choppy, and immediately re-entering on the next scan because a setup
// re-fires is how cooldown-less bots bleed out on a single volatile name.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { logger } = require("../logger");
const config = require("../config");

const cooldownFilePath = path.join(
  __dirname,
  "../../data/trade-cooldowns.json",
);
const dataDir = path.dirname(cooldownFilePath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function loadCooldowns() {
  try {
    if (!fs.existsSync(cooldownFilePath)) return {};
    return JSON.parse(fs.readFileSync(cooldownFilePath, "utf8"));
  } catch {
    return {};
  }
}
function saveCooldowns(cooldowns) {
  try {
    fs.writeFileSync(cooldownFilePath, JSON.stringify(cooldowns, null, 2));
  } catch (saveError) {
    logger.warn("Could not save cooldown tracker: " + saveError.message);
  }
}

// Call this whenever a position is closed (any exit reason).
function startCooldown(symbol) {
  const cooldowns = loadCooldowns();
  cooldowns[symbol.toUpperCase()] = Date.now();
  saveCooldowns(cooldowns);
  logger.info(
    symbol +
      " entering " +
      config.tradeCooldownMinutes +
      "min cooldown after exit",
  );
}

// Returns { onCooldown: bool, minutesRemaining: number }
function checkCooldown(symbol) {
  const cooldowns = loadCooldowns();
  const lastExitTime = cooldowns[symbol.toUpperCase()];
  if (!lastExitTime) return { onCooldown: false, minutesRemaining: 0 };

  const elapsedMinutes = (Date.now() - lastExitTime) / 60000;
  const remaining = config.tradeCooldownMinutes - elapsedMinutes;
  if (remaining <= 0) return { onCooldown: false, minutesRemaining: 0 };
  return { onCooldown: true, minutesRemaining: Math.ceil(remaining) };
}

module.exports = { startCooldown, checkCooldown };
