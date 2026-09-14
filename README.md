# etoro-v2-short — eToro intraday momentum trading bot

A Node.js bot that trades US stocks on an **eToro agent portfolio**, 24 hours a
day, 5 days a week. It spots stocks that are going up, has an AI double-check
each trade, buys on a dip, and manages the position with a stop-loss, partial
take-profit and trailing exits. A real eToro account copies the agent portfolio
at a smaller size.

This README is written for two readers:

- **Humans** (the owner): what the bot does, how to run it, how to read its
  messages, what to do when something looks wrong.
- **AI models / coding agents** picking up this codebase with no prior context:
  architecture, data, rules of engagement, and where the evidence for every
  setting lives. Read [For AI agents](#for-ai-agents--read-this-first) before
  changing anything.

Detailed history, evidence and the reasoning behind every change:
[`CHANGELOG.md`](CHANGELOG.md).

---

## Contents

1. [Status snapshot](#status-snapshot-2026-09-14)
2. [For AI agents — read this first](#for-ai-agents--read-this-first)
3. [How the bot trades (plain language)](#how-the-bot-trades-plain-language)
4. [How a position is managed and closed](#how-a-position-is-managed-and-closed)
5. [Safety controls](#safety-controls)
6. [Schedule](#schedule)
7. [Telegram messages](#telegram-messages)
8. [Data, logs and the decision journal](#data-logs-and-the-decision-journal)
9. [Configuration](#configuration)
10. [Code map](#code-map)
11. [Operator commands](#operator-commands)
12. [Testing, replay and evidence rules](#testing-replay-and-evidence-rules)
13. [Deployment](#deployment)
14. [Version history (one line each)](#version-history-one-line-each)
15. [Known limitations and open items](#known-limitations-and-open-items)
16. [Glossary](#glossary)

---

## Status snapshot (2026-09-14)

| Item | Value |
|---|---|
| Version | **v8.2** — dip entry (see CHANGELOG) |
| Mode | `TRADING_MODE=live` |
| Server | `ubuntu@130.110.113.198`, directory `~/etoro-v2-short`, Node 20.20.2, ~1 GB RAM |
| Process | PM2 name **`etoro-daytrade`** (same server also runs `etoro-ai-short`, a different bot and portfolio) |
| Agent portfolio | `DT_CAPITAL=10000` (bot dollars) |
| Real account copying it | `DT_REAL_ACCOUNT_CAPITAL=350` → copy ratio 0.035. Telegram shows real dollars; logs, journal and trade history are **bot dollars** |
| Risk per trade | 0.5% of effective capital (`DT_RISK_PCT_DAY=0.005`, halved in v8.1) |
| Capital | ≈ $9,368 effective, drawdown peak $10,032.85 (as of 2026-09-13) |
| Track record | 210 closed trades to 2026-09-11; whole-trade P&L ≈ +$153 (bot dollars, partial profits included). Jul 1–Aug 21 profitable; Aug 22–Sep 11 lost (49 trades, 43% win, −$393) |
| Current experiment | **Two-week live review of dip entry** started 2026-09-14. Do not change entry or exit settings before reviewing `DIP_ENTRY` journal records (see [what to review](#the-two-week-dip-entry-review)) |
| Git | Branch `audit-v8-fixes`; v8 and v8.1 committed; v8.2 deployed but not yet committed |

Other eToro bots the owner runs (do not confuse them):

- **etoro-ai-short** — PM2 `etoro-ai-short`, same server, different agent portfolio.
- **etoro-v2** — long-term portfolio bot, PM2 `etoro-bot` on `ubuntu@79.72.1.221`.
  Symbols such as DE/TSM "cannot trim" belong to that bot, not this one.

---

## For AI agents — read this first

These rules come from real incidents and from explicit owner instructions.

### Owner's working preferences

1. **Always update `CHANGELOG.md`** for every change — code, settings,
   deployments, data repairs, even reverted experiments. Newest entry at the top.
   Format: `## YYYY-MM-DD — vX.Y · short title`, then *what the logs showed*,
   *what changed*, *evidence*, *settings*. Keep corrections visible; never
   silently rewrite an old entry.
2. **Update this README** when behaviour, settings, files, commands or the
   status snapshot change.
3. **Plain language to the owner.** Dollars, win rates, "early period / recent
   period". Avoid jargon (R-multiples, OOS, bootstrap) in messages to the owner;
   the jargon belongs in code comments and the CHANGELOG.
4. **Keep the bot trading live** and improve it from its own logs. Do not answer
   with "pause trading" as the main recommendation.
5. **Change existing files.** Do not add new research tools, modules or concepts
   unless they are clearly needed; tests go into existing test files.
6. The owner's concept is fixed: **spot a stock going up → buy → take profit /
   stop loss**, short-term. Improvements should serve that concept.

### Technical rules

1. **`.env` silently overrides `src/config.js` defaults.** Editing a default does
   nothing if the key exists in `.env`. If a change "does nothing", check `.env`
   first (hit twice on 2026-08-28). The server `.env` is the source of truth for
   live values.
2. **Confirm which bot** a request is about before editing (three eToro bots
   exist, see above).
3. **Evidence before thresholds.** Do not tune entry/exit numbers from a handful
   of trades. Use `src/replay-exits.js` (or `src/replay-harness.js`), split the
   data into an early and a late period, and require the effect in **both**.
4. **Look-ahead trap.** Replays must use only completed bars (bar start +
   duration ≤ decision time). An apparent "range position" entry edge in the v8
   audit was caused by an hourly bar that ended after the entry. On a dip entry's
   fill bar, the bar's high must not count as profit (it may have printed before
   the dip).
5. **Run heavy replays on a workstation**, not the 1 GB server. Copy
   `data/journal`, `data/trade-history.json`, `data/replay-candles` and
   `data/replay-cache` down first.
6. **Node 20 vs 22.** Production runs Node 20, where `hour12:false` formats
   midnight as hour 24. Time code must go through `src/market-hours.js`
   (`hourCycle: "h23"`). Bugs like this are invisible on a Node 22 laptop.
7. **Position meta has many writers** (scan, 1-minute exit tick, price stream,
   daily AI reviewer, EOD closer, the manual `close-position.js`). Every write
   must run inside `withPositionLock()` from `src/position-lock.js` (in-process
   queue plus the cross-process lock file `data/position-meta.lock`).
8. **P&L accounting.** A partial sell realizes cash immediately. A trade's result
   is `performance.tradeResultDollars(trade)`: v8+ records (`pnlAccountingVersion: 2`)
   store the whole trade; older records add `estimatedPartialPnlDollars`. Never
   sum raw `pnlDollars` for statistics.
9. **Never commit or print secrets.** `.env` and `data/` are git-ignored. Do not
   copy `.env` values into docs, logs or chat.
10. **Test and back up before every deploy**; see [Deployment](#deployment).
    Only restart when no deploy test failed.
11. **Trading actions are the owner's.** Do not place, close or resize real
    positions without the owner's explicit instruction.

---

## How the bot trades (plain language)

### 1. Every 10 minutes: look for stocks going up

A scan runs every `DT_SCAN_INTERVAL_MINUTES` (10) on weekdays, whenever eToro's
24/5 session is open. Each scan:

1. **Manages open positions first** (exits are never blocked by anything).
2. **Reconciles capital** against the real eToro equity.
3. **Checks the entry gates** (any one stops new buys; exits keep running):
   halt flag or drawdown breaker, daily loss limit, session timing, the Friday
   and end-of-day cutoffs, and SPY data available (fail-closed).
4. **Gets prices** for the watchlist (`watchlist-daytrade.json`, 54 stocks) plus
   stocks found by **discovery** (Yahoo "day gainers / most active" screens,
   minimum price $10, liquidity floor $15M/day; a first-time discovered stock
   trades half size).
5. **Quick filter:** only stocks already up at least **1%** today, not held, not
   on cooldown, not blocked by the ethics filter (no gambling, alcohol or adult
   industry), with a fresh quote (≤ 15 minutes old).
6. **Momentum checks** on 5-minute bars plus the daily ATR:
   - price **above VWAP** (the day's volume-weighted average price);
   - **relative strength vs SPY** at least +0.5%;
   - **RSI** between 55 and 78 (strong, not overheated);
   - **volume** ≥ 1.5× normal;
   - a setup: `GAP_AND_GO`, `BREAKOUT` or `MOMENTUM_SURGE` (the last one does
     ~99% of trades);
   - daily **ATR ≤ 7%** (very wild stocks are skipped).
7. **Score out of 100.** Only **80+** passes (`DT_MIN_ENTRY_SCORE`). A choppy
   market (CHOP regime) costs 15 points. At most 12 candidates continue.
8. **Trade plan** (`trade-planner.js`): stop distance = 1.0 × daily ATR clamped to
   1–5%, Target 1 at +1× the stop distance (sell half), Target 2 at +2×, size so
   that hitting the stop loses 0.5% of capital (max 35% of capital per position;
   high-volatility stocks ×0.7).
9. **AI check** (`ai-screener.js`, Claude Haiku 4.5, acting as a risk officer):
   one TAKE/SKIP verdict per plan with a market brief (SPY, VIX, sectors,
   breadth, today's P&L). The AI never sets prices. A TAKE below confidence 4 is
   downgraded to SKIP. Identical plans within 30 minutes reuse the verdict.

### 2. Dip entry: buy the pullback, not the spike (v8.2)

An AI-approved stock is **not bought immediately**. It becomes a waiting order:

- **Buy price** = approval price − 1 × stop distance
  (`DT_DIP_ENTRY_DEPTH_OF_STOP=1.0`).
- It waits up to **120 minutes** (`DT_DIP_ENTRY_WINDOW_MINUTES`) and is checked
  every minute with one batched quote call for all waiting stocks.
- If the ask price reaches the buy price, it buys there. Stop and targets move
  down by the same percentage, so size and dollar risk are unchanged.
- **No dip in time → no trade.**
- **Cancelled** if the price falls a further full stop distance (a breakdown,
  not a dip), or if a new-entry gate closes while it waits (Friday/EOD cutoff,
  loss limit, halt, overnight freeze), or if the bot is stopped/restarted.
- A stock with a waiting order is not re-planned or re-sent to the AI.
- `DT_DIP_ENTRY_ENABLED=false` restores the old "buy immediately" behaviour.

Why: the score is highest right after a spike, so buying at approval meant buying
the top of a push. In replay (Jul 1–Sep 11, 2,055 candidates) buying at once lost
in both periods; the dip version was positive in both but buys only about 1 in 7
approved stocks. Full table in CHANGELOG v8.2.

Waiting orders live **in memory** only; a restart journals them as cancelled and
the next scan re-approves anything still valid.

### 3. Opening the position

`tryOpenPosition()` re-checks at execution time: already held, cooldown, day
slots (7), gross exposure (90% of capital), ethics, earnings blackout (no DAY
entry with earnings today/tomorrow; needs Finnhub), pre-trade safety (cash,
sector bucket max 2, liquidity), and a live **spread guard** (≤ 1%). Then it
places a market buy through the eToro API, reads back the **actual fill**, saves
the position to `data/position-meta.json`, journals `TRADE_OPENED` and sends the
Telegram OPEN message.

---

## How a position is managed and closed

Every minute (`runExitMonitorTick`), plus immediately when the eToro WebSocket
price stream sees a tick cross a position's stop, the bot reads the portfolio,
syncs its records with eToro (real invested amount and fill price; geometry is
rescaled if the fill differs), and runs `risk-manager.decidePositionAction()`.

| Exit reason | Plain meaning |
|---|---|
| `STOP_LOSS` | Price hit the stop. A shallow poke (within 0.5% below) must persist 2 minutes; a deep break exits at once. |
| partial at Target 1 | At +1× stop distance, sell half (`DT_PARTIAL_EXIT_FRACTION=0.5`). |
| `MFE_GIVEBACK` | Profit protection: once the best gain reaches 0.25 × ATR, the trade may give back at most 40% of its best gain (capped at 0.3 × ATR), never below breakeven. The biggest winner category. |
| `TRAILING_STOP` | After the partial, the rest trails 2.5% below the peak, never below entry. |
| `PROFIT_STALL_LOCK` | In profit ≥ 0.4% but no new high for 45 minutes → sell half, unless the short trend still points up. |
| `TIME_EXIT_STALE` | The trade went nowhere within its time budget: 150 minutes of **session** time (`DT_MAX_HOLD_MINUTES`), ×1.5 for calm stocks, ×0.7 for volatile ones, with one 45-minute grace period if it is visibly recovering. |
| `EOD_FORCE_CLOSE` | Mon–Thu, 15 minutes before the US close: **losing/flat DAY positions close; winners are kept overnight** (24/5 keep-winners mode). |
| `FRIDAY_FORCE_CLOSE` | Friday: **everything closes** — no weekend exposure. |
| `AI_REVIEW_CLOSE` | Daily AI reviewer (Mon–Thu 15:00 ET, Claude Haiku 4.5) chose CLOSE. It can also EXTEND (DAY→SWING), HOLD, TIGHTEN the stop or TAKE_PARTIAL, each behind a confidence floor enforced in code. |
| `MANUAL_CLOSE` | Closed with `src/close-position.js`. |
| `GHOST_POSITION` | The bot's record had no matching eToro position; the record was cleared. |

Swing trades exist in the code (`SWING_TRAIL`, `SWING_TIME_EXIT`) but are paused
(`DT_MAX_SWING_POSITIONS=0`).

Positions eToro shows that the bot has no record of raise an
`UNTRACKED_POSITION` alert. They are re-adopted automatically if the bot recently
cleared them, otherwise left alone unless `DT_ADOPT_FOREIGN_POSITIONS=true`.

---

## Safety controls

| Control | Setting (live) | Effect |
|---|---|---|
| Risk per trade | 0.5% | Dollar loss if the stop is hit |
| Max per position | 35% of capital | Size cap |
| Day slots | 7 | Max open DAY positions |
| Gross exposure | 90% of capital | Cap on everything open combined |
| Daily loss limit | 5% | No new entries for the rest of the day |
| De-risk | after 2 losing days, size ×0.5 | Automatic |
| Drawdown breaker | 15% below peak | Writes `data/halt.flag`; **no new entries until a human deletes it** (exits continue) |
| Manual kill switch | create `data/halt.flag` | Same as above |
| Cooldown | 30 min after any exit; ×2 after a loss | Re-entry after a loss also needs a score +15 higher (capped at 90, expires after 120 h) |
| Overnight freeze | 00:00–04:00 ET | No scans (cost and liquidity); exits keep running |
| Overnight dead zone | 00:00–04:00 ET | No new entries |
| Entry cutoffs | last 30 min before the Mon–Thu force-close and Friday's | No new entries; nothing after Friday's close |
| Pre-open blackout | 60 min before to 30 min after the open, only when SPY is weak | No new entries |
| Stale quote | > 15 min old | Candidate dropped |
| Spread guard | > 1% | Entry blocked |
| Earnings blackout | earnings today/tomorrow (Finnhub) | Entry blocked |
| Ethics filter | static blocklist + Finnhub industry | Never buys gambling, alcohol, adult industry |
| Capital reconciliation | 1% tolerance | Ledger corrected to real equity; unexplained gaps alert `UNEXPLAINED_EQUITY_CHANGE`; large persistent gaps are treated as owner deposits/withdrawals |
| System alerts | throttled 30 min | Telegram alert when eToro, SPY data, the AI, discovery, the scan or the exit monitor fail, plus a recovery notice |

---

## Schedule

All schedules run on New York time (`America/New_York`); logs print **Bahrain
time**.

| Cron (ET) | Job |
|---|---|
| every 10 min, Mon–Fri | Scan for new entries (`runScanCycle`) |
| every minute, Mon–Fri | Exit monitor + dip-order check (`runExitMonitorTick`) |
| 15:00 Mon–Thu | Daily AI position review |
| 15:45 Mon–Fri | EOD close (Mon–Thu keep winners; Friday close all) + daily stats to Telegram |
| 15:50 Friday | Weekly self-evaluation report to Telegram |
| 05:15 UTC Tue–Sat (server crontab) | `src/fetch-replay-candles.js` saves 1d/1h/15m/5m candles for replays |

eToro's 24/5 session runs Sunday 20:00 ET to Friday 20:00 ET. US market holidays
are in `src/market-hours.js`.

---

## Telegram messages

Money in Telegram is shown in **real-account dollars** (and bot dollars where
useful for reconciling with logs).

| Message | When |
|---|---|
| ⏳ **Waiting to buy on a dip** | A scan approved stocks; one grouped message listing approval price → buy price |
| 🟢 **OPEN** | A buy filled; includes setup, entry, stop, targets, size, risk, AI reasoning, and "📉 Bought on a dip: approved $X, bought $Y after N min" |
| **Dip orders — not bought** | Grouped: ⌛ no dip in time (lowest price, where it is now), ✋ cancelled (reason), 🚫 dipped but the buy was blocked (exact reason) |
| Partial / exit messages | Partial sells and closes with the reason and P&L |
| 📊 **Day-Trade Performance** | After the EOD close: win rate, average win/loss, profit factor, total, eras before/after the v8 accounting fix, and "📉 Dip orders today: N approved · N bought · N not bought" |
| Weekly self-evaluation | Friday: patterns and suggestions (never applied automatically) |
| 🛑 Drawdown breaker, alerts | `UNTRACKED_POSITION`, `FILL_MISMATCH`, `POSITION_AMOUNT_DRIFT`, `UNEXPLAINED_EQUITY_CHANGE`, `ETORO_PORTFOLIO`, `ETORO_OPEN`, `SCAN_CYCLE`, `EXIT_MONITOR`, owner-transfer notices, queued-order notices |

Telegram is send-only; there are no chat commands.

---

## Data, logs and the decision journal

Everything below `data/` is runtime state (git-ignored). Back it up before any
repair.

| Path | Contents |
|---|---|
| `data/position-meta.json` | Open positions the bot manages: entry, stop, targets, peak/trough, partial fills, full plan (incl. `plan.dipEntry`) |
| `data/position-meta.lock` | Cross-process lock file (auto-removed; a dead holder is taken over) |
| `data/trade-history.json` | Every closed trade (whole-trade P&L since v8, `pnlAccountingVersion: 2`) |
| `data/capital-ledger.json` | Base capital, realized P&L, drawdown peak, repair history |
| `data/daily-loss-tracker.json` | Today's realized P&L for the loss limit / de-risking |
| `data/trade-cooldowns.json` | Cooldowns and re-entry penalties |
| `data/exit-shadows.json` | What prices did after time-based exits (observation only) |
| `data/cleared-positions.json` | Recently ghost-cleared positions (for re-adoption) |
| `data/discovered-history.json` | Discovered symbols already traded (first trade half size) |
| `data/finnhub-profile-cache.json` | Industry lookups for the ethics filter |
| `data/vix-override.json` | Manual VIX value with expiry |
| `data/halt.flag` | Present = new entries halted |
| `data/journal/decisions-YYYY-MM-DD.jsonl` | **Decision journal**, one JSON event per line, one file per New York date. Kept since 2026-07-06 |
| `data/replay-candles/SYMBOL.json` | Accumulating candles (1d 400 days, 1h 180, 15m 90, 5m 45) for replays |
| `data/replay-cache/` | Legacy hourly candles used by the replay tools |
| `logs/agent.log`, `logs/errors.log` | Winston logs (rotated) |
| `~/.pm2/logs/etoro-daytrade-out.log` / `-error.log` | PM2 stdout/stderr (pm2-logrotate) |
| `logs/replay-candles.log` | Daily candle capture output |

### Journal events

Every event has `ts` (UTC ISO), `bahrainTime` and `event`.

| Event | Meaning |
|---|---|
| `SCAN_START`, `SCAN_SKIPPED` | Scan began / skipped (market closed, freeze, adaptive CHOP skip) |
| `GATE_BLOCK` | An entry gate stopped the scan |
| `DISCOVERY_RESULT` | Discovery output |
| `CANDIDATE_REJECTED` | Stage + reason + snapshot for each rejected candidate |
| `CANDIDATE_SCORED` | Scored candidate with features |
| `PLAN_BUILT`, `PLAN_REJECTED` | Trade plan accepted / rejected (e.g. score floor) |
| `AI_DECISION` | Screener TAKE/SKIP, confidence, reasoning, structured analysis |
| `SHADOW_SIGNAL` | (v8.1) One per candidate per scan: price, quote time, % up, ATR, move/ATR, score, RSI, RS, VWAP distance, day range position, volume ratio, regime, stop distance, and final **outcome** (NOT_SHORTLISTED, PLAN_REJECTED, AI_SKIP, DIP_ARMED, DIP_PENDING, OPENED, BLOCKED, …) |
| `DIP_ENTRY` | (v8.2) Dip order status `ARMED` → `FILLED` / `BLOCKED_AT_FILL` / `EXPIRED` / `CANCELLED`, with signal/buy/breakdown prices, lowest/highest/last price, `deepestDipOfStop`, `moveFromSignalPct`, minutes waited, `quoteMisses`, `checkFailures`, block reason, and an `approval` snapshot (% up, move/ATR, RSI, RS, VWAP, setup, catalyst, regime, SPY, AI confidence) |
| `TRADE_OPENED` | Full plan at open |
| `EXIT_DECISION` | PARTIAL / EXIT decisions with reason and price |
| `TRADE_CLOSED` | Whole-trade P&L, partial P&L, exit reason, plan |
| `POSITION_STATUS` | (v8) Every 10 ticks per open position: HOLD / TRIM / RUNNER / WEAKENING / EXIT, P&L, peak, effective stop, next trigger |
| `SCAN_FUNNEL` | (v8) Counts per stage: quoted → moving → eligible → scored → plans → AI take → waiting for a dip → opened, with reasons |
| `EQUITY_DRIFT` | (v8.1) Realized equity vs ledger when the gap ≥ $25 |
| `EXIT_SHADOW_CHECKPOINT` | Price after a time-based exit at +30/60/120 min |
| `EOD_SUMMARY` | Daily stats and dip-order counts |
| `ERROR` | Errors, e.g. `DIP_ENTRY_CHECK`, `SCAN`, `OPEN:SYMBOL` |

---

## Configuration

`src/config.js` is the single source of truth for defaults, with the evidence for
most numbers in comments. **`.env` overrides defaults** (see the rule above).
Some keys are read directly from the environment by their module:
`DT_TELEGRAM_BOT_TOKEN`, `DT_TELEGRAM_CHAT_ID`, `DT_RUN_ON_STARTUP`,
`DT_OVERNIGHT_FREEZE_*`, `DT_SWING_ENTRY_DAYS`.

### Secrets (names only — values live in `.env`, never in git or docs)

`ETORO_PUBLIC_API_KEY`, `ETORO_AGENT_USER_KEY` (eToro API), `ANTHROPIC_API_KEY`
(Claude), `DT_TELEGRAM_BOT_TOKEN`, `DT_TELEGRAM_CHAT_ID`, `TWELVE_DATA_API_KEY`
(fallback quotes), `FINNHUB_API_KEY` (earnings, industry), `FMP_API_KEY`
(catalyst feed — currently 403, see open items), `FRED_API_KEY` (VIX, macro),
`SEC_EDGAR_USER_AGENT`, `ALPACA_API_KEY_ID`, `ALPACA_SECRET_KEY` (optional
stream), plus `TRADING_MODE`, `LOG_LEVEL`, `MINIMUM_POSITION_DOLLARS`.

`package.json` still lists OpenAI and Gemini SDKs from an earlier multi-model
design; the running bot uses **Claude Haiku 4.5 only** (screener and reviewer).

### Key live settings (server `.env` + defaults, 2026-09-14)

| Area | Key | Live value |
|---|---|---|
| Capital | `DT_CAPITAL` / `DT_REAL_ACCOUNT_CAPITAL` | 10000 / 350 |
| Risk | `DT_RISK_PCT_DAY` | 0.005 |
| Size | `DT_MAX_POSITION_PCT_DAY`, `DT_MAX_TOTAL_EXPOSURE_PCT` | 0.35, 0.9 (default) |
| Slots | `DT_MAX_DAY_POSITIONS` / `DT_MAX_SWING_POSITIONS` | 7 / 0 |
| Stop | `DT_DAY_ATR_STOP_MULT`, `DT_DAY_STOP_MIN_PCT`, `DT_DAY_STOP_MAX_PCT` | 1.0, 0.01, 0.05 |
| Dip entry | `DT_DIP_ENTRY_ENABLED`, `DT_DIP_ENTRY_DEPTH_OF_STOP`, `DT_DIP_ENTRY_WINDOW_MINUTES` | true, 1.0, 120 (defaults) |
| Take profit | `DT_PARTIAL_EXIT_FRACTION`, `DT_TRAILING_STOP_PCT` | 0.5, 0.025 |
| Profit protection | `DT_MFE_ARM_ATR_FRACTION`, `DT_MFE_RETENTION`, `DT_MFE_GIVEBACK_ATR_CAP` | 0.25, 0.6, 0.3 (defaults) |
| Time | `DT_MAX_HOLD_MINUTES`, `DT_SESSION_AWARE_TIME_BUDGETS` | 150, true |
| Entry quality | `DT_MIN_ENTRY_SCORE`, `DT_MAX_ENTRY_ATR_PCT`, `DT_PREFILTER_MIN_MOVE_PCT` | 80, 7.0, 1.0 (defaults) |
| Momentum | `DT_RSI_MOMENTUM_MIN`/`MAX`, `DT_MIN_VOLUME_RATIO`, `DT_MIN_RS_VS_SPY_PCT` | 55/78, 1.5, 0.5 |
| Market filter | `DT_SPY_MIN_CHANGE_PCT`, `DT_REQUIRE_ABOVE_VWAP` | −1.0, true |
| Sessions | `DT_TRADE_24_5`, `DT_HOLD_24_5_OVERNIGHT`, `DT_ALLOW_PREMARKET` | true, true, true |
| Close rules | `DT_FRIDAY_CLOSE_ALL`, `DT_FORCE_CLOSE_MINUTES_BEFORE_CLOSE` | true, 15 |
| Freeze | `DT_OVERNIGHT_FREEZE_*` | 00:00–04:00 America/New_York |
| Discovery | `DT_DISCOVERY_ENABLED`, `DT_DISCOVERY_MIN_PRICE`, `DT_MIN_AVG_DOLLAR_VOLUME` | true, 10, 15000000 |
| Breakers | `DT_DAILY_LOSS_LIMIT_PCT`, `DT_MAX_DRAWDOWN_FROM_PEAK_PCT` | 0.05, 0.15 |
| AI | `DT_REVIEWER_ENABLED`, `DT_SCREENER_MIN_CONF_TAKE`, `DT_SCREENER_DEDUPE_MINUTES` | true, 4, 30 |

To see the real live values: `ssh` to the server and
`grep -E "^DT_" ~/etoro-v2-short/.env` (this prints the Telegram token too — do not
paste the output anywhere).

---

## Code map

```
src/
  index.js                  Orchestrator: schedules, scan cycle, dip orders, opening
                            positions, 1-minute exit monitor, reconciliation (ghost,
                            untracked, duplicate positions), daily AI review, EOD, Telegram
  config.js                 All defaults + the evidence behind them
  etoro-client.js           eToro agent-portfolio API: portfolio, instrument search
                            (exact-symbol match; some stocks only resolve as SYMBOL.US),
                            open/close orders, duplicate detection
  etoro-price-stream.js     eToro WebSocket watchdog: triggers an immediate exit check
  market-data.js            Quotes, 5m enrichment (VWAP/RSI/high/low), daily ATR, SPY
  market-data-stream.js     Optional Alpaca stream
  market-hours.js           ET clock (Node 20 safe), 24/5 session, holidays, freeze, Bahrain time
  position-lock.js          withPositionLock(): in-process queue + data/position-meta.lock
  logger.js                 Winston logger (Bahrain timestamps)
  data-sources/
    etoro-market-data.js    Batched rates, closing prices, candles (≤ 1,000 bars/request), ATR/RSI/VWAP math
    finnhub.js              Earnings calendar, company industry
    fmp.js                  Analyst catalyst feed (403 on the current key)
    fred.js                 VIX and macro series
    sec-edgar.js            SEC filings helper
  discovery/market-discovery.js  Yahoo screeners → discovered candidates
  models/
    ai-screener.js          Entry TAKE/SKIP (Claude Haiku 4.5), dedupe cache
    ai-position-reviewer.js Daily EXTEND/HOLD/TIGHTEN/TAKE_PARTIAL/CLOSE (Claude Haiku 4.5)
  strategies/
    momentum-scanner.js     Pre-filter + scoring (GAP_AND_GO, BREAKOUT, MOMENTUM_SURGE)
    trade-planner.js        Plan geometry, sizing, Telegram OPEN text, dip-order helpers
    risk-manager.js         Exit decisions, MFE giveback, stall lock, time budgets,
                            daily loss limit, pre-trade safety, position status
    session-timing.js       Session rules, Friday/EOD entry cutoffs
    eod-closer.js           Mon–Thu keep-winners close, Friday close-all
    capital-manager.js      Ledger, compounding, de-risking, drawdown breaker,
                            live-equity reconciliation, transfers, peak reset
    performance-tracker.js  Closed-trade records (whole-trade P&L), stats, Telegram stats
    decision-journal.js     The JSONL decision journal (all event types)
    shadow-signals.js       SHADOW_SIGNAL records per candidate
    cooldown-tracker.js     Cooldowns and loss re-entry justification
    exit-shadow-tracker.js  Observation after time-based exits
    market-regime.js        TRENDING / CHOP / UNKNOWN from SPY range (+ VIX)
    market-context.js       Market brief for both AI prompts
    sector-map.js, sector-rotation.js  Sector buckets and rotation bonus
    ethics-filter.js        Excluded industries
    self-evaluation.js      Weekly report with suggestions
  notifications/
    telegram.js             Send messages
    alerts.js               Throttled system alerts + recovery notices
    format-helpers.js       Real vs bot dollars, exit-reason text, HTML escaping

  close-position.js         Manual close with full bookkeeping (dry run by default)
  portfolio-check.js        Read-only: eToro account vs bot records
  capital-adjust.js         Declare a deposit/withdrawal
  capital-repair.js         Undo a phantom transfer; lower an inflated drawdown peak
  backfill-partial-pnl.js   One-off: estimated partial P&L for pre-v8 trades (applied 2026-09-13)
  vix-override.js           Manual VIX with auto-expiry
  replay-exits.js           Exit/entry replay on real and journal entries (v8+, see below)
  replay-harness.js         Older entry-filter replay on hourly candles
  fetch-replay-candles.js   Daily candle capture (cron)

test/run-tests.js           Zero-dependency test runner (all suites)
test/*.test.js              Suites per version (v6 … v8.1; v8.2 dip tests live in audit-followups-v8-1)
watchlist-daytrade.json     Watchlist: symbol, sector bucket, 'night' = 24/5 eligible
docs/ai-prompt-review-2026-07-25.md  Review of the AI prompts (v7 rewrite)
commands.txt                Owner's scratch list of ssh/scp/pm2 commands
test-0 … test-4-*.js, diagnose.js, check-portfolio.js, log-to-file.js
                            Early eToro API probes from July 2026 (not part of the bot)
```

---

## Operator commands

Run on the server from `~/etoro-v2-short` unless noted.

```bash
# Process
pm2 status
pm2 logs etoro-daytrade --lines 200
pm2 restart etoro-daytrade

# Account and positions (read-only)
node src/portfolio-check.js
node src/close-position.js --list

# Manual close (dry run unless --confirm)
node src/close-position.js RIVN
node src/close-position.js RIVN --confirm
node src/close-position.js RIVN --fraction 0.5 --confirm
node src/close-position.js --all --confirm

# Halt / resume new entries (exits keep running)
touch data/halt.flag
rm data/halt.flag

# Money moved in or out of the eToro account
node src/capital-adjust.js --status
node src/capital-adjust.js -3000 "withdrawal note"
node src/capital-adjust.js +500 "deposit note"

# Capital repairs (dry run unless --apply)
node src/capital-repair.js
node src/capital-repair.js --reset-peak 10032.85 --reason "why" --apply

# VIX override (expires automatically)
node src/vix-override.js 28.5 "CPI day"
node src/vix-override.js --status
node src/vix-override.js --clear

# Journal questions
grep -h '"event":"DIP_ENTRY"' data/journal/decisions-2026-09-*.jsonl | tail
grep -h '"event":"SCAN_FUNNEL"' data/journal/decisions-$(TZ=America/New_York date +%F).jsonl | tail -3
```

To turn dip entry off: set `DT_DIP_ENTRY_ENABLED=false` in the server `.env`, then
`pm2 restart etoro-daytrade --update-env`.

---

## Testing, replay and evidence rules

```bash
npm test                      # node test/run-tests.js — all suites must pass (389 as of v8.2)
```

### Replay tools (run on a workstation with a copy of server data)

```bash
node src/replay-exits.js --env server-values.env \
  --data-dir snap/data --candles snap/data/replay-candles \
  --legacy-candles snap/data/replay-cache --split 2026-08-22 \
  --set both --variants CURRENT,DIP_100_120M
```

- Sets: `trades` (real closed trades), `extended` (taken + AI-skipped +
  score-floor-rejected plans), `shadow` (SHADOW_SIGNAL records), `both`, `all`.
- The **real exit engine** (`risk-manager`) runs under a virtual clock on the
  finest bars available (5m, else 15m, else 1h); intrabar order is pessimistic;
  10 bps round-trip cost; EOD rules applied.
- Variants: stop widths, T1 placement, giveback, early-failure exits, add-on,
  and `DIP_*` entry variants (reports fills and result per approved signal).
- Calibration against live results (206 trades): simulated mean −0.004R vs
  actual +0.009R, same sign 86%.
- `--env` must be a file with **only non-secret `DT_` values**.

### Evidence rules (learned the hard way)

1. Split history into an early and a late period (the default split is
   2026-08-22); an effect must hold in **both**.
2. Prefer changes whose effect is monotonic (e.g. stop width 0.5→0.75→1.0→1.25 ATR).
3. Watch the look-ahead trap (see agent rules).
4. The v8 audit found the momentum entry itself had little edge; exits and
   entry timing matter most. The v8.2 dip evidence is still a small sample
   (65 recent candidate fills), which is why it is under live review.
5. Record the evidence in `config.js` comments and the CHANGELOG.

### The two-week dip-entry review

Planned after ~2026-09-28. Questions and where the answers are:

| Question | Data |
|---|---|
| How many approvals, buys, expiries, cancels, blocks; how did dip buys do? | `DIP_ENTRY` + `TRADE_CLOSED` (dip trades carry `plan.dipEntry`) |
| Is the dip too deep (too few buys)? | `deepestDipOfStop` on EXPIRED orders — a smaller depth would have filled every order at or above that value |
| How far did missed "rockets" run? | `highestPrice`, `moveFromSignalPct`, then `data/replay-candles/SYMBOL.json` 5m bars after the window |
| What did rockets look like at approval? | `DIP_ENTRY.approval` (and `SHADOW_SIGNAL`) |
| Would "buy a third now, rest on the dip" or a rocket exception earn more? | Replay with `replay-exits.js` on the new data, both periods |
| Any data gaps? | `quoteMisses`, `checkFailures`, `ERROR DIP_ENTRY_CHECK`, CANCELLED "bot stopped or restarted" |

---

## Deployment

The owner deploys from a Windows laptop (`C:\Users\dawoo\Desktop\etoro-v2-short`)
with `scp`; SSH key `~/Downloads/ssh-key-2026-07-02.key`. Procedure used for v8+:

1. `npm test` locally — must be all green.
2. Package only the changed files: `tar czf deploy.tgz <files>`.
3. `scp` it to `~/etoro-audit/` on the server.
4. On the server: back up the same files
   (`tar czf ~/etoro-audit/backup-pre-<version>-<timestamp>.tgz <files>`), check
   `data/position-meta.json` for open positions, extract the new files.
5. `node test/run-tests.js` on the server. **If anything fails, restore the backup
   and do not restart.**
6. `pm2 restart etoro-daytrade --update-env`; confirm the startup lines
   (capital, risk, "🎯 Dip entry ON") and an empty error log.
7. Update `CHANGELOG.md` and this README.

A restart is safe with open positions (they reload from `data/position-meta.json`);
waiting dip orders are journaled as cancelled and re-approved by the next scan.
Settings-only changes need `.env` edited on the server plus a restart with
`--update-env`.

Backups on the server: `~/etoro-audit/backup-pre-v8-*.tgz`, `backup-pre-v81-*`,
`backup-pre-v82-*`, `backup-pre-v82b-*`, `backup-pre-v82c-*`.

---

## Version history (one line each)

Details for every line: `CHANGELOG.md`.

| Date | Version | Summary |
|---|---|---|
| 2026-07-04 | v5 | Scanner circular-require fix (entry pipeline was dead), duplicate-position guard, drawdown breaker + halt flag, earnings blackout, daily AI reviewer, system alerts |
| 2026-07 | v5.4–v5.7 | eToro market data replaces Twelve Data; hardcoded instrument IDs removed (AMD had been trading Micron); fill verification |
| 2026-07-21 | v6 | Recovery-aware time exits, profit-stall lock, volatility time budgets, ghost positions, loss-aware cooldown, live equity reconciliation, WebSocket exit watchdog |
| 2026-07-25 | v7 | AI decision-layer rewrite: market brief, reasoning-before-verdict prompts, reviewer TAKE_PARTIAL/CLOSE |
| 2026-07-27 | v7.1–v7.3 | Node 20 hour-24 bug, execution-time slot cap, gross exposure cap, self-healing position sync, phantom-withdrawal fix |
| 2026-08-06 | v7.4–v7.6 | Score ≥ 80 gate, overnight dead zone, VXX volatility read, Bahrain log time, Telegram real dollars |
| 2026-08-28 | v7.7–v7.9 | ATR ceiling 7%, liquidity floor $15M, move-gate revert, entry instrumentation, replay harness |
| 2026-09-01/02 | v7.10–v7.13 | Freeze anchored to ET, pipeline unblocked, re-entry penalty expiry (half the watchlist was locked out), manual VIX override |
| 2026-09-12 | v8 | Full audit: partial P&L missing from records, exit monitor blind during scans, position-meta races (lock), reconciliation double count, Friday post-close entries, stale quotes, UTC bar filter, scan funnel + position status, **stop widened to 1.0 ATR** |
| 2026-09-13 | v8.1 | Cross-process lock for manual closes, equity drift trail/alert, partial P&L backfill (+$1,008 across 57 trades), drawdown peak repair, shadow signals, daily candle capture, **risk halved to 0.5%** |
| 2026-09-13 | v8.2 | **Dip entry**, Telegram dip messages, complete dip logging for the two-week review |
| 2026-09-14 | docs | README rewritten for humans and AI agents |

---

## Known limitations and open items

- **Entry edge is unproven.** Before v8.2 the entry signal had little forward edge;
  dip entry is the current attempt and is under live review.
- **Missed rockets.** Dip entry skips stocks that rise without a pullback. Options
  to evaluate after the review: buy a third immediately and the rest on the dip,
  a rocket exception, or a smaller dip for top scores.
- **Long-only.** No hedging or shorting; the bot can only avoid a falling market.
- **One setup dominates.** `MOMENTUM_SURGE` does ~99% of trades.
- **Discovery quality.** A "% gainers" screen surfaces low-quality spikes;
  there is no fundamentals feed.
- **FMP catalyst feed returns 403**, so catalyst-based swing overrides are inactive.
- **Unexplained equity change** of ~$506 after 2026-07-22 was never matched to
  trades; it needs the owner's eToro closed-position export.
- **Fill read-back** is not always possible immediately after an order.
- **Research data**: ~4 years of daily bars for 214 symbols are on the server in
  `~/etoro-audit/daily-history/` (a daily-bar study found breakouts worse than
  random entries; that research tool was removed from the repo).

---

## Glossary

| Term | Meaning |
|---|---|
| Agent portfolio | The eToro portfolio the bot trades through the API ($10k); the owner's real account copies it at 3.5% |
| Bot dollars / real dollars | Logs use agent-portfolio dollars; Telegram converts to the real account |
| ATR | Average True Range: a stock's normal daily price range, as % of price |
| Stop distance | How far below entry the stop sits (1 × ATR, clamped 1–5%) |
| R | Result divided by the dollar risk (1R = the amount lost at the stop) |
| VWAP | Volume-weighted average price for the day |
| RSI | Momentum oscillator (0–100) |
| RS vs SPY | Stock's % change minus SPY's |
| MFE / MAE | Best / worst unrealized move while a trade was open |
| T1 / T2 | Take-profit targets at +1× / +2× the stop distance |
| Dip order | An approved stock waiting to be bought on a pullback |
| CHOP / TRENDING | Market regime from SPY's projected daily range |
| 24/5 | eToro trading of eligible US stocks Sunday 20:00 ET to Friday 20:00 ET |
| Ghost / untracked position | Bot record without an eToro position / eToro position without a bot record |
| Early / recent period | Replay split at 2026-08-22: the first period designs, the second checks |
