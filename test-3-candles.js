// test-3-candles.js
//
// THE KEY QUESTION THIS ANSWERS: does the candles endpoint give us OHLCV
// (specifically VOLUME, which /rates does NOT have) — and does it support
// an INTRADAY interval (needed for gap/breakout/volume-ratio detection),
// or only daily bars (which would be useless for a day-trade bot)?
//
// We test with TWO intervals: OneDay (baseline, definitely should work)
// and a shorter one if the API supports it — check the raw response for
// what interval values are actually accepted (a 400 error will usually
// name the valid enum values).
//
// Fill in INSTRUMENT_ID below using output from test-0-resolve-symbols.js
// (single instrument only — candles is a per-instrument endpoint)
//
// RUN:  node test-3-candles.js
require("dotenv").config();
const { setupFileLogging } = require("./log-to-file");
setupFileLogging("test-3-candles");
const axios = require("axios");
const { randomUUID } = require("crypto");

const API_BASE = "https://public-api.etoro.com/api/v1";
const API_KEY = process.env.ETORO_PUBLIC_API_KEY;
const USER_KEY = process.env.ETORO_AGENT_USER_KEY;

// ⚠️ FILL THIS IN from test-0-resolve-symbols.js output before running
const INSTRUMENT_ID = 1001; // placeholder — e.g. AAPL's real instrumentId

// Try several interval names — one of these should be the correct enum
// value if intraday candles are supported at all. Unknown ones will just
// 400, which is fine — we're probing.
const INTERVALS_TO_TRY = [
  "OneDay",
  "OneMinute",
  "FiveMinutes",
  "FifteenMinutes",
  "OneHour",
];

function headers() {
  return {
    "x-api-key": API_KEY,
    "x-user-key": USER_KEY,
    "x-request-id": randomUUID(),
    Accept: "application/json",
  };
}

async function testInterval(interval) {
  const CANDLE_COUNT = 5;

  const url =
    `${API_BASE}/market-data/instruments/` +
    `${INSTRUMENT_ID}/history/candles/` +
    `desc/${interval}/${CANDLE_COUNT}`;

  console.log(`\n=== Trying interval: "${interval}" ===`);
  console.log("→ GET", url);
  try {
    const response = await axios.get(url, { headers: headers() });
    console.log("  status:", response.status);
    console.log("  raw response:", JSON.stringify(response.data, null, 2));

    const candles = response.data?.candles || response.data || [];
    const firstCandle = Array.isArray(candles) ? candles[0] : null;
    if (firstCandle) {
      const hasVolume =
        "volume" in firstCandle ||
        "Volume" in firstCandle ||
        "v" in firstCandle;
      console.log(
        `  ✅ "${interval}" accepted — ${candles.length} candle(s) returned. ` +
          `Volume field present: ${hasVolume ? "YES" : "NO"}`,
      );
    }
  } catch (error) {
    console.log(
      "  ❌ REJECTED:",
      error.response?.status,
      JSON.stringify(error.response?.data || error.message),
    );
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

  console.log("Testing candles for instrumentId:", INSTRUMENT_ID);
  for (const interval of INTERVALS_TO_TRY) {
    await testInterval(interval);
  }

  console.log(
    "\n=== WHY THIS MATTERS ===\n" +
      "If any intraday interval works AND has a volume field, that's the " +
      "one missing piece (volume) that would let eToro's own API fully " +
      "replace Twelve Data for the watchlist quote fetch. If only OneDay " +
      "works, or no interval has volume, eToro's market-data API can only " +
      "ever be a PARTIAL replacement (price + gap%, not volume-based signals).",
  );
})();
