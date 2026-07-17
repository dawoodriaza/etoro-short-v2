// src/strategies/exit-shadow-tracker.js
//
// OBSERVATION ONLY — never re-enters, never affects trading. After a
// TIME_EXIT_STALE / SWING_TIME_EXIT exit (the bot gave up on time, not
// because price proved it wrong), this watches what the price actually
// does afterward at fixed checkpoints and journals it. That turns "should
// DT_MAX_HOLD_MINUTES be longer?" from a guess into evidence: after enough
// stale exits accumulate checkpoints, the journal will show how many would
// have reached Target 1 (or the stop) if the bot had waited longer.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { logger } = require("../logger");
const journal = require("./decision-journal");
const etoroMarketData = require("../data-sources/etoro-market-data");

const shadowFilePath = path.join(
  __dirname,
  "../../data/exit-shadows.json",
);

const CHECKPOINT_MINUTES = [30, 60, 120];

function loadShadows() {
  try {
    if (!fs.existsSync(shadowFilePath)) return [];
    return JSON.parse(fs.readFileSync(shadowFilePath, "utf8"));
  } catch {
    return [];
  }
}

function saveShadows(shadows) {
  try {
    const directory = path.dirname(shadowFilePath);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(shadowFilePath, JSON.stringify(shadows, null, 2));
  } catch (saveError) {
    logger.warn("Could not save exit-shadow tracker: " + saveError.message);
  }
}

// Call right after a TIME_EXIT_STALE / SWING_TIME_EXIT exit, BEFORE the
// position meta is deleted (needs its stop/target levels).
function startShadow(symbol, instrumentId, positionMeta, exitPrice, exitReason) {
  if (!instrumentId) return; // can't watch price without an instrument id
  const shadows = loadShadows();
  shadows.push({
    symbol,
    instrumentId,
    tradeType: positionMeta.tradeType || "DAY",
    exitReason,
    exitPrice,
    // The RELEVANT next target: for a post-partial runner, Target 1 was
    // already banked, so "would it have hit T1" is trivially/misleadingly
    // true (the peak already exceeded it) — the honest counterfactual for
    // a runner is Target 2. Confirmed live: AAPL/MSFT runner exits showed
    // false "WOULD-HAVE-HIT-T1" flags despite capturing 80%+ of their MFE.
    targetT1: positionMeta.partialDone
      ? positionMeta.targetT2 || null
      : positionMeta.targetT1 || null,
    stopPrice: positionMeta.stopPrice || null,
    exitedAtMs: Date.now(),
    checkpointsDoneMinutes: [],
  });
  saveShadows(shadows);
  logger.info(
    symbol +
      ": exit-shadow tracking started (observation only) — checkpoints at " +
      CHECKPOINT_MINUTES.join("/") +
      " min",
  );
}

// Call on every exit-monitor tick. Cheap no-op unless a checkpoint is
// actually due; batches all due instrumentIds into one eToro rates call.
async function checkPendingShadows() {
  if (!etoroMarketData.isConfigured()) return;
  const shadows = loadShadows();
  if (!shadows.length) return;

  const nowMs = Date.now();
  const due = [];
  for (const shadow of shadows) {
    const elapsedMinutes = (nowMs - shadow.exitedAtMs) / 60000;
    const nextCheckpoint = CHECKPOINT_MINUTES.find(
      (minutes) =>
        elapsedMinutes >= minutes &&
        !shadow.checkpointsDoneMinutes.includes(minutes),
    );
    if (nextCheckpoint) due.push({ shadow, nextCheckpoint });
  }
  if (!due.length) return;

  let ratesByInstrumentId;
  try {
    const instrumentIds = [...new Set(due.map((d) => d.shadow.instrumentId))];
    ratesByInstrumentId = await etoroMarketData.fetchBatchedRates(instrumentIds);
  } catch (fetchError) {
    logger.warn(
      "Exit-shadow price check failed (will retry next tick): " +
        fetchError.message,
    );
    return;
  }

  let changed = false;
  for (const { shadow, nextCheckpoint } of due) {
    const rate = ratesByInstrumentId[shadow.instrumentId];
    if (!rate) continue; // instrument not resolvable right now — retry next tick
    const currentPrice = (rate.ask + rate.bid) / 2;
    const pctSinceExit = ((currentPrice - shadow.exitPrice) / shadow.exitPrice) * 100;
    const wouldHaveHitTarget1 =
      shadow.targetT1 != null ? currentPrice >= shadow.targetT1 : null;
    const wouldHaveHitStop =
      shadow.stopPrice != null ? currentPrice <= shadow.stopPrice : null;

    journal.exitShadowCheckpoint({
      symbol: shadow.symbol,
      exitReason: shadow.exitReason,
      minutesAfterExit: nextCheckpoint,
      exitPrice: shadow.exitPrice,
      priceNow: Number(currentPrice.toFixed(4)),
      pctSinceExit: Number(pctSinceExit.toFixed(2)),
      wouldHaveHitTarget1,
      wouldHaveHitStop,
    });
    logger.info(
      shadow.symbol +
        " exit-shadow +" +
        nextCheckpoint +
        "min: " +
        (pctSinceExit >= 0 ? "+" : "") +
        pctSinceExit.toFixed(2) +
        "% since exit" +
        (wouldHaveHitTarget1 ? " — WOULD HAVE HIT TARGET 1" : "") +
        (wouldHaveHitStop ? " — would have hit stop anyway" : ""),
    );

    shadow.checkpointsDoneMinutes.push(nextCheckpoint);
    changed = true;
  }

  // Drop fully-observed shadows (all checkpoints done) to keep the file small.
  const remaining = shadows.filter(
    (shadow) => shadow.checkpointsDoneMinutes.length < CHECKPOINT_MINUTES.length,
  );
  if (changed || remaining.length !== shadows.length) {
    saveShadows(remaining);
  }
}

module.exports = { startShadow, checkPendingShadows };
