// // test-2-closing-prices.js
// //
// // Checks GET /market-data/instruments/history/closing-price — this is a
// // SEPARATE endpoint from /market-data/rates, and the docs example shows
// // it returning multiple instruments in one array response (instrumentId
// // 1002 AND 999 in a single call), which suggests genuine batching here
// // regardless of what we find for /rates in test-1.
// //
// // This would supply the PREVIOUS CLOSE we need for gap% calculation —
// // one of the two things (along with volume) that eToro's live rate/WS
// // feeds don't provide on their own.
// //
// // Fill in INSTRUMENT_IDS below using the output from test-0-resolve-symbols.js
// //
// // RUN:  node test-2-closing-prices.js
// require("dotenv").config();
// const { setupFileLogging } = require("./log-to-file");
// setupFileLogging("test-2-closing-prices");
// const axios = require("axios");
// const { randomUUID } = require("crypto");

// const API_BASE = "https://public-api.etoro.com/api/v1";
// const API_KEY = process.env.ETORO_PUBLIC_API_KEY;
// const USER_KEY = process.env.ETORO_AGENT_USER_KEY;

// // ⚠️ FILL THESE IN from test-0-resolve-symbols.js output before running
// const INSTRUMENT_IDS = {
//   AAPL: 1001, // placeholder
//   TSLA: 1002, // placeholder
//   NVDA: 1003, // placeholder
// };

// function headers() {
//   return {
//     "x-api-key": API_KEY,
//     "x-user-key": USER_KEY,
//     "x-request-id": randomUUID(),
//     Accept: "application/json",
//   };
// }

// (async () => {
//   if (!API_KEY || !USER_KEY) {
//     console.log(
//       "Missing ETORO_PUBLIC_API_KEY / ETORO_AGENT_USER_KEY — create a .env " +
//         "file in this folder with both.",
//     );
//     process.exit(1);
//   }

//   const ids = Object.values(INSTRUMENT_IDS);
//   const idString = ids.join(",");
//   const url = `${API_BASE}/market-data/instruments/history/closing-price?instrumentIds=${idString}`;

//   console.log("Testing with instrumentIds:", INSTRUMENT_IDS);
//   console.log("\n→ GET", url);
//   try {
//     const response = await axios.get(url, { headers: headers() });
//     console.log("  status:", response.status);
//     console.log("  raw response:", JSON.stringify(response.data, null, 2));

//     const entries = Array.isArray(response.data) ? response.data : [];
//     console.log(
//       `\n  requested ${ids.length} instrument(s), got back ${entries.length} entr(y/ies)`,
//     );
//     if (entries.length === ids.length) {
//       console.log(
//         "  ✅ BATCHING WORKS on this endpoint — one closing-price entry per instrument",
//       );
//     } else {
//       console.log("  ⚠️  Count mismatch — inspect the raw response above");
//     }

//     entries.forEach((entry) => {
//       console.log(
//         `  instrumentId ${entry.instrumentId}: officialClosingPrice=${entry.officialClosingPrice}, ` +
//           `daily.price=${entry.closingPrices?.daily?.price}, isMarketOpen=${entry.isMarketOpen}`,
//       );
//     });
//   } catch (error) {
//     console.log(
//       "  ❌ ERROR:",
//       error.response?.status,
//       JSON.stringify(error.response?.data || error.message),
//     );
//   }

//   console.log(
//     "\n=== WHY THIS MATTERS ===\n" +
//       "If this works, we can combine: (previous close from here) + (live " +
//       "price from /rates or the WebSocket) = real gap% calculation, " +
//       "without needing Twelve Data for that piece at all.",
//   );
// })();
// test-2-closing-price.js
//
// Tests GET /market-data/instruments/history/closing-price
// for a single instrument.
//
// RUN: node test-2-closing-price.js

require("dotenv").config();
const { setupFileLogging } = require("./log-to-file");
setupFileLogging("test-2-closing-price");

const axios = require("axios");
const { randomUUID } = require("crypto");

const API_BASE = "https://public-api.etoro.com/api/v1";
const API_KEY = process.env.ETORO_PUBLIC_API_KEY;
const USER_KEY = process.env.ETORO_AGENT_USER_KEY;

const INSTRUMENT_ID = 1001;

function headers() {
  return {
    "x-api-key": API_KEY,
    "x-user-key": USER_KEY,
    "x-request-id": randomUUID(),
    Accept: "application/json",
  };
}

async function testClosingPrice() {
  const url =
    `${API_BASE}/market-data/instruments/history/closing-price` +
    `?instrumentIds=${INSTRUMENT_ID}`;

  console.log("Testing instrumentId:", INSTRUMENT_ID);
  console.log("\n→ GET", url);

  try {
    const response = await axios.get(url, {
      headers: headers(),
    });

    console.log("Status:", response.status);
    console.log(
      "Raw response:",
      JSON.stringify(response.data, null, 2)
    );

    const entry = Array.isArray(response.data)
      ? response.data[0]
      : response.data;

    if (!entry) {
      console.log("❌ No closing price returned.");
      return;
    }

    console.log("\n=== Parsed ===");
    console.log("Instrument:", entry.instrumentId);
    console.log("Official Close:", entry.officialClosingPrice);
    console.log("Daily:", entry.closingPrices?.daily);
    console.log("Weekly:", entry.closingPrices?.weekly);
    console.log("Monthly:", entry.closingPrices?.monthly);
  } catch (error) {
    console.log(
      "❌ ERROR:",
      error.response?.status,
      JSON.stringify(error.response?.data || error.message, null, 2)
    );
  }
}

(async () => {
  if (!API_KEY || !USER_KEY) {
    console.log(
      "Missing ETORO_PUBLIC_API_KEY or ETORO_AGENT_USER_KEY."
    );
    process.exit(1);
  }

  await testClosingPrice();
})();