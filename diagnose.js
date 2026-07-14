// diagnose.js — read the bot's own decision journal and tell you EXACTLY
// why it isn't trading. Run on the server:
//
//   node diagnose.js            # last 14 days
//   node diagnose.js 30         # last 30 days
//
// It reads data/journal/decisions-YYYY-MM-DD.jsonl (one JSON event per line)
// and prints the funnel: how many scans ran, where they died (GATE_BLOCK),
// and where individual candidates died (CANDIDATE_REJECTED). The stage with
// the biggest number is what is stopping the bot.
const fs = require("fs");
const path = require("path");

const days = parseInt(process.argv[2]) || 14;
const journalDir = path.join(__dirname, "data", "journal");

if (!fs.existsSync(journalDir)) {
  console.log("No journal directory at " + journalDir + " — has the bot run at all?");
  process.exit(0);
}

const cutoff = Date.now() - days * 86400000;
const files = fs
  .readdirSync(journalDir)
  .filter((f) => f.startsWith("decisions-") && f.endsWith(".jsonl"))
  .filter((f) => {
    const d = f.slice("decisions-".length, -".jsonl".length);
    return new Date(d + "T23:59:59Z").getTime() >= cutoff;
  })
  .sort();

if (!files.length) {
  console.log("No journal files in the last " + days + " days.");
  process.exit(0);
}

const gateBlocks = {}; // reason-prefix -> count
const rejectStages = {}; // stage -> count
const rejectReasons = {}; // "stage: reason-prefix" -> count
const aiDecisions = { TAKE: 0, SKIP: 0 };
const aiSkipReasons = {};
// Per-day AI take/skip, split out by WHICH rule drove a skip — lets you see
// whether BAD-DAY RULE / SESSION RULE skips are a one-off (bad day) or a
// recurring pattern (bar miscalibrated) rather than reading log lines by eye.
const dailyAi = {}; // date -> { take, skip, badDay, session, other }
let scans = 0,
  scanSkipped = 0,
  plansBuilt = 0,
  planRejected = 0,
  tradesOpened = 0,
  tradesClosed = 0,
  scanErrors = 0;

// collapse "SPY -0.42% below floor" / "earnings 2026-07-11" into a stable key
function normalize(reason) {
  return String(reason || "unknown")
    .replace(/-?\d+(\.\d+)?/g, "#")
    .slice(0, 70);
}

for (const file of files) {
  const fileDate = file.slice("decisions-".length, -".jsonl".length);
  const lines = fs
    .readFileSync(path.join(journalDir, file), "utf8")
    .split("\n")
    .filter(Boolean);
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    switch (e.event) {
      case "SCAN_START":
        scans++;
        break;
      case "SCAN_SKIPPED":
        scanSkipped++;
        break;
      case "GATE_BLOCK": {
        const key = e.gate + " — " + normalize(e.reason);
        gateBlocks[key] = (gateBlocks[key] || 0) + 1;
        break;
      }
      case "CANDIDATE_REJECTED":
        rejectStages[e.stage] = (rejectStages[e.stage] || 0) + 1;
        {
          const key = e.stage + ": " + normalize(e.reason);
          rejectReasons[key] = (rejectReasons[key] || 0) + 1;
        }
        break;
      case "PLAN_BUILT":
        plansBuilt++;
        break;
      case "PLAN_REJECTED":
        planRejected++;
        break;
      case "AI_DECISION": {
        const day = (dailyAi[fileDate] ||= {
          take: 0,
          skip: 0,
          badDay: 0,
          session: 0,
          other: 0,
        });
        if (e.decision === "TAKE") {
          aiDecisions.TAKE++;
          day.take++;
        } else if (e.decision === "SKIP") {
          aiDecisions.SKIP++;
          day.skip++;
          aiSkipReasons[normalize(e.reasoning)] =
            (aiSkipReasons[normalize(e.reasoning)] || 0) + 1;
          const reasoningText = String(e.reasoning || "").toUpperCase();
          if (reasoningText.includes("BAD-DAY")) day.badDay++;
          else if (reasoningText.includes("SESSION RULE")) day.session++;
          else day.other++;
        }
        break;
      }
      case "TRADE_OPENED":
        tradesOpened++;
        break;
      case "TRADE_CLOSED":
        tradesClosed++;
        break;
      case "ERROR":
        scanErrors++;
        break;
    }
  }
}

const sortDesc = (obj) =>
  Object.entries(obj).sort((a, b) => b[1] - a[1]);

console.log("\n════════ BOT DIAGNOSIS — last " + days + " days ════════");
console.log("Journal files read: " + files.length + " (" + files[0] + " … " + files[files.length - 1] + ")");
console.log("\nFUNNEL");
console.log("  Scans started ............ " + scans);
console.log("  Scans skipped (adaptive) . " + scanSkipped);
console.log("  Plans built .............. " + plansBuilt);
console.log("  Plans rejected ........... " + planRejected);
console.log("  AI screener  TAKE / SKIP . " + aiDecisions.TAKE + " / " + aiDecisions.SKIP);
console.log("  TRADES OPENED ............ " + tradesOpened);
console.log("  Trades closed ............ " + tradesClosed);
console.log("  Errors ................... " + scanErrors);

console.log("\nGATE BLOCKS (whole scan aborted here — this is the #1 thing to fix):");
const gb = sortDesc(gateBlocks);
if (!gb.length) console.log("  (none — scans are getting past the gates)");
gb.slice(0, 12).forEach(([k, v]) => console.log("  " + String(v).padStart(5) + "  " + k));

console.log("\nCANDIDATE REJECTIONS BY STAGE (individual stocks thrown out):");
const rs = sortDesc(rejectStages);
if (!rs.length) console.log("  (none)");
rs.forEach(([k, v]) => console.log("  " + String(v).padStart(5) + "  " + k));

console.log("\nTOP CANDIDATE REJECTION REASONS:");
sortDesc(rejectReasons)
  .slice(0, 15)
  .forEach(([k, v]) => console.log("  " + String(v).padStart(5) + "  " + k));

if (aiDecisions.SKIP > 0) {
  console.log("\nTOP AI-SCREENER SKIP REASONS:");
  sortDesc(aiSkipReasons)
    .slice(0, 10)
    .forEach(([k, v]) => console.log("  " + String(v).padStart(5) + "  " + k));
}

const aiDays = Object.keys(dailyAi).sort();
if (aiDays.length) {
  console.log(
    "\nAI SCREENER BY DAY (BAD-DAY RULE / SESSION RULE skips — is a tight " +
      "day a ONE-OFF or a RECURRING pattern?):",
  );
  console.log(
    "  " +
      "DATE".padEnd(12) +
      "TAKE".padStart(6) +
      "SKIP".padStart(6) +
      "BAD-DAY".padStart(9) +
      "SESSION".padStart(9) +
      "OTHER".padStart(7) +
      "  SKIP%",
  );
  for (const day of aiDays) {
    const d = dailyAi[day];
    const total = d.take + d.skip;
    const skipPct = total ? ((d.skip / total) * 100).toFixed(0) : "0";
    console.log(
      "  " +
        day.padEnd(12) +
        String(d.take).padStart(6) +
        String(d.skip).padStart(6) +
        String(d.badDay).padStart(9) +
        String(d.session).padStart(9) +
        String(d.other).padStart(7) +
        "  " +
        skipPct +
        "%",
    );
  }
  const recurringBadDayDays = aiDays.filter((d) => dailyAi[d].badDay > 0).length;
  const recurringSessionDays = aiDays.filter(
    (d) => dailyAi[d].session > 0,
  ).length;
  console.log(
    "\n  BAD-DAY RULE fired on " +
      recurringBadDayDays +
      "/" +
      aiDays.length +
      " day(s) · SESSION RULE fired on " +
      recurringSessionDays +
      "/" +
      aiDays.length +
      " day(s)." +
      (recurringBadDayDays >= 3
        ? " 3+ days — worth checking if the bar is too strict, not just a bad stretch."
        : ""),
  );
}
console.log("\n════════════════════════════════════════════════\n");
