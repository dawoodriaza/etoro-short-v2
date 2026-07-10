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
      case "AI_DECISION":
        if (e.decision === "TAKE") aiDecisions.TAKE++;
        else if (e.decision === "SKIP") {
          aiDecisions.SKIP++;
          aiSkipReasons[normalize(e.reasoning)] =
            (aiSkipReasons[normalize(e.reasoning)] || 0) + 1;
        }
        break;
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
console.log("\n════════════════════════════════════════════════\n");
