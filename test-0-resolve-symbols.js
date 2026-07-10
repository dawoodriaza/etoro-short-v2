// test-0-resolve-symbols.js
//
// Resolves a small list of ticker symbols to eToro instrumentIds using
// GET /market-data/search — you need real instrumentIds before the other
// test scripts (rates/candles/websocket) mean anything.
//
// RUN:  node test-0-resolve-symbols.js
require("dotenv").config();
const { setupFileLogging } = require("./log-to-file");
setupFileLogging("test-0-resolve-symbols");
const axios = require("axios");
const { randomUUID } = require("crypto");

const API_BASE = "https://public-api.etoro.com/api/v1";
const API_KEY = process.env.ETORO_PUBLIC_API_KEY;
const USER_KEY = process.env.ETORO_AGENT_USER_KEY;

// Add/remove tickers here — these are the ones we'll test with in the
// other scripts once we have their instrumentIds.
const SYMBOLS_TO_RESOLVE = ["AAPL", "TSLA", "NVDA", "SPY", "AMD"];

function headers() {
  return {
    "x-api-key": API_KEY,
    "x-user-key": USER_KEY,
    "x-request-id": randomUUID(),
    Accept: "application/json",
  };
}

async function resolveSymbol(symbol) {
  const url = `${API_BASE}/market-data/search?internalSymbolFull=${encodeURIComponent(symbol)}`;
  console.log("\n→ GET", url);
  try {
    const response = await axios.get(url, { headers: headers() });
    console.log("  status:", response.status);
    console.log("  raw response:", JSON.stringify(response.data, null, 2));

    const items = response.data?.items || response.data?.results || [];
    const match = items.find(
      (item) =>
        (item.internalSymbolFull || item.symbol || "").toUpperCase() ===
        symbol.toUpperCase(),
    );
    if (match) {
      console.log(`  ✅ ${symbol} → instrumentId ${match.instrumentId}`);
      return { symbol, instrumentId: match.instrumentId };
    }
    console.log(`  ⚠️  No exact match found for ${symbol} in the response`);
    return null;
  } catch (error) {
    console.log(
      "  ❌ ERROR:",
      error.response?.status,
      JSON.stringify(error.response?.data || error.message),
    );
    return null;
  }
}

(async () => {
  if (!API_KEY || !USER_KEY) {
    console.log(
      "Missing ETORO_PUBLIC_API_KEY / ETORO_AGENT_USER_KEY — create a .env " +
        "file in this folder with both (same values as your server's .env).",
    );
    process.exit(1);
  }

  console.log("=== Resolving symbols to eToro instrumentIds ===");
  const resolved = [];
  for (const symbol of SYMBOLS_TO_RESOLVE) {
    const result = await resolveSymbol(symbol);
    if (result) resolved.push(result);
  }

  console.log("\n=== SUMMARY (copy these instrumentIds into the other test scripts) ===");
  resolved.forEach((r) => console.log(`  ${r.symbol}: ${r.instrumentId}`));
})();
