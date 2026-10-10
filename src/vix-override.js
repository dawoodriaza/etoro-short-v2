#!/usr/bin/env node
// src/vix-override.js — set the VIX level by hand for a limited window.
//
//   node src/vix-override.js 28.5              use 28.5 for the next 24h
//   node src/vix-override.js 28.5 "CPI day"    with a note
//   node src/vix-override.js 28.5 --hours 6    custom window
//   node src/vix-override.js --status          show state, change nothing
//   node src/vix-override.js --clear           back to FRED immediately
//
// WHY THIS EXISTS
//   FRED's VIXCLS is a DAILY CLOSE and it publishes with a lag — the bot
//   has repeatedly run a whole session on a VIX two or three days old
//   (observed live: "VIX (FRED, 2026-08-28): 14.43" being used on
//   2026-09-01). On a day when volatility genuinely re-prices, that stale
//   number is worse than no number: the regime classifier tightens its CHOP
//   threshold on elevated VIX, so a stale-calm reading leaves the bot
//   trading a fearful tape as though it were quiet.
//
//   This lets you type in the real spot VIX you can see on any quote page,
//   have the bot use it, and have it EXPIRE on its own so a number you set
//   once can never silently drive the bot for weeks.
//
// SAFETY
//   · Expires automatically (default 24h) and reverts to FRED with no action.
//   · Refuses values outside 5-100 — the VIX has never closed outside that.
//   · Every log line names the source, so no reading is ever ambiguous
//     about whether it came from you or from FRED.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { logger } = require("./logger");

const overrideFilePath = path.join(__dirname, "../data/vix-override.json");
const dataDir = path.dirname(overrideFilePath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const DEFAULT_HOURS = Number(process.env.DT_VIX_OVERRIDE_HOURS || 24);
// The VIX has never closed below 8 or above 90 in its history. Anything
// outside 5-100 is a typo (a decimal slip, or a price pasted by mistake),
// and a typo here silently mis-drives the regime classifier all day.
const MIN_VALID_VIX = 5;
const MAX_VALID_VIX = 100;

function readFile() {
  try {
    if (!fs.existsSync(overrideFilePath)) return null;
    return JSON.parse(fs.readFileSync(overrideFilePath, "utf8"));
  } catch {
    return null;
  }
}

// Returns { value, setAt, expiresAt, note } while live, otherwise null.
// Deletes the file once expired so `--status` and the logs agree, and so a
// stale override cannot linger as a confusing artifact on disk.
function getActiveOverride() {
  const record = readFile();
  if (!record || typeof record.value !== "number") return null;

  const expiresAtMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return null;

  if (Date.now() >= expiresAtMs) {
    try {
      fs.unlinkSync(overrideFilePath);
      logger.info(
        "VIX override expired (was " +
          record.value.toFixed(2) +
          ") — reverting to FRED",
      );
    } catch {
      /* nothing to clean up */
    }
    return null;
  }
  return record;
}

function setOverride(value, hours, note) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    throw new Error("VIX value must be a number — got \"" + value + "\"");
  }
  if (numericValue < MIN_VALID_VIX || numericValue > MAX_VALID_VIX) {
    throw new Error(
      "VIX " +
        numericValue +
        " is outside the plausible range " +
        MIN_VALID_VIX +
        "-" +
        MAX_VALID_VIX +
        " — refusing, this is almost certainly a typo",
    );
  }
  const windowHours = Number.isFinite(Number(hours))
    ? Number(hours)
    : DEFAULT_HOURS;
  if (windowHours <= 0) throw new Error("--hours must be greater than zero");

  const now = Date.now();
  const record = {
    value: numericValue,
    setAt: new Date(now).toISOString(),
    expiresAt: new Date(now + windowHours * 3600 * 1000).toISOString(),
    hours: windowHours,
    note: note || null,
  };
  fs.writeFileSync(overrideFilePath, JSON.stringify(record, null, 2));
  return record;
}

function clearOverride() {
  if (!fs.existsSync(overrideFilePath)) return false;
  fs.unlinkSync(overrideFilePath);
  return true;
}

// Hours remaining, for display. Never negative.
function hoursRemaining(record) {
  const ms = Date.parse(record.expiresAt) - Date.now();
  return Math.max(0, ms / 3600000);
}

module.exports = {
  getActiveOverride,
  setOverride,
  clearOverride,
  hoursRemaining,
  overrideFilePath,
  MIN_VALID_VIX,
  MAX_VALID_VIX,
};

// ── CLI ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  const showStatus = () => {
    const active = getActiveOverride();
    if (!active) {
      console.log("\nVIX source: FRED (no manual override active)");
      return;
    }
    console.log("\nVIX source: MANUAL OVERRIDE");
    console.log("  value      " + active.value.toFixed(2));
    console.log("  set at     " + active.setAt);
    console.log("  expires    " + active.expiresAt);
    console.log("  remaining  " + hoursRemaining(active).toFixed(1) + "h");
    if (active.note) console.log("  note       " + active.note);
    console.log("\nReverts to FRED automatically. To revert now:");
    console.log("  node src/vix-override.js --clear");
  };

  if (args.length === 0 || args.includes("--status")) {
    showStatus();
    process.exit(0);
  }

  if (args.includes("--clear")) {
    console.log(
      clearOverride()
        ? "\nManual VIX override cleared — back to FRED."
        : "\nNo override was set — already using FRED.",
    );
    process.exit(0);
  }

  const hoursFlagIndex = args.indexOf("--hours");
  const hours =
    hoursFlagIndex !== -1 ? Number(args[hoursFlagIndex + 1]) : undefined;
  // Everything that is not a flag or a flag's argument is positional: the
  // value first, the rest joined as the note.
  //
  // NOTE: the `hoursFlagIndex + 1` exclusion must be guarded. With no
  // --hours flag, indexOf returns -1 and the expression becomes 0, which
  // silently swallowed argv[0] — the VIX value itself — and reported the
  // note as "not a number".
  const hoursArgIndex = hoursFlagIndex === -1 ? -1 : hoursFlagIndex + 1;
  const positional = args.filter(
    (arg, index) => !arg.startsWith("--") && index !== hoursArgIndex,
  );
  const [rawValue, ...noteParts] = positional;

  try {
    const record = setOverride(rawValue, hours, noteParts.join(" "));
    console.log("\n✅ Manual VIX set to " + record.value.toFixed(2));
    console.log("   active for " + record.hours + "h, expires " + record.expiresAt);
    if (record.note) console.log("   note: " + record.note);
    console.log(
      "\nThe bot picks this up on its next scan — no restart needed.",
    );
    console.log("Logs will read: VIX (MANUAL override ...)");
  } catch (error) {
    console.error("\n❌ " + error.message);
    process.exit(1);
  }
}
