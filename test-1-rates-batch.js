// test-1-rates-batch.js
//
// v2 UPDATE: the original path (/market-data/rates) returned 404
// RouteNotFound on a real account with working credentials (confirmed via
// test-4's WebSocket auth succeeding with the same keys). Different eToro
// doc sources actually show TWO different paths for this — one nested
// under /instruments/, one not. This version tries BOTH so we get a
// definitive answer instead of guessing again.
//
// THE KEY QUESTION THIS ANSWERS: does either rates path support
// comma-separated instrumentIds in ONE call, or does it reject/ignore
// extras and only return one instrument?
//
// Fill in INSTRUMENT_IDS below using the output from test-0-resolve-symbols.js
// (if test-0 still 401s, use the WORKING instrumentIds from your test-4
// output instead — 1001/1002/1003 clearly resolved to real instruments
// there, since the WebSocket returned real live prices for them)
//
// RUN:  node test-1-rates-batch.js
require("dotenv").config();
const { setupFileLogging } = require("./log-to-file");
setupFileLogging("test-1-rates-batch");
const axios = require("axios");
const { randomUUID } = require("crypto");

const API_BASE = "https://public-api.etoro.com/api/v1";
const API_KEY = process.env.ETORO_PUBLIC_API_KEY;
const USER_KEY = process.env.ETORO_AGENT_USER_KEY;

// ⚠️ FILL THESE IN — 1001/1002/1003 already confirmed real via test-4
const INSTRUMENT_IDS = {
  AAPL: 1001,
  TSLA: 1002,
  NVDA: 1003,
};

// Both candidate paths found across different eToro doc sources — testing
// both so we don't guess wrong twice.
const PATHS_TO_TRY = [
  "/market-data/rates",
  "/market-data/instruments/rates",
];

function headers() {
  return {
    "x-api-key": API_KEY,
    "x-user-key": USER_KEY,
    "x-request-id": randomUUID(),
    Accept: "application/json",
  };
}

async function testBatchCall(path, ids) {
  const idString = ids.join(",");
  const url = `${API_BASE}${path}?instrumentIds=${idString}`;
  console.log(`\n=== TEST A: single batched call — path "${path}" ===`);
  console.log("→ GET", url);
  try {
    const response = await axios.get(url, { headers: headers() });
    console.log("  status:", response.status);
    console.log("  raw response:", JSON.stringify(response.data, null, 2));

    const rates = response.data?.rates || response.data || [];
    const rateCount = Array.isArray(rates) ? rates.length : 0;
    console.log(
      `  requested ${ids.length} instrument(s), got back ${rateCount} rate(s) in the response`,
    );
    if (rateCount === ids.length) {
      console.log("  ✅ BATCHING WORKS — got one rate per requested instrument");
    } else if (rateCount === 1) {
      console.log(
        "  ⚠️  Only got 1 rate back for " +
          ids.length +
          " requested — looks like batching is NOT supported",
      );
    }
    return true; // path exists, at least
  } catch (error) {
    console.log(
      "  ❌ ERROR:",
      error.response?.status,
      JSON.stringify(error.response?.data || error.message),
    );
    return false;
  }
}

(async () => {
  if (!API_KEY || !USER_KEY) {
    console.log(
      "Missing ETORO_PUBLIC_API_KEY / ETORO_AGENT_USER_KEY — create a .env " +
        "file in this folder with both.",
    );
    process.exit(1);
  }

  const ids = Object.values(INSTRUMENT_IDS);
  console.log("Testing with instrumentIds:", INSTRUMENT_IDS);

  let workingPath = null;
  for (const path of PATHS_TO_TRY) {
    const worked = await testBatchCall(path, ids);
    if (worked && !workingPath) workingPath = path;
  }

  console.log("\n=== CONCLUSION ===");
  if (workingPath) {
    console.log(`✅ Working path found: ${workingPath}`);
  } else {
    console.log(
      "❌ BOTH paths failed. If both gave 401 (not 404), this confirms " +
        "the REST Market Data product likely isn't enabled for this API " +
        "key — check api-portal.etoro.com's key/app settings.",
    );
  }
})();
