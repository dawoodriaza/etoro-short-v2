# eToro API test scripts

Run these on your laptop (NOT the server) to empirically test what eToro's
market-data API can actually give us, before building anything real on it.

## Setup

```bash
npm install
```

Create a `.env` file in this folder:

```
ETORO_PUBLIC_API_KEY=your_real_key_here
ETORO_AGENT_USER_KEY=your_real_user_key_here
```

(same values as your server's `.env` — these are read-only market-data
calls, they won't open or close any positions)

## Run in this order

```bash
node test-0-resolve-symbols.js
```
Copy the instrumentIds it prints out, then paste them into the
`INSTRUMENT_IDS` / `INSTRUMENT_ID` placeholders at the top of scripts 1-4.

```bash
node test-1-rates-batch.js       # does /market-data/rates actually batch?
node test-2-closing-prices.js    # does the closing-price endpoint batch, and give us gap% data?
node test-3-candles.js           # does candles give intraday OHLCV with volume?
node test-4-websocket.js         # what does the live WebSocket feed actually contain? (runs ~30s)
```

## What we're actually trying to learn

1. **test-1**: eToro's own docs show `/market-data/rates?instrumentIds=1,2,3`
   returning multiple rates in one call. An unofficial SDK claims the API
   actually rejects comma-separated IDs and fans out to one call each. This
   test settles it empirically.
2. **test-2**: a SEPARATE endpoint (`closing-price`) whose docs example
   already shows 2 different instruments in one response — likely genuine
   batching, gives us previous-close for gap% math.
3. **test-3**: neither `/rates` nor the WebSocket feed include VOLUME. If
   candles has an intraday interval WITH a volume field, that closes the
   gap. If not, eToro's API can only ever be a partial replacement (price +
   gap%, not volume-ratio or breakout-vs-recent-high signals).
4. **test-4**: confirms live tick shape over the actual WebSocket
   connection — should match the docs (Ask/Bid/LastExecution/Date only).

Paste me the full console output from all 4 and I'll tell you exactly what,
if anything, is worth building into the bot.
# etoro-short-v2
