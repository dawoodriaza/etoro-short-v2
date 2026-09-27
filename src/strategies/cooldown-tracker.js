// src/strategies/cooldown-tracker.js
//
// After ANY exit (win or loss) on a symbol, block re-entry for a cooldown
// window. Prevents whipsaw: a stock that just stopped you out is often still
// choppy, and immediately re-entering on the next scan because a setup
// re-fires is how cooldown-less bots bleed out on a single volatile name.
//
// v6 (2026-07-21, review-driven upgrade) — LOSS-AWARE COOLDOWN + RE-ENTRY
// JUSTIFICATION. This bot never pyramids (no scale-in on an open position —
// held symbols are always excluded from new candidates), so "averaging
// down without justification" in practice means RE-ENTERING a symbol
// shortly after it closed for a LOSS. Two changes:
//   1. A loss-close now gets a LONGER cooldown than a normal exit
//      (config.lossCooldownMultiplier × the base window).
//   2. Even after that window expires, re-entry into a symbol that just
//      lost requires a MEANINGFULLY STRONGER setup than the one that lost
//      (score improvement of config.lossReentryMinScoreImprovement) — "the
//      setup re-fired" alone is not justification to re-buy a stock that
//      just cost money. getReentryJustification() exposes this for the
//      caller to check once the new candidate's score is actually computed
//      (scoring happens after the cheap pre-filter stage this module's
//      other function is called from, so it can't be checked in one step).
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

// Normalizes a stored record — older entries are a bare epoch-ms number
// (pre-v6 format); newer ones are { exitAtMs, wasLoss, scoreAtExit }.
function normalizeRecord(record) {
  if (record == null) return null;
  if (typeof record === "number") {
    return { exitAtMs: record, wasLoss: false, scoreAtExit: null };
  }
  return record;
}

// Call this whenever a position is closed (any exit reason).
// exitInfo: { wasLoss: bool, scoreAtExit: number|null }
function startCooldown(symbol, exitInfo = {}) {
  const cooldowns = loadCooldowns();
  const wasLoss = !!exitInfo.wasLoss;
  const scoreAtExit =
    typeof exitInfo.scoreAtExit === "number" ? exitInfo.scoreAtExit : null;
  cooldowns[symbol.toUpperCase()] = {
    exitAtMs: Date.now(),
    wasLoss,
    scoreAtExit,
  };
  saveCooldowns(cooldowns);

  const cooldownMinutes = wasLoss
    ? config.tradeCooldownMinutes * config.lossCooldownMultiplier
    : config.tradeCooldownMinutes;
  logger.info(
    symbol +
      " entering " +
      cooldownMinutes +
      "min cooldown after " +
      (wasLoss ? "a LOSING" : "an") +
      " exit" +
      (wasLoss
        ? " (×" +
          config.lossCooldownMultiplier +
          " loss multiplier; re-entry after cooldown still needs a score " +
          config.lossReentryMinScoreImprovement +
          "+ points stronger than the setup that lost" +
          (scoreAtExit != null ? " — was " + scoreAtExit.toFixed(0) : "") +
          ")"
        : ""),
  );
}

// Returns { onCooldown: bool, minutesRemaining: number }
function checkCooldown(symbol) {
  const cooldowns = loadCooldowns();
  const record = normalizeRecord(cooldowns[symbol.toUpperCase()]);
  if (!record) return { onCooldown: false, minutesRemaining: 0 };

  const cooldownMinutes = record.wasLoss
    ? config.tradeCooldownMinutes * config.lossCooldownMultiplier
    : config.tradeCooldownMinutes;
  const elapsedMinutes = (Date.now() - record.exitAtMs) / 60000;
  const remaining = cooldownMinutes - elapsedMinutes;
  // v8.5: minutesSinceExit lets the untracked-position check recognise a
  // position the bot itself closed moments ago (eToro still lists it briefly).
  if (remaining <= 0) return { onCooldown: false, minutesRemaining: 0, minutesSinceExit: elapsedMinutes };
  return { onCooldown: true, minutesRemaining: Math.ceil(remaining), minutesSinceExit: elapsedMinutes };
}

// v6: after the raw cooldown window expires, does re-entering this symbol
// require a stronger setup than the one that just lost? Returns
// { requiresJustification, minScore, priorScore }. The caller compares its
// NEW candidate's score (available only after scoring, further down the
// pipeline than checkCooldown() is called from) against minScore.
function getReentryJustification(symbol) {
  const cooldowns = loadCooldowns();
  const record = normalizeRecord(cooldowns[symbol.toUpperCase()]);
  if (!record || !record.wasLoss || record.scoreAtExit == null) {
    return { requiresJustification: false };
  }

  // ══════════════════════════════════════════════════════════════════════
  // v7.12 FIX — THE SCORE PENALTY EXPIRES.
  //
  // checkCooldown() above expires the TIME window off `exitAtMs`, but this
  // function never read that field, so the SCORE half of the penalty was
  // permanent. Nothing in the design intended that; the comment above only
  // says the bar outlives the cooldown window, not that it lasts forever.
  //
  // Live measurement (2026-09-01) of what that cost: 26 symbols carrying a
  // penalty, 24 requiring a score of 90 after the clamp, from losses up to
  // 41 days old — AAPL 39d, CRWV/DELL 41d, MSFT/AVGO 33d. The entire
  // watchlist topped out at 87 that session, so every one of them was
  // unbuyable. Roughly half the watchlist had been silently retired,
  // including the mega-cap bucket that was the ONLY profitable one in the
  // forensic audit (68% win, +$202.99).
  //
  // The July clamp fixed "mathematically impossible" (>100). This fixes
  // "permanent", which was the other half of the same bug.
  // ══════════════════════════════════════════════════════════════════════
  const expiryMs = config.reentryPenaltyExpiryHours * 60 * 60 * 1000;
  if (
    expiryMs > 0 &&
    typeof record.exitAtMs === "number" &&
    Date.now() - record.exitAtMs > expiryMs
  ) {
    return { requiresJustification: false, expired: true };
  }

  // ══════════════════════════════════════════════════════════════════════
  // P1 FIX (2026-07-27) — PERMANENT LOCKOUT ABOVE SCORE 85.
  //
  // momentum-scanner caps every score at 100 (Math.min(100, ...)). So
  // demanding priorScore + 15 quietly becomes UNREACHABLE the moment a
  // symbol loses with a score above 85 — the required score exceeds the
  // maximum obtainable one and the symbol is banned forever, silently.
  //
  // Observed live 2026-07-27: AMD lost at score 88, needed 103, and was
  // rejected 13 times in three hours at scores from 20 to 81. It could
  // never have passed. MRVL (prior 52) and ANET (prior 64) were fine;
  // only the high scorers were affected — i.e. the bot was permanently
  // banning precisely the names whose setups it rated most highly.
  //
  // The intent — "come back with a meaningfully better setup" — is kept,
  // but the bar is clamped to something actually achievable.
  // ══════════════════════════════════════════════════════════════════════
  const rawMinScore =
    record.scoreAtExit + config.lossReentryMinScoreImprovement;
  const minScore = Math.min(rawMinScore, config.reentryMaxRequiredScore);
  const wasClamped = minScore < rawMinScore;

  if (wasClamped) {
    logger.info(
      symbol +
        " re-entry bar clamped: " +
        record.scoreAtExit.toFixed(0) +
        " + " +
        config.lossReentryMinScoreImprovement +
        " = " +
        rawMinScore.toFixed(0) +
        " exceeds the reachable maximum, so the bar is " +
        minScore +
        " (scores are capped at 100 — without this the symbol could never re-enter)",
    );
  }

  return {
    requiresJustification: true,
    minScore,
    priorScore: record.scoreAtExit,
    wasClamped,
  };
}

module.exports = { startCooldown, checkCooldown, getReentryJustification };
