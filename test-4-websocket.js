// test-4-websocket.js
//
// Connects to eToro's real-time WebSocket, authenticates, subscribes to a
// couple of instrument price topics, and logs every raw message for ~30
// seconds so we can see EXACTLY what fields come through live (confirming
// what the docs say: Ask/Bid/LastExecution/Date only — no OHLC, no volume).
//
// This matters for deciding whether the WebSocket is even worth using: if
// it's price-only, it can supplement Twelve Data (for instant current-price
// checks) but can't replace it for gap%/volume-ratio/breakout signals.
//
// Fill in INSTRUMENT_IDS below using output from test-0-resolve-symbols.js
//
// RUN:  node test-4-websocket.js
require("dotenv").config();
const { setupFileLogging } = require("./log-to-file");
setupFileLogging("test-4-websocket");
const { randomUUID } = require("crypto");
const WebSocket = require("ws");

const API_KEY = process.env.ETORO_PUBLIC_API_KEY;
const USER_KEY = process.env.ETORO_AGENT_USER_KEY;
const WS_URL = "wss://ws.etoro.com/ws";

// ⚠️ FILL THESE IN from test-0-resolve-symbols.js output before running
const INSTRUMENT_IDS = [1001, 1002, 1003]; // e.g. AAPL, TSLA, NVDA real IDs

const RUN_DURATION_MS = 30000; // listen for 30 seconds then disconnect
let messageCount = 0;
let uniqueTopicsSeen = new Set();

if (!API_KEY || !USER_KEY) {
  console.log(
    "Missing ETORO_PUBLIC_API_KEY / ETORO_AGENT_USER_KEY — create a .env " +
      "file in this folder with both.",
  );
  process.exit(1);
}

console.log("Connecting to", WS_URL, "...");
const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log("✅ Connected. Sending Authenticate...");
  const authRequest = {
    id: randomUUID(),
    operation: "Authenticate",
    data: {
      userKey: USER_KEY,
      apiKey: API_KEY,
    },
  };
  ws.send(JSON.stringify(authRequest));

  // Give auth a moment, then subscribe. (If auth fails you'll see an error
  // message logged below instead of price ticks — that tells us auth
  // itself didn't work with these keys/this transport.)
  setTimeout(() => {
    const topics = INSTRUMENT_IDS.map((id) => `instrument:${id}`);
    console.log("Subscribing to topics:", topics);
    const subscribeRequest = {
      id: randomUUID(),
      operation: "Subscribe",
      data: {
        topics,
        snapshot: true, // ask for an immediate current value, not just future ticks
      },
    };
    ws.send(JSON.stringify(subscribeRequest));
  }, 1500);
});

ws.on("message", (raw) => {
  messageCount++;
  console.log(`\n--- message #${messageCount} ---`);
  console.log(raw.toString());

  try {
    const parsed = JSON.parse(raw.toString());
    (parsed.messages || []).forEach((message) => {
      uniqueTopicsSeen.add(message.topic);
      if (message.content) {
        try {
          const content = JSON.parse(message.content);
          console.log(
            "  parsed content:",
            JSON.stringify(content, null, 2),
          );
          console.log(
            "  fields present:",
            Object.keys(content).join(", "),
          );
        } catch {
          // content wasn't JSON, already logged raw above
        }
      }
    });
  } catch {
    // not JSON — already logged raw above
  }
});

ws.on("error", (error) => {
  console.log("❌ WebSocket error:", error.message);
});

ws.on("close", (code, reason) => {
  console.log(`\nConnection closed (code ${code}): ${reason}`);
});

setTimeout(() => {
  console.log("\n=== SUMMARY ===");
  console.log("Total messages received:", messageCount);
  console.log("Unique topics seen:", Array.from(uniqueTopicsSeen));
  console.log(
    "\nCheck above: did each 'instrument:<id>' message contain ONLY " +
      "Ask/Bid/LastExecution/Date, or something more (OHLC/volume)? The " +
      "official docs say price-only — this confirms it empirically.",
  );
  ws.close();
  setTimeout(() => process.exit(0), 500);
}, RUN_DURATION_MS);
