// src/etoro-price-stream.js
//
// v6 NEW MODULE (2026-07-21, review-driven upgrade) — REAL-TIME EXIT
// WATCHDOG via eToro's WebSocket (wss://ws.etoro.com/ws — the same
// authenticated tick stream already proven in the sibling long-term bot's
// src/data-sources/etoro-price-stream.js).
//
// WHY THIS EXISTS: the 1-minute exit-monitor tick is already fast (this bot
// does NOT poll every 10 minutes for exits — only NEW ENTRIES scan every
// DT_SCAN_INTERVAL_MINUTES; exits run every single minute via REST). This
// watchdog closes the remaining gap: instead of waiting up to 60 seconds for
// the next scheduled tick, a live tick that crosses a HELD position's own
// stop/floor level triggers an IMMEDIATE off-cycle exit-monitor run.
//
// SCOPE — deliberately narrow, matching the sibling bot's discipline:
//   - NO trade is ever placed from tick data. A tick only TRIGGERS a check;
//     eToro's own REST P&L (via manageOpenPositions) remains the sole
//     source of truth for the actual close decision, INCLUDING the
//     whipsaw-confirmation logic in risk-manager.js, which still applies
//     exactly as it does on a normal 1-minute tick.
//   - Each watched position's trigger level is its OWN current stop/floor
//     (lockedFloor || stopPrice) — this bot sizes stops per-position via
//     ATR, not a single global "-15% hard stop" fraction like the sibling
//     bot, so there is no one fixed threshold to hardcode. The trigger
//     level is refreshed every time updateWatchedPositions() is called
//     (every exit-monitor tick), so a ratcheted floor (post-partial,
//     AI-tightened, etc.) is always current.
//   - No market-data replacement: the WS carries Ask/Bid only. Watchlist
//     scanning and technicals are entirely unaffected.
//
// FAIL-SOFT: every failure mode (ws package missing, auth rejected,
// connection drops) degrades to exactly the pre-watchdog behavior — the
// 1-minute monitor alone. Reconnects with backoff, resubscribes after
// reconnect. Disable entirely with DT_PRICE_STREAM_ENABLED=false.
require("dotenv").config();
const { randomUUID } = require("crypto");
const { logger } = require("./logger");
const config = require("./config");

const WS_URL = "wss://ws.etoro.com/ws";
const RECONNECT_DELAY_MS = 30000;
const EMERGENCY_DEBOUNCE_MS = 60000; // per-symbol: at most 1 trigger / 1 min

let ws = null;
let isAuthenticated = false;
let reconnectTimer = null;
let intentionallyStopped = false;
let onEmergencyCallback = null;
// instrumentId (string) → { symbol, stopOrFloor }
const watchedPositions = new Map();
// symbol → last emergency trigger timestamp
const lastEmergencyAt = new Map();

function isEnabled() {
  return config.priceStreamEnabled !== false;
}

function currentTopics() {
  return Array.from(watchedPositions.keys()).map((id) => "instrument:" + id);
}

function safeSend(payload) {
  try {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
      return true;
    }
  } catch (sendError) {
    logger.warn("Price stream send failed: " + sendError.message);
  }
  return false;
}

function scheduleReconnect() {
  if (reconnectTimer || !isEnabled()) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

function handleTick(topic, content) {
  const instrumentId = String(topic).replace("instrument:", "");
  const watched = watchedPositions.get(instrumentId);
  if (!watched || !watched.stopOrFloor) return;

  // Fields arrive as STRINGS (confirmed empirically on the sibling bot) —
  // parse defensively.
  const ask = parseFloat(content.Ask);
  const bid = parseFloat(content.Bid);
  if (isNaN(ask) || isNaN(bid) || ask <= 0 || bid <= 0) return;
  const mid = (ask + bid) / 2;

  // Long-only bot: a live mid AT OR BELOW the position's own current
  // stop/floor is the trigger — this is an ESTIMATE (no fees/spread), good
  // enough as a tripwire. The emergency check re-reads real P&L from eToro
  // (via manageOpenPositions) before risk-manager's confirmation logic
  // decides anything.
  if (mid <= watched.stopOrFloor) {
    const lastTrigger = lastEmergencyAt.get(watched.symbol) || 0;
    if (Date.now() - lastTrigger < EMERGENCY_DEBOUNCE_MS) return;
    lastEmergencyAt.set(watched.symbol, Date.now());

    logger.warn(
      "🚨 PRICE STREAM: " +
        watched.symbol +
        " live mid $" +
        mid.toFixed(4) +
        " at/below its stop/floor $" +
        watched.stopOrFloor.toFixed(4) +
        " — triggering an immediate exit-monitor check instead of waiting " +
        "for the next 1-min tick.",
    );
    if (onEmergencyCallback) {
      Promise.resolve(onEmergencyCallback(watched.symbol, mid)).catch(
        (callbackError) =>
          logger.error("Emergency check failed: " + callbackError.message),
      );
    }
  }
}

function connect() {
  if (!isEnabled()) return;
  let WebSocketImpl;
  try {
    WebSocketImpl = require("ws");
  } catch {
    logger.warn(
      "Price stream: 'ws' package not installed — real-time exit watchdog " +
        "disabled (run: npm install ws). The 1-minute exit monitor still " +
        "covers every position.",
    );
    return;
  }

  const apiKey = process.env.ETORO_PUBLIC_API_KEY;
  const userKey = process.env.ETORO_AGENT_USER_KEY;
  if (!apiKey || !userKey) return;

  try {
    ws = new WebSocketImpl(WS_URL);
  } catch (initError) {
    logger.warn("Price stream connect failed: " + initError.message);
    scheduleReconnect();
    return;
  }

  isAuthenticated = false;

  ws.on("open", () => {
    safeSend({
      id: randomUUID(),
      operation: "Authenticate",
      data: { userKey, apiKey },
    });
  });

  ws.on("message", (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (parsed.operation === "Authenticate") {
      if (parsed.success) {
        isAuthenticated = true;
        const topics = currentTopics();
        if (topics.length > 0) {
          safeSend({
            id: randomUUID(),
            operation: "Subscribe",
            data: { topics, snapshot: true },
          });
        }
        logger.info(
          "📶 Price stream connected — real-time exit watchdog live for " +
            topics.length +
            " position(s)",
        );
      } else {
        logger.warn("Price stream: authentication rejected");
      }
      return;
    }

    for (const message of parsed.messages || []) {
      if (!message.topic?.startsWith("instrument:") || !message.content)
        continue;
      try {
        handleTick(message.topic, JSON.parse(message.content));
      } catch {
        // malformed tick — ignore
      }
    }
  });

  ws.on("error", (wsError) => {
    logger.warn("Price stream error: " + wsError.message);
  });

  ws.on("close", () => {
    isAuthenticated = false;
    if (intentionallyStopped) return;
    logger.info(
      "Price stream disconnected — reconnecting in " +
        RECONNECT_DELAY_MS / 1000 +
        "s (1-min exit monitor unaffected)",
    );
    scheduleReconnect();
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

// Start the watchdog. onEmergency(symbol, estimatedMidPrice) is called (at
// most once per symbol per minute) when a held position's live mid crosses
// its own current stop/floor.
function start(onEmergency) {
  if (!isEnabled()) {
    logger.info("Price stream disabled via DT_PRICE_STREAM_ENABLED=false");
    return;
  }
  intentionallyStopped = false;
  onEmergencyCallback = onEmergency;
  connect();
}

// Sync the watched set to the currently-open, THIS-BOT-TRACKED positions.
// Call every exit-monitor tick with the fresh portfolio + meta (already
// fetched for other purposes — zero extra API calls).
// positions: eToro's portfolio.openPositions (has instrumentId, symbol).
// metaBySymbol: position-meta.json contents (has stopPrice/lockedFloor).
function updateWatchedPositions(positions, metaBySymbol) {
  if (!isEnabled()) return;

  const nextIds = new Set();
  for (const position of positions || []) {
    const symbol = (position.symbol || "").toUpperCase();
    const positionMeta = metaBySymbol ? metaBySymbol[symbol] : null;
    if (!positionMeta || !position.instrumentId) continue; // not tracked
    const stopOrFloor = positionMeta.lockedFloor || positionMeta.stopPrice;
    if (!stopOrFloor || stopOrFloor <= 0) continue;
    nextIds.add(String(position.instrumentId));
  }

  // Unsubscribe positions that closed or are no longer tracked.
  const removedTopics = [];
  for (const existingId of watchedPositions.keys()) {
    if (!nextIds.has(existingId)) {
      watchedPositions.delete(existingId);
      removedTopics.push("instrument:" + existingId);
    }
  }

  // (Re)subscribe / refresh trigger levels for every currently-held,
  // tracked position — this also picks up a ratcheted floor automatically.
  const addedTopics = [];
  for (const position of positions || []) {
    const symbol = (position.symbol || "").toUpperCase();
    const positionMeta = metaBySymbol ? metaBySymbol[symbol] : null;
    if (!positionMeta || !position.instrumentId) continue;
    const stopOrFloor = positionMeta.lockedFloor || positionMeta.stopPrice;
    if (!stopOrFloor || stopOrFloor <= 0) continue;
    const idKey = String(position.instrumentId);
    if (!watchedPositions.has(idKey)) addedTopics.push("instrument:" + idKey);
    watchedPositions.set(idKey, { symbol, stopOrFloor });
  }

  if (isAuthenticated) {
    if (removedTopics.length > 0) {
      safeSend({
        id: randomUUID(),
        operation: "Unsubscribe",
        data: { topics: removedTopics },
      });
    }
    if (addedTopics.length > 0) {
      safeSend({
        id: randomUUID(),
        operation: "Subscribe",
        data: { topics: addedTopics, snapshot: true },
      });
    }
  }
}

function stop() {
  intentionallyStopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    if (ws) ws.close();
  } catch {}
  ws = null;
}

module.exports = { start, updateWatchedPositions, stop };
