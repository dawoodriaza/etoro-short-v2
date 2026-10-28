# Change log — v7.x / v8.x series

Newest first. **Every change gets an entry here** (code, settings, deploys, data
repairs, reverted experiments). See README.md → "For AI agents".

---

## v10.2 (2026-10-27) — Phase 1: broker safety stop, real P&L, commission found

Phase 1 of the 2026-10-26 audit roadmap: safety and honest numbers. **Nothing
here changes which stocks are bought or how exits are decided.**

**How it was checked (one read-only call, approved by the owner).** eToro's
`GET /api/v1/trading/info/trade/history?minDate=2026-07-01` returned all **389
closed pieces** (317 positions; a partial close is a row of its own with the
same open time and rate) from 2026-07-13 to 2026-10-26. A copy is in
`data/audit/trade-history-2026-10-27.json` on the server. No order of any kind
was placed.

**Finding 1: no position ever had a broker stop.** Every row has
`stopLossRate: 0.0001`. All stops were the bot's own, checked each minute, so a
crash, a server outage or an overnight gap had nothing behind it.

**Finding 2: a $1-per-order commission the bot never counted.** With nothing
open, live equity was $9,025.38 (−$974.62 on $10,000). eToro's own closed-trade
`netProfit` total was only **−$265.39**, and its `fees` field reads 0 on every
row. The $709.23 gap grew in whole dollars as trades happened (−$580.00 on
09-21, −$589.00 on 09-22, −$598.00 on 09-28 …), and 317 opening orders plus
389 closing orders = **706 orders**, within $3.23 of the gap. So roughly **$1
per order** comes out of cash: $2 per round trip, $3 with a partial. On a
~$1,500 position that is 0.13–0.2% per trade, about **73% of the account's loss
since July**. The bot's own records also overstate each trade a little: they use
eToro's P&L a moment *before* the close fills (NVDA 10-26: recorded +$12.40,
eToro booked +$6.23). Across the 278 trades matched to eToro, the bot's
best-known figure was −$50.06 and eToro's was −$2.16. The 39 eToro-only
positions (−$263.23) are 13–17 July, before the bot kept trade records.
**Open question for the owner:** whether the real $350 copy also pays a fixed
fee per copied order. At ~$52 a copied position, $1 an order would be ~4% a
round trip. Check the real account's statement.

**Changes**

- **Broker-side safety stop** (`etoro-client.js`, `trade-planner.js`,
  `index.js`, `config.js`). Every buy now sends `StopLossRate` at
  `entry − 1.5 × (entry − plan stop)`, rounded down, which eToro holds and fires
  even when the bot is down. For a 2.9% plan stop it sits 4.35% below entry. The
  bot's own stops still do all normal exits. If eToro answers 400 to the order
  with the stop, it is **not** retried with the same body; it is placed once more
  without the stop (exactly how every earlier trade ran) and Telegram gets a
  `BROKER_STOP_REJECTED` alert. The stop is saved in `position-meta`
  (`brokerStopRate`). If eToro's stop ever fires, the ghost-position alert now
  says so. Settings: `DT_BROKER_STOP_ENABLED` (true) and
  `DT_BROKER_STOP_MULTIPLIER` (1.5). Positions already open at deploy keep no
  broker stop. There were none at deploy.
- **Commission booked to the capital ledger** (`capital-manager.recordCommission`).
  $1 is booked when the open, each partial and the final close fill
  (`DT_COMMISSION_PER_ORDER_DOLLARS`, 1). `ledger.commissionsBooked` keeps the
  running total. The ledger drives sizing, the drawdown breaker and the de-risk
  day count, so these now follow the real account instead of drifting ~$2 a
  trade until the 1% reconciliation caught up.
- **Reconciliation tolerance 1% → 0.3%** (`DT_CAPITAL_RECONCILE_TOLERANCE_PCT`
  default). With commissions booked, what is left is fill slippage, so a gap past
  ~$27 is corrected. The first cycle after deploy corrects the existing
  −$81.93 drift. That fires one `UNEXPLAINED_EQUITY_CHANGE` alert, which is
  expected.
- **Trade records carry eToro's numbers.** New records hold `positionId`,
  `commissionDollars` and `netPnlDollars`. `pnlDollars` stays the market result,
  so the score floor, cooldowns, BAD-DAY rule and every stat read exactly as
  before. A daily job (16:20 ET, and once at start-up if the copy is over a day
  old) pulls eToro's trade history into `data/broker-trade-history.json` and
  stamps `brokerNetProfit`, `brokerOpenRate`, `brokerCloseRate` and
  `brokerPieces` on each matched record. Matching uses positionId, or for older
  records the nearest open within 15 min **and** within 3% of the entry price;
  the price check stopped two stocks opened in the same minute from swapping.
  Journal event `BROKER_SYNC`. Offline: `node src/index.js --sync-broker` (only
  while the bot is stopped, because it rewrites trade-history.json).
- **`/perf` fixed.** "All time" is now the **account** (effective capital vs
  the start). The old line summed raw `pnlDollars`, which for pre-v8 trades left
  out every partial profit and ignored commissions. It also shows eToro's own
  trade total and the estimated commissions. The 7-day and current-rules lines
  are after commission and use eToro's figure per trade where matched. Early
  records eToro can't match are labelled as the bot's estimates.
- **Rates timeout retry** (`etoro-market-data.fetchBatchedRates`). One quick
  retry on a timeout only (429 and other errors are thrown as before).
  Logs to 10-26: 25 paper-book marks and 4 dip-order checks lost a whole minute
  each to a single 12-second timeout here.

27 new tests (`test/phase1-v10-2.test.js`, eToro stubbed, no network): stop
price and rounding, order body with and without the stop, the 400 fallback,
commission per order, ledger booking, broker matching (partials summed,
same-minute different stock not matched, positionId wins), and timeout-only
retry. 458 tests pass.

---

## v10.1 (2026-10-25) — CVX added; eToro "TICKER.US" listings resolve

Owner request: add Chevron (CVX) as an energy name; the energy group had only
XOM and COP. On Friday 10-23 both were AI-approved twice and their dip orders
expired because neither pulled back — the sector logic (up to +8 points when
XLE is up 0.5%+) was already working.

**Why CVX was missing.** On eToro the bare symbol "CVX" is a **crypto**
(Convex Finance, id 100512), which the v7.x guard correctly refuses so no order
can ever buy the wrong asset. The NYSE share is listed as **CVX.US** (id 1014);
the same search also returns CVX.PA (Euronext Paris) and CVX.RTH. An old test
even asserted "CVX NOT added (verified unavailable as equity on eToro)".

**Fix (`src/etoro-client.js`).** When a ticker has no equity match — no match
at all, or only a crypto one — exactly one more name is tried, `TICKER.US`,
accepted only if it is a stock/ETF (never crypto). The bot keeps calling it by
its own name, and the reverse lookup reports `CVX.US` as `CVX`, so a held
Chevron position always matches its meta entry (a mismatch is what makes a
position "untracked"). Verified on the server with a fresh process: CVX → 1014,
1014 → CVX, and **all 54 other watchlist stocks resolve to exactly the same
instrument as before**.

`watchlist-daytrade.json`: `{ "symbol": "CVX", "bucket": "energy", "night": false }`
(55 stocks). The old CVX test now asserts it is present; 3 new tests cover the
.US pick (not the crypto, Paris or RTH listing), refusing a crypto .US match, and
the reverse mapping. 429 tests pass. Restarted Sunday with no open positions.
CVX price history for the shadow strategies starts with the next nightly capture.

---

## v10 (2026-10-22) — four shadow strategies with their own books; a better Telegram

**Nothing here changes how the live bot trades.** The ~110-trade evaluation of
the v9 rules continues uninterrupted.

### Why

The performance review of 2026-10-22: 20 trades on the v9 rules, −$117.02
(−$5.85 per trade), average win $6.91 against average loss $18.61; all time
276 trades, −$1,023.56. The paper book answered the score-floor question —
stocks the floor rejected lost too (226 paper trades, −$294.51), and so did
buying without waiting for the dip (63, −$68.42). Every variant of the one idea
the bot trades — intraday momentum — loses $1–6 per trade. So the next step is
to test **different reasons to buy**, not more settings.

### The four strategies (`src/shadow-strategies.js`)

| Book | Buys when | Exits |
|---|---|---|
| 📈 `SWING_BREAKOUT` | close above the prior 20-day high, close above the 50-day average, 50-day average rising over 10 days | stop 2 × ATR, trailed to the 10-day low; 20 sessions max |
| 🔁 `DIP_IN_UPTREND` | close above the 100-day average and 2-day RSI under 10 | first close above the 5-day average; safety stop 3 × ATR; 5 sessions max |
| 📰 `EARNINGS_DRIFT` | the reaction session after an earnings report closes ≥ 3% up, in the upper half of its range, EPS ≥ estimate | stop at the reaction day's low (never tighter than 1 × ATR); 20 sessions max |
| 🏆 `ROTATION` | top 5 of the watchlist by 3-month return skipping the last week, above the 50-day average; re-ranked once per ISO week | dropped out of the top 10 or below the 50-day average |

Universe: the 54-stock watchlist. Each book is a fixed $10,000; stop-based
trades risk 0.5% ($50) to the stop, capped at 35% of the book, at most 7 open;
rotation holds 5 × $2,000. 10 bps round-trip costs. The 100-day average stands
in for the usual 200-day one because only ~148 days of history exist.

### Isolation

- A **separate process**, chained after the nightly candle capture in cron
  (`15 5 * * 2-6 … fetch-replay-candles.js …; node src/shadow-strategies.js`),
  so it runs on finished data at about 08:35 Bahrain and cannot crash or slow
  the live bot.
- Reads only `data/replay-candles/`, `watchlist-daytrade.json` and the Finnhub
  earnings calendar; writes only `data/shadow-strategies/<BOOK>/`
  (`state.json`, `events-YYYY-MM.jsonl`) and `last-run.json`. A test asserts the
  source never references the position meta, ledger, journal, trade history,
  cooldowns or the eToro client.
- `data/` is pushed to GitHub by the nightly server sync.

### Two price traps, found and handled

1. **The newest eToro daily bar is incomplete at capture time** (AAPL's showed
   volume 30,522), because eToro's day is a UTC day that starts with overnight
   24/5 trading. Only sessions whose UTC day has ended are processed, in both
   modes.
2. **eToro's daily open and close are overnight prices.** On AAPL's earnings
   day (2026-07-30) the 16:00 ET close was $333.74 and the daily close $318.08.
   Every fill, stop and exit uses regular-session prices (09:30–16:00 ET) built
   from 5-minute bars (from 09-08), 15-minute or hourly bars (from 07-13; the
   09:00 hourly bar is included, so pre-September backtests carry 30 minutes of
   pre-market).

No look-ahead: signals use data up to session E's close and fill at session
E+1's open; stops are checked against each session's low, a gap through the
stop fills at the open, and trailing levels use only bars before the session
being checked.

### First read on history (14 Jul → 21 Oct, 71 sessions)

Rules were written before this was run. Earnings drift cannot be tested this
way: Finnhub's free tier keeps about one month of earnings history.

| Book | Trades | Win | Result |
|---|---|---|---|
| Swing breakout | 32 | 13% | −$722.62 (−$22.58/trade) |
| Dip in uptrend | 52 | 60% | **+$33.44 (+$0.64/trade)** |
| Rotation | 17 closed, 5 open | 29% | −$1,273.61 (−$1,785.46 closed, +$511.85 open) |

Only the dip-in-uptrend book did not lose, which matches the repeated "spikes
fade" finding. Rotation was hurt by earnings collapses it held through (RDDT
−25%, AAPL −10.8%, AFRM −14.5%); swing kept breaking out and reversing. Three
months, one market mood: a hint, not a verdict. Results in
`data/shadow-strategies/_backtest/`; the forward books are the real test. They
started 2026-10-22 from the 10-21 close, with rotation's first five buys (PLTR,
SHOP, CRM, MSFT, MRVL) queued for the 10-22 open.

### Telegram

- The commands are registered with Telegram, so the phone's **/** menu lists
  them with descriptions.
- **Every reply carries tap-buttons** for the other screens; a tap runs that
  screen. Button presses are checked against the configured chat id, like
  typed commands.
- Replies over Telegram's 4,096-character limit are split on line breaks
  instead of failing.
- New screens: **/today** (real trades, scans, plans, AI approvals, dip orders,
  what the skipped stocks did on paper), **/perf** (last 7 days, current rules,
  all time, average win and loss, how trades ended, drawdown and room left
  before the 15% safety stop), **/shadow** (each book's open and closed trades,
  next-open buys and its history check, against the live bot and the paper
  book). **/help** rewritten. Aliases: `/held`, `/performance`, `/strategies`,
  `/start`.
- All amounts in your real dollars, like the rest of Telegram.
- `node src/index.js --render /perf` prints a screen and exits without starting
  the bot, so screens can be checked against live data before a deploy.

The restart that switched the new Telegram on waited until no dip order was
waiting (PANW and UNP had been placed minutes earlier, and a restart cancels
waiting orders).

10 new tests (426 total), covering the indicators, the New York clock,
regular-session prices, sizing, next-open fills, gap-through-stop fills, no
look-ahead, the weekly rotation and the isolation check.

---

## v9.2 (2026-10-12) — paper-trade what the score floor turns down; Telegram commands

**Logging and Telegram only — no change to how the bot trades**, so the
~110-trade evaluation count that started with v9 is not reset.

**Paper trades for score-floor rejects.** On 10-12 MSFT (+1.22%, score 51) and
AAPL (+1.16%, score 67) were turned down by the 80 floor, and the owner asked
what buying them would have done. Every plan rejected *only* by the floor now
also opens a paper position in `data/shadow-log/paper-*.jsonl` with
`paperReason: "SCORE_FLOOR"`:

- Built by the real planner with the floor lifted (`buildTradePlan(...,
  { ignoreScoreFloor: true, quiet: true })`), so the stop, target and size are
  exactly what the bot would have used. A candidate the planner rejects for any
  *other* reason (ATR, earnings, …) is not paper-traded, because the bot would
  not have bought it anyway. Checked on 10-12's real candidates: live still
  rejects MSFT and AAPL; the paper copy of MSFT buys $541.60, stop $529.02
  (2.32%), T1 $554.17, $2,000.
- Run by the same exit engine as real positions, and now also by the **same
  end-of-day rule**: the force-close job closes paper positions on Friday and
  closes losers Mon–Thu while keeping winners. Before this, a paper position
  could be carried indefinitely.
- At most one paper trade per symbol per reason per hour
  (`DT_PAPER_REPEAT_MINUTES=60`), so a stock scanned every 10 minutes is not
  counted six times.
- The paper book is now keyed reason + symbol, so the same stock can be held
  once as a skipped dip (`DIP_WAIT`) and once as a floor reject
  (`SCORE_FLOOR`). Old saved state restores unchanged.
- Daily total in Telegram, in both `/status` and the market-closed message:
  "If it had bought what it skipped today — Skipped by score: N closed, N won,
  $X · Skipped waiting for dip: …". After a week or two this answers, in
  dollars, whether the floor is saving money or costing it.
- Switch off with `DT_PAPER_SCORE_REJECTED=false`.

First live scan after deploy (09:56 ET) opened paper positions on COP, SHOP,
GOOGL, AAPL, DE and TMUS; marks every minute since.

**Telegram commands** (also in this release): `/status` (green/red health,
last scan, market open, positions, dip orders, today's P&L, capital, mode),
`/positions` or `/held` (each holding with live P&L, stop and what would make
it sell), `/help`. Polling, not a webhook (the server has no public HTTPS);
answers only the configured chat id; read-only. The first version split
commands on the letter "s" instead of whitespace (a lost escape), so every
command fell back to `/help`; fixed, and `/ status` with a space is accepted.

**Server sync to GitHub.** The server now pushes the live code and all of this
bot's data to `dawoodriaza/etoro-short-v2` (`server-backup/`) every Mon–Sat at
05:50 UTC, from `~/etoro-v2-short-repo` with its own deploy key. The redaction
step only treats keys whose names mark them as secret (KEY, TOKEN, SECRET,
PASS…); the version copied from the other bot matched `America/New_York` and
corrupted a line of code in the backup.

Changed: `src/config.js`, `src/strategies/trade-planner.js`, `src/index.js`,
`src/notifications/telegram.js`, `scripts/daily-github-backup.sh`. 416 tests
pass, locally and in the server's scratch copy.

---

## v9.1 (2026-10-10) — data/shadow-log: the trade not taken, and a price every minute

Two things the decision journal could not answer, both asked for by the owner,
both **logging only** — nothing added here can place, size, hold or close a real
order. Checked first that neither already existed: `POSITION_STATUS` was being
written only every 10th tick, and the one existing counterfactual
(`exit-shadow-tracker.js`) tests alternative *exits* on positions already open,
not the immediate buy.

**`data/shadow-log/paper-YYYY-MM-DD.jsonl` — what the dip wait costs.** Every
time a dip order is armed, a paper position is opened at the price the AI
approved — the trade the bot did **not** take — and marked every minute against
the **same** risk engine (`decidePositionAction` / `describePositionState`) until
that engine says it would have exited.

- `PAPER_OPEN` — entry, stop, T1, size, score, source.
- `PAPER_MARK` — price, P&L, peak, state, live stop and its kind, the engine's
  action and the exact exit conditions it is waiting on. One per minute.
- `PAPER_MARK` with `action: "PARTIAL"` — the T1 half is banked, the flag and
  the locked floor are set and the tracked size shrinks, mirroring the live
  partial handler, so the remainder trails as a real runner would instead of
  re-signalling PARTIAL every minute and reporting a size it no longer holds.
- `PAPER_CLOSE` — exit reason, the final leg's P&L, anything banked at T1,
  `totalPnlDollars` for the whole paper trade, MFE, MAE and minutes held.

The paper position deliberately carries **no** `plan.dipEntry`, because it is the
bought-immediately counterfactual — so the v8.3 breakeven wait, which applies to
dip buys only, correctly does not apply to it. "The dip never came and it would
have been profitable" is now answerable from the log instead of from a replay
weeks later.

**`data/shadow-log/minute-YYYY-MM-DD.jsonl` — why it didn't sell.** One line per
real open position per minute: price, P&L, peak, the live stop and its kind, the
state, the exit conditions, the next trim, anything banked, the engine's action
and minutes held. The console line and the `POSITION_STATUS` journal event stay
on every 10th tick; this is the same payload with the 10-minute holes removed.

Kept in its own folder and its own files so a few thousand lines a day cannot
bloat the decision journal every review script reads. Writes never throw, like
the rest of the journal, and both hooks sit in their own try/catch — a logging
failure cannot touch exit management. Open paper positions persist to
`data/shadow-log/open-paper.json` and are restored on boot, so a deploy does not
silently truncate the comparison the folder exists to make.

One batched rates call per minute while the paper book is non-empty (nothing at
all when it is empty), separate from the dip-order call so the live dip path is
untouched.

Changed: `src/strategies/decision-journal.js` (the shadow writers and the paper
state file), `src/index.js` (`openPaperPosition`, `markPaperPositions`, the arm
hook, the 1-minute tick hook, the per-minute real-position line, and the restore
on boot). 416 tests pass. Verified on the server before the market reopened: all
three record types and the state round-trip write correctly through the real
code path, and the folder is created on first write.

---

## v9 (2026-10-10) — the pre-registered checkpoint: one change adopted, three rejected

18 sessions (2026-09-16 → 10-09), 66,397 journal events, 21,889 candidate
snapshots and 177 armed dip orders, replayed through the live exit engine on the
bot's own 5-minute bars at 10 bps, with the fill bar's own high never counted as
profit.

**The method, fixed before any result was read.** The window was split into
**Sep 16–25**, which had already been mined while building v8.3–v8.6 and is
therefore in-sample, and **Sep 28 – Oct 9**, which had never been used for any
decision. To be adopted, a change had to beat the live rule on the fresh half
*and* on the full window, not flip the sign on the mined half, and clear 25
trades in the fresh half and 60 overall. Everything runs through the real book
— 7 slots, one position per symbol, ranked when candidates collide — and each
question changes exactly one thing.

### Q1 — dip depth: REJECTED, keep 0.25

| Dip required | Sep 16–25 (mined) | Sep 28 – Oct 9 (fresh) |
|---|---|---|
| Buy at once, no dip | −$161.77 (−2.31/t) | −$223.41 (−3.33/t) |
| 0.10 of the stop | −$110.87 (−1.98/t) | −$80.32 (−1.46/t) |
| **0.25 of the stop ← live** | **−$96.93 (−2.49/t)** | **−$106.62 (−3.05/t)** |
| 0.50 of the stop | −$67.99 (−5.23/t) | −$43.46 (−3.34/t) |

The shallow dip that looked promising during the v8.6 work beat live on the
fresh half but lost on the mined half, and by $1.59 per trade — below the $2 per
trade that is distinguishable at this sample size and spread. Not adopted. The
useful reading is that **every depth loses $1.7–$4.3 per trade**: entry timing
is not where the money is going.

### Q2 — selection: REJECTED, and the reason matters

| Rule | Sep 16–25 (mined) | Sep 28 – Oct 9 (fresh) |
|---|---|---|
| **old ≥ 80 + AI take ← live** | **−$70.16 (−1.63/t)** | **−$88.88 (−2.54/t)** |
| old ≥ 80, no AI veto | −$111.24 (−1.25/t) | −$161.29 (−1.77/t) |
| **trend score V2 ≥ 80** | **+$93.69 (+1.04/t), 70% win** | **−$254.32 (−2.14/t), 55% win** |
| V2 ≥ 80, watchlist only | −$74.39 | −$189.17 |
| V2 ≥ 80 and old ≥ 80 | +$86.99 (+1.45/t) | −$176.14 (−2.55/t) |
| V2 ≥ 90 | −$53.56 | −$338.56 |

**The trend score V2 does not generalise.** On the half it was designed against
it returned +$1.04 per trade at a 70% win rate; on data it had never seen,
−$2.14 per trade. Every V2 variant collapses the same way. Without the split
this would have shipped as the headline improvement — it was the leading
candidate going in. V2 stays logged and untraded, and the "dynamic per-stock
threshold" idea built on it stays rejected.

Dropping the AI veto was also worse on both halves, so the veto stays. **Flagged
risk:** v8.7's move to Haiku 5.5 took approvals from 1-of-43 to 9-of-17, which
pushes the live gate toward the "no AI veto" row that tested worse here. It has
only 2 closed trades behind it — watch it through the freeze below.

### Q3 — the exits: ADOPTED, time budget 150 → 240 minutes

| Exit rule | Sep 16–25 (mined) | Sep 28 – Oct 9 (fresh) |
|---|---|---|
| **live (150 min) ← was** | **−$96.93 (−2.49/t)** | **−$106.62 (−3.05/t)** |
| **240 min ← adopted** | **−$82.95 (−2.24/t)** | **−$21.53 (−0.62/t)** |
| 390 min | −$80.05 (−2.16/t) | −$7.01 (−0.20/t) |
| no time exit at all | −$96.14 (−2.60/t) | +$10.25 (+0.29/t) |
| keep 80% of the peak | −$73.10 | −$131.38 |
| arm profit keeper later | −$86.61 | −$103.24 |

The stale time exit was **selling positions at roughly breakeven before they
could reach the profit keeper**. Of 76 filled orders, 20 change outcome at a
longer budget — 14 better, 6 worse, net +$115.78 — and `TIME_EXIT_STALE` falls
from 15 exits to 1 while `MFE_GIVEBACK` rises from 21 to 29. The trades being
cut were worth about $0 at the moment of the cut (+$1.41, −$0.71, +$2.51,
+$2.05 …), which is much of why the average win was $5.52 against an average
loss of $11.42.

**Why 240 and not 390 or none, which both scored better:** the extra gain is
concentrated. One trade (MELI, 10-05) is 37% of the whole +$115.78 and the top
three are 79%. The direction is well supported — 14 better versus 6 worse, a
clear mechanism, consistent across both halves — but the magnitude is not, so
this takes the conservative step instead of buying the tail. The six that got
worse were mostly positions carried past a breakeven exit into a worse
end-of-day close (SNAP 09-30, −$21.67). "Arm the profit keeper later" passed the
letter of the bar by $3.38 on the fresh half, i.e. $0.10 per trade, which is far
inside the noise — the bar should have carried a minimum effect size, and it was
not adopted.

Changed: `src/config.js` (`maxHoldMinutes` default 90 → 240, with the evidence
recorded beside it), and `DT_MAX_HOLD_MINUTES` 150 → 240 in the server `.env`
(backup in `~/etoro-audit/`). Still a regular-session budget, so the ×0.7/×1.5
volatility buckets, the 8× wall-clock ceiling, the stop, the profit keeper, the
Mon–Thu loser close and the Friday close-all all still apply on top. 416 tests
pass; deployed Saturday with no open positions. Full output:
`~/etoro-audit/checkpoint-2026-10-10.txt`.

### What this means, plainly

Nothing here turns the bot profitable. Every selection rule and every entry
depth loses $0.7–$3.8 per trade; the adopted change takes the fresh half from
−$3.05 to −$0.62 per trade, which is most of the way to breakeven but not past
it. The honest position is that the exits were giving away the wins, that this
is now partly fixed, and that the next question is why the average loss is
still roughly double the average win.

**Now the config freezes.** Per the data-requirement work of 2026-10-09: at the
current spread ($11.32 per trade) and rate (4.2 trades per session, likely
higher with the looser Haiku 5.5 gate), proving a +$3 per trade edge needs about
112 trades, or 3–5 weeks. Every change resets that count — only 2 trades had
closed under the previous configuration. No further strategy changes until
roughly 100 trades have closed on this one, unless something breaks.

---

## v8.9 (2026-10-09) — clock times read as 12-hour am/pm

Owner request: every time shown in Telegram in 12-hour format, not 24-hour.

`to12h(hour, minute)` in `src/market-hours.js` is now the single display
formatter, used by `describeEtClock` (both the ET and the operator side) and
`localClock`, and by the force-close label in `src/strategies/session-timing.js`
that reaches the "dip order cancelled" message. So the review header, the
market-closed summary, the session timetable, the dip deadline and the startup
log all read "3:00 PM ET (10:00 PM Bahrain)" instead of "15:00 ET (22:00
Bahrain)".

Display only. Every place a time is computed or compared still uses the `h23`
hour cycle — `getMarketTime`, `getEasternHourMinute`, the overnight freeze
window and the session-minute arithmetic are untouched, so no scheduling
behaviour changed. Midnight and noon verified (12:00 AM / 12:00 PM). 416 tests
pass; deployed and restarted with no open positions.

---

## v8.8 (2026-10-09) — every notification now says what time it is, in both clocks

**The complaint.** A notification arrives at 22:00 Bahrain and reads like the
day is over, but the US market trades until 23:00 Bahrain. The owner was not
even sure when the close was ("11:30 pm or 11 pm").

**What was actually wrong.** Nothing was mis-scheduled. Every `CronJob` is
anchored to `America/New_York`, so the whole timetable already tracks US
daylight saving, and the 22:00 message is the **15:00 ET position review** —
deliberately an hour before the close. The bug was that the messages never
said the time: the review's only hint was the word "pre-close". Confirmed by
reading the schedulers rather than assuming:

| Event | ET | Bahrain now | Bahrain from 2026-11-01 |
|---|---|---|---|
| Market opens | 09:30 | 16:30 | 17:30 |
| Position review (Mon–Thu) | 15:00 | **22:00** | 23:00 |
| Bot stops opening new trades | 15:15 | 22:15 | 23:15 |
| Bot force-closes day trades | 15:45 | 22:45 | 23:45 |
| Market closes | 16:00 | **23:00** | 00:00 |
| eToro overnight trading ends | 20:00 | 03:00 | 04:00 |

The "11:30 pm" instinct was half right: `DT_TRADE_24_5=true`, so eToro keeps
filling the overnight-eligible names well past the 23:00 close, until 03:00
Bahrain. The Bahrain column moves one hour later on 2026-11-01 when the US
leaves daylight saving and Bahrain does not — which is why every time below is
computed at send time, never stored.

**Shipped.**

- `src/market-hours.js`: `describeEtClock(h, m)` → `"15:00 ET (22:00 Bahrain)"`,
  and `localClock(date)` → `"22:21 Bahrain"` for deadlines that are not fixed
  times of day. Both derive the operator's clock from the ET instant through
  `Intl`, so neither can drift at a DST boundary.
- `src/notifications/format-helpers.js`: `sessionSchedule(weekday)` is now the
  single source of truth for the day's moments, **derived from the same
  settings the schedulers use** (`forceCloseMinutesBeforeClose`,
  `eodNoEntryMinutesBeforeClose`, `fridayNoEntryMinutesBeforeClose`,
  `reviewerHourET/MinuteET`, `trade24_5`), so a message cannot describe a
  timetable the bot does not run. Plus `formatSessionSchedule` (ticks off what
  has already happened), `formatMinutesUntil` and `scheduleMoment`.
- **The 22:00 review message** is retitled "Position review — mid-session",
  states its own clock time, says how long trading is still open ("another
  1 hour — this is a check-up, not the end of the day"), and lists the rest of
  the day's timetable.
- **The day's summary moved from 15:45 ET to the real 16:00 ET close.** It used
  to ride along with the force-close job, which runs 15 minutes early so exits
  fill before the bell — so the last message of the day arrived while the
  market was still open. It is now its own cron, titled "🔔 Market closed —
  16:00 ET (23:00 Bahrain)", and it says what the force-close did and at what
  time, how many winners are held overnight (with correct singular/plural), and
  the full timetable with every past moment ticked.
- **The dip message** now gives the deadline as a wall-clock time — "within 60
  min (by 22:40 Bahrain)" — instead of a duration the reader has to add up.
- **Startup logs the session clock** in both zones, recomputed every boot.

Deliberately NOT changed: the 15:45 ET force-close (15 minutes of fill-safety
before the bell), the 15:15 ET entry cutoff (evidence: entries in the last 30
minutes went 2/7, −$113 — CHANGELOG v8) and the 15:00 ET review time. Those are
trading decisions with evidence behind them; only the wording was unclear.

416 tests pass. Deployed and restarted 11:41 ET Friday with no open positions.

---

## v8.7 (2026-10-08) — Claude Haiku 5.5 for the screener and reviewer, thinking off

The screener and the daily position reviewer ran `claude-haiku-4-5`, hardcoded in
two files. Both now read **one setting**, `config.aiModel`, defaulting to
**`claude-haiku-5-5`** (`DT_AI_MODEL`).

**Measured on this server's own key and SDK (0.24.3), same evidence, before
changing anything:**

| model | in/out tokens | cost per call | verdict |
|---|---|---|---|
| `claude-haiku-4-5` (previous) | 132 / 60 | $0.00043 | TAKE/8 |
| `claude-haiku-5-5`, thinking off (now) | 186 / 127 | $0.00008 | TAKE/6 |
| `claude-haiku-5-5`, thinking on | 187 / 252 | — | SKIP/5 |

About **5× cheaper per call**: list price is 10× lower ($0.10/$0.50 per million
versus $1.00/$5.00), partly offset by a new tokenizer that counts ~40% more
input tokens for the same text. Context window is 1M instead of 200K, which this
bot does not need — its prompts run 1–2K tokens.

**Thinking is deliberately OFF** (`DT_AI_THINKING=false`). Two reasons found on
the probe, not assumed:

1. Haiku 5.5 runs adaptive thinking **by default** where Haiku 4.5 ran none, and
   thinking tokens are charged against `max_tokens`. On a tiny test prompt
   thinking spent 252 of the screener's 600-token budget; the real prompt is far
   longer. A truncated reply is discarded as an "unparseable screener response",
   and with the AI as the entry gate that would stop the bot trading entirely.
2. Thinking **changed the verdict** on identical evidence (SKIP/5 with it on,
   TAKE/6 with it off). That is a strategy change, not a model swap, so it gets
   its own test with a raised token budget rather than riding along with this.

**Verified before and after deploying**, not assumed: the installed SDK (0.24.3,
older than the thinking parameter) accepts both the new model string and
`thinking: {type: "disabled"}` and passes them through; four real Oct 7 plans
replayed through the bot's own `screenCandidates` returned parseable verdicts in
1.7–2.2 s with the dedupe cache working and no truncation. Both call sites
already filtered `block.type === "text"`, so the extra block types thinking would
add could not have broken parsing.

Changed: `src/config.js` (new `aiModel`, `aiThinking`), `src/models/ai-screener.js`,
`src/models/ai-position-reviewer.js` (read the config instead of a hardcoded
string), `src/index.js` (startup line now prints the model, thinking state and
token caps). 416 tests pass. Restarted 09:07 ET with no open positions and no
pending dip orders, 23 minutes before the open.

---

## v8.6 (2026-09-27) — the dip is measured from the running high, and never paid up

**The bug the owner spotted.** Telegram kept sending "waiting to buy the dip" on
META, AMD, GOOGL, MU, SMCI — and the dip never came. The buy level was frozen at
the approval price, so a stock that ran first and pulled back later could never
fill: its pullback started from a higher price while the trigger sat far below.

**What the logs actually say** (93 real approvals Sep 17–25 replayed through the
live exits, 10 bps costs, the fill bar's own high never counted as profit):

| Entry rule | Bought | Win | Result | Avg per trade |
|---|---|---|---|---|
| Buy at the approval price | 93 | 58% | +$1.81 | +0.001R |
| Dip ¼ stop, frozen anchor (v8.3–v8.5) | 27 | 48% | −$81.21 | −0.114R |
| **Dip ¼ stop from the running high, capped at the approval price** | **39** | 49% | **−$70.28** | **−0.063R** |
| Same, allowed to pay up to +1 stop above approval | 41 | 51% | −$73.49 | — |

- **The missed names really were the winners.** Of the 64 orders that expired,
  buying at the approval price would have made **+$358.83** (45 winners): META
  +$52.85, MU +$33.44, SMCI +$30.35, ARM +$9.80, AMD +$7.11.
- **But buying everything is not the fix.** The 20 orders that did fill would
  have lost **−$371.78** bought at approval versus −$97.97 on the dip: the dips
  that fill are the ones that keep falling (adverse selection). The two almost
  exactly cancel — hence +$1.81 across all 93 approvals.
- **And through the real book it is worse.** 7 slots, one position per symbol:
  buying immediately left 155 candidates blocked by a full book versus 44 with
  the dip, and paid the ~10 bps spread far more often. Best selection rule:
  −$168.60 buying immediately versus −$2.63 with the dip.

**Shipped.** `dipEntryTrailFromHigh` (`DT_DIP_TRAIL_FROM_HIGH`, default **on**).
The buy level now follows the highest price seen while waiting, clamped at the
approval price: the bot buys a pullback, still takes the stock if it comes back
to where it was spotted, and never chases it higher. Paying up tested worse and
is the exact late entry v8.2 was built to stop. The breakdown guard moves with
the buy level, so "a full stop below the buy price is a breakdown, not a dip"
keeps its meaning. Changed: `src/config.js`, `src/strategies/trade-planner.js`
(new `dipLevels`, plus `buildDipEntryOrder`, `evaluateDipEntry`,
`describeDipEntryOrder`), `src/index.js` (arm call, log line, both Telegram
messages), `src/replay-exits.js` (the lab now models the same anchor; new
variants `DIP_025_60M_TRAIL`, `DIP_010_60M_TRAIL`, `DIP_050_60M_TRAIL`),
`test/audit-followups-v8-1.test.js` (7 new tests, 416 total, 0 failing).

**New logging for the two-week review.** Every DIP_ENTRY record now carries
`trailFromHigh` and `runUpFromSignalPct` — how far the stock ran at best while
the order waited. On an EXPIRED order that is the size of the move the bot stood
and watched, and it is in the Telegram message too ("ran to $X (+Y% at best)"),
so the missed-runner question can be answered from the journal alone.

**Tested and deliberately NOT changed** (same 93 approvals):

- **Removing the dip.** Best per trade (+0.001R) but worse through the book, as
  above. The shallower-dip pattern now shows up in three independent cuts
  (¼ stop −0.114R → ⅛ stop −0.056R → no dip +0.001R; and with the new anchor
  ½ stop −0.155R → ¼ stop −0.063R → ⅒ stop −0.019R). Every cut is the same
  seven days, so the depth stays at 0.25 until the Oct 1 checkpoint.
- **Tightening the stop.** A 0.5 ATR stop looked like the fix (−$112.89 →
  +$12.81) until the dip depth and the position size were held constant: a
  tighter stop also makes the dip trigger shallower (more fills) and, with
  risk-based sizing, buys a bigger position. Held constant it was **−0.101R vs
  −0.114R** — no real gain — and at a flat $2,500 size every variant got worse.
  It also turned 3 stop-outs into 5, and −$122 of stop losses into −$213.
- **A looser profit keeper or an earlier partial.** Keeping 80% of the peak
  −$104.49, arming the keeper later −$89.02, selling half at +0.5R −$107.08, at
  +1R −$112.89 (no change at all). All within noise of the live −$112.89.
- **Where the money actually goes** (live settings, 27 fills): the profit keeper
  is the only profitable exit (+$94.25 over 9 trades), while 3 stop-outs cost
  −$122.56 and 9 forced closes (EOD + Friday) cost −$89.94. The payoff-shape
  problem is real, but it is not fixed by moving the stop or the target.

---

## 2026-09-27 — review · Sep 24–25 sessions and an interim selection test (no code change)

- **Sep 24 (Thu): no trades. Sep 25 (Fri): 2 trades, −$4.61** (GM +$2.80,
  MU −$7.41, both closed by the Friday rule; MU had waited for breakeven, which
  saved about $1 versus selling on the clock).
- **Seven sessions since the small dip: 20 trades, 12 winners (60%), −$38.45.**
  Account effective $9,330.00, peak $10,032.85 (6.7% below; breaker 15%).
- **Why so few trades — two measured bottlenecks (Sep 17–25):**
  1. **The screener has never approved a discovered name: 0 of 262.** Watchlist
     plans are approved 93 of 254 (37%). On Sep 24, 65 of 83 plans were
     discovered, so only 12 watchlist plans reached a verdict (2 taken).
  2. **The 80-point floor blocks the names V2 rates highest.** Sep 24: AMD max
     old 77 (26 rejections) / V2 99 · AFRM 76 / 100 · META 75 / 98 · LLY 79 / 95.
     Sep 25: GM 78 (30 rejections) / V2 100 · MSFT 78 / 93 · MRVL 78 / 97 ·
     SMCI 79 / 88. V2 rated 31 symbols ≥ 80 on Sep 24 and 21 on Sep 25.
- **Interim selection test** (8,982 candidate records Sep 17–25 replayed through
  a real book: 7 slots, one per symbol, live dip entry and exits; ranked by the
  rule's own score). **Not the pre-registered decision** — one week, several
  rules compared on the same data:

| Selection rule | Trades | Win | Result |
|---|---|---|---|
| Live rule (old ≥ 80 + AI veto) | 24 | 54% | −$117.91 |
| Old ≥ 80, no AI veto | 63 | 62% | −$144.27 |
| **V2 ≥ 80 (any source)** | **80** | **71%** | **−$2.63** |
| V2 ≥ 80, watchlist only | 59 | 66% | −$91.19 |
| V2 ≥ 70, watchlist only | 68 | 66% | −$173.28 |
| V2 ≥ 80 and old ≥ 80, watchlist | 27 | 63% | −$43.93 |

  Consistent with the live trades (V2 ≥ 80: +$26.53 over 11; V2 < 80: −$60.37
  over 7). Dropping the AI veto alone made things worse; the discovered names
  V2 rated ≥ 80 helped (+$88 vs watchlist-only). Buying at the scan price
  instead of the dip was worse for every rule except one (V2 ≥ 70 watchlist
  +$64.77), which contradicts its own dip version and reads as noise.
- **The real limit is trade shape, not selection.** Even the best rule wins 71%
  and only breaks even: winners are harvested at +1–3% while stops sit 4–5%
  away. Next lever to test at the checkpoint: a tighter stop or a longer leash
  for winners, now that entries come on a dip closer to a sensible stop level.
- Ops healthy: 5 days uptime, 327 MB swap in use, no errors, no
  `UNTRACKED_POSITION` alerts, nightly candle capture running.

---

## 2026-09-23 — review · Five live sessions of the small dip (no code change)

**18 trades, 12 winners (67%), −$33.84** (bot dollars; ≈ −$1.18 real).
By day: 09-17 −$58.89 · 09-18 −$7.58 · 09-21 **+$14.35** · 09-22 **+$18.28** ·
09-23 no trades. Account: effective $9,334.61, peak $10,032.85 (6.7% below,
breaker at 15%).

| Exit | Count | P&L |
|---|---|---|
| Profit keeper (MFE giveback) | 8 | +$61.48 |
| Time exit at/near breakeven | 3 | +$4.25 |
| `STALE_RECOVERED` (new rule) | 1 | +$0.43 |
| End-of-day / Friday close | 3 | −$23.87 |
| AI reviewer close | 1 | −$26.22 |
| Stop-loss | 2 | −$49.91 |

- **Shape of results:** average win +$5.51, average loss −$16.67. Winners are
  harvested at +0.9–3.3% by the profit keeper while stops sit 2.2–4.9% away.
- **Breakeven wait:** 7 positions waited, **1 recovered** (HOOD, sold at +$0.43
  where the old rule would have sold at about −$1.98). Those 7 trades totalled −$66.41
  vs about −$61 selling on the clock — still slightly negative, 7 samples.
- **Dip entry, 87 approvals Sep 17–23:** 18 bought live. The 18 fills would have
  been far worse bought at approval (−$328 in replay vs −$34 actual), but the 62
  that expired would have made +$362 (44 winners) — the dip keeps filtering out
  the winners. **However, with the real book (7 slots, one position per symbol)
  buying every approval scores −$89.11 over 56 trades (55% win) versus −$97.39
  over 24 for the dip rule** — the apparent advantage disappears once slots are
  finite and allocation is first-come. No change made; the pre-registered
  Oct 1 test decides, and should also test ranking candidates instead of
  first-come.
- **Trend score V2 (logged only):** on the 18 live trades, V2 ≥ 80 → 11 trades
  **+$26.53**; V2 < 80 → 7 trades **−$60.37**. The three worst losers scored
  low (AFRM 0, NBIS 73, SOFI 69) while the old score rated them 91/100/80.
  Encouraging but 18 trades; decision stays with the Oct 1 test.
- **Sep 23:** zero trades — 8 plans, all AI-skipped (4× "RSI overbought",
  2× "risk-off tone", 2× "volume unavailable"). V2 rated 22 symbols ≥ 70 that
  day, so the gap between what the old pipeline surfaces and what V2 sees is
  large.
- **New finding — volume is unknown on the 09:30 scan.** `volumeRatio` is only
  computed when minutes-since-open > 0, so the opening scan reports "volume
  unavailable" and the screener skipped IONQ (old score 100) and SMCI (92) for
  it today. Session-hours coverage is otherwise 100% (median RVOL ≈ 1.2), but
  the first ~30 minutes are inflated (MSFT and BA showed 4.1× at 09:41) because
  pre-market volume is compared against a few minutes of expected volume. Fix
  candidate for the Oct 1 batch, with the AI prompt's "volume unavailable"
  blocker.
- **v8.5 fixes verified live:** no `UNTRACKED_POSITION` alerts since the deploy
  (previously one per close), and the server has used 305 MB of swap without
  freezing.

---

## 2026-09-22 — ops · Server froze during an automatic kernel update; swap + memory limit added

### What happened (UTC)

- 06:28–07:38 Ubuntu `unattended-upgrades` installed a new kernel
  (6.8.0-1061-oracle) and libraries — 70 minutes instead of a few, because the
  956 MB server had no swap and was running four Node processes
  (etoro-daytrade, etoro-ai-short, etoro-ai-short-shadow, pm2-logrotate) plus
  an `npm start` wrapper.
- Hourly cron ran 5 s late at 07:17 and 63 s late at 08:18; the bot's last
  complete journal record was a `SCAN_START` at 08:30; the kernel reported PM2
  "blocked for more than 123 seconds" at 09:32; SSH timed out in the banner
  exchange. No out-of-memory kills were logged — the box thrashed rather than
  crashed.
- 12:12 the owner rebooted from the cloud console (this also activated the new
  kernel). No positions were open; all data files (trade history 226, ledger,
  cooldowns, positions, journal) intact. About 3½ hours of pre-market scanning
  (04:30–08:12 ET) were missed; the regular session was unaffected. The nightly
  candle capture (05:15–05:28) had finished normally and was not the trigger.

### Changed (server, not code)

- **2 GB swap file** `/swapfile`, in `/etc/fstab` (survives reboots),
  `vm.swappiness=10` (`/etc/sysctl.d/99-swappiness.conf`) so it is used only
  under memory pressure — the machine slows instead of freezing.
- **PM2 memory ceiling for this bot:** `etoro-daytrade --max-memory-restart
  300M`, saved with `pm2 save`. A process growing past 300 MB is restarted
  cleanly instead of starving the server.
- Automatic security updates stay on.
- **Other bot on the same server (owner approved):** `etoro-ai-short` now runs
  `node src/index.js` directly instead of through `npm start` (the wrapper cost
  ~30 MB and meant PM2's memory limit watched npm, not the bot), with
  `max_memory_restart` 300 MB. Defined in
  `~/etoro-ai-short/ecosystem.ai-short.config.js` on the server; its 14 `DT_`
  settings (identical to its `.env`) were carried over and verified;
  no open positions at the time; `pm2 save` done. `etoro-ai-short-shadow`
  already had a 200 MB limit — unchanged.

---

## 2026-09-18 — v8.5 · First live sessions of v8.3 reviewed · untracked-alert race fixed · safe server tests

### What the logs showed (Sep 17–18, first two full sessions with the small dip)

**Trades: 9, 4 winners, −$66.47** (bot dollars; ≈ −$2.33 real).

| Stock | Result | Exit | Note |
|---|---|---|---|
| ANET | +$12.47 | profit keeper | dip bought 20 min after approval, peak +1.77% |
| QCOM | +$6.68 | profit keeper | dip after 60 min |
| ISRG | +$4.83 | profit keeper | |
| MRVL | +$0.14 | time exit at breakeven | waited, recovered to entry |
| TSLA | −$2.05 | end of day | waited |
| AVGO | −$12.41 | Friday close | waited |
| SNAP | −$16.89 | stop | waited |
| AFRM | −$26.22 | AI reviewer close | waited 3.7 h at about −4% |
| NBIS | −$33.02 | stop | **falling knife**: approved at $231.15 from a stale quote, bought at the first check at $224.88 (already 2.7% lower), stopped 8 min later |

- **The trend-label fix worked.** The AI approved 35 of 132 plans on Sep 17
  (it approved 0–8 a day before); 215 of 217 plans read BULLISH.
- **Dip orders: 40 → 9 filled, 28 expired, 3 cancelled** (end-of-day cutoff).
  17 of the 28 expired orders never dipped even 0.1 stop distance; 18 of 28
  ended above the approval price (median +0.48%). Biggest missed runs: SMCI
  +5.5%, IONQ +3.7%, MU +3.5%, ARM +2.4%.
- **Breakeven wait: 5 positions waited, 0 recovered.** Actual −$57.43 vs about
  −$51.02 if sold when time ran out (≈ $6 worse). Far too few trades to judge
  against the replay; kept, watched.
- **Trend score V2 logging works live**: 2,959 of 2,973 SHADOW_SIGNAL records
  carry a score.
- `EQUITY_DRIFT` 2026-09-18 15:00 UTC: realized equity $26.56 below the
  ledger (0.29%, under the 1% tolerance). Noted, not corrected.
- **Dip entry, what-if** (replay of all 40 approvals with live exits): the 9
  that filled would have lost more bought at approval (−$225, 0 winners; live
  dip result −$66); the 28 that expired would have made +$132 bought at
  approval (19 winners). The stocks that dip to the buy price tend to keep
  falling and the ones that don't dip keep running (adverse selection). Over
  all 40 it is roughly even; two sessions are far too few to change the rule.
- **The day's biggest movers were mostly out of reach.** Of the top intraday
  runs among tracked symbols, most small caps (BHVN +20%, FBYD +22%, SCTX,
  ARCT, VOGX…) were never offered by discovery. Where the bot did see them:
  SDGR +25.6% (Sep 17) scored 100 / V2 90 and was **AI-skipped 22 times**
  ("discovered, no catalyst, pump profile"); HOOD +8.5% (Sep 18) hit the 7% ATR
  ceiling 17× and was AI-skipped 8×; ELMT hit the ATR ceiling; ALMR was
  AI-skipped. MARA and MSTR were blocked by the ethics filter (crypto names are
  excluded by request — the log reason wrongly reads "gambling/alcohol/adult").

### Bugs fixed

- **False `UNTRACKED_POSITION` alerts after the bot's own closes.** eToro keeps
  listing a closed position for a few seconds; the alert fired 4–8 s after the
  bot's "Position closed" (ANET, NBIS 09-17; ISRG 09-18; SMCI, AFRM 09-11).
  A symbol the bot closed less than `DT_CLOSE_SETTLE_GRACE_MINUTES` (5) ago is
  now treated as settling; still listed after that → the alert fires as before.
  `cooldown-tracker.checkCooldown()` also returns `minutesSinceExit`.
- **Server test runs touched live data.** `test/capital-manager-v6.test.js`
  swaps the real `data/capital-ledger.json` and deletes a real `data/halt.flag`
  while it runs, and the tests log to the live `logs/errors.log` (the
  "HALT FLAG WRITTEN … $7500 is 25% below peak $10000" lines on 09-17 00:54
  Bahrain were a test run during the v8.4 deploy). No harm was found (no halt
  flag, ledger peak $10,032.85 intact), but a trade closing during a test run
  could have lost its ledger entry and a real halt could have been lifted.
  **Deploys now run the tests in a scratch copy (`~/etoro-test`, no `data/`,
  no `logs/`) and only then touch the live folder.** README → Deployment.

Tests: 409 pass.

---

## 2026-09-17 — v8.4 · Trend score V2, logged beside the live score (no trading change)

### Why

The v8.3 review found the live desk score does not predict results. It is
`(RSI − 55) × 3 + day change × 8 + bonuses`: driven by 5-minute RSI (a stock
holding +4% swings between 40 and 100 from scan to scan), "no setup" above
RSI 78 exactly when a move is strongest, and the move is measured only against
yesterday's close, so a gap-down that rallies hard reads as weak all day.

### What changed (logging only — nothing trades on V2)

- `momentum-scanner.extractTrendFeatures()` + `scoreTrendV2()`: pure functions
  over today's **completed** 5-minute bars (ET session), daily ATR, and SPY's
  bars.
- Every `SHADOW_SIGNAL` record now also carries `scoreV2`, `scoreV2Reason`,
  `scoreV2Components` and `trendFeatures` (day open/low/high, VWAP, move from
  open, rise from low in ATR, last-hour change vs SPY, share of last-hour bars
  above VWAP, higher lows, stretch above VWAP, day range in ATR).
- `market-data`: enrichment returns the 5-minute bars it already fetched
  (carried non-enumerable, never journaled); `fetchSpyIntradayBars()` — one
  cached SPY candle call per scan.
- Setting `DT_SCORE_V2_LOGGING` (default true).
- 7 new tests (407 total): dip-then-rally scores high while red vs yesterday,
  below-VWAP scores 0, completed bars only, no leak from yesterday, no score
  under 30 minutes of bars, shadow record carries V2 and the bars stay out of
  JSON.

### The formula (fixed before any V2 result was seen)

| Component | Points |
|---|---|
| Holding above VWAP — share of the last hour's bars closing above VWAP | up to 25 |
| Hour momentum — last hour's rise in daily-ATR units, full at 0.4 ATR | up to 25 |
| Rally under way — rise from today's low, full at 0.6 ATR | up to 15 |
| Beating SPY — last-hour % minus SPY's, full at +1.0% (7.5 if SPY unknown) | up to 15 |
| Higher lows across three 20-minute windows | up to 10 |
| Room left — full up to a 1.0 ATR rise from the low, zero at 2.0 ATR | up to 10 |
| Stretch penalty — above VWAP by more than 0.6 ATR, full at 1.2 ATR | down to −20 |

Hard zero when not above VWAP or not higher than an hour ago.

### Pre-registered replay test

Candidates: every tracked symbol, every 10 minutes 04:00–15:10 ET, sessions
Sep 8–11 (A) and Sep 14–16 (B); price ≥ $5, ATR ≤ 7%. Groups: OLD80 (live
formula, |change| ≥ 1%, score ≥ 80 — no CHOP penalty, AI veto or cooldowns
modelled), NEW70 (V2 ≥ 70; 60/80 shown for context), ABOVE_VWAP baseline. One
signal per symbol per group per hour, bought with the live rule (¼-stop dip in
60 min, breakeven wait).
**Pass:** NEW70 avgR > 0 in A and B · NEW70 $ > OLD80 $ in A and B ·
≥ 20 fills per half · ≤ 25 trades per session.

### Result: FAIL (5 of 6) — V2 stays logging-only

45,710 symbol-scans. Run with the live 100-bar window (the bot fetches the 100
most recent 5-minute bars); running on full-day bars gave the same picture.

| Live entry (¼-stop dip) | Sep 8–11 (4 sessions) | Sep 14–16 (3 sessions) |
|---|---|---|
| OLD80 (live score ≥ 80) | −$455 · 78 fills · avgR −0.164 | −$91 · 50 fills · avgR −0.035 |
| **NEW70 (V2 ≥ 70)** | **+$202** · 287 fills · 66% win · avgR +0.013 | **+$186** · 196 fills · 63% win · avgR +0.024 |
| NEW60 | +$23 · avgR +0.002 | −$14 · avgR −0.003 |
| NEW80 | −$253 · avgR −0.034 | +$76 · avgR +0.017 |
| Above VWAP (baseline) | −$114 · avgR −0.006 | −$230 · avgR −0.011 |

- ✔ NEW70 positive in both halves; ✔ beats OLD80 in both; ✔ ≥ 20 fills.
- ✘ **≈ 70 trades per session** against a limit of 25: across 180 symbols V2
  fires far too often to use as it stands.
- The edge is thin (about +0.02 R per trade) and **not monotonic**: V2 60–69
  +0.010 / +0.007, 70–79 −0.004 / −0.011, 80–89 −0.011 / +0.016, 90+ +0.011 /
  −0.037. A higher V2 is not yet a better trade.
- Bought at the signal (no dip) every group loses, V2 included (NEW70 −0.049 /
  −0.014 avgR), so the small dip still does most of the work.
- **Side finding:** with the live dip entry, the old score ≥ 80 did *worse*
  than buying any stock above VWAP in both halves — it steers the bot toward
  RSI spikes.

Live wiring verified with real eToro data (read-only smoke test on the server:
NVDA/AMD, 100 bars + SPY bars → features and score computed; bars absent from
JSON). Caveat: live V2 logging only covers stocks that already pass the old
1% move filter; the candle-based replay above (all ~180 captured symbols) stays
the main evaluation.

**Next (pre-registered now, evaluated on NEW data Sep 17 → ~Oct 1, not on the
data above):** model the bot's real limits — ≤ 12 candidates per scan ranked by
score, 7 slots, one position per symbol, 30-minute cooldown — and compare a
V2-ranked book against the old-score book with the live dip entry.
Pass: V2 book positive in both weeks and ahead of the old-score book in both.
Only then is V2 switched on for trading.

---

## 2026-09-16 — v8.3 · Realistic dip, wait for breakeven, trend-label fix, score floor re-checked

### What the latest logs showed (Sep 14–16, the first three live days of dip entry)

- **Zero buys.** 11 AI-approved stocks, 11 dip orders expired. The dip was one
  full stop distance, which since the v8 1.0 × ATR stop means **4–5%** on most
  names (AMD 4.07%, PANW/MRVL/ARM/NBIS 4.91%). The deepest any order got was
  45% of the way (ARM); most under 10%. PANW ran +6.6% after approval; AMD was
  approved at $519.83, asked to dip to $498.67, and went to $527.18 instead.
- **Before the dip, most candidates die earlier** (3-day totals):
  below VWAP 2,063 · weak strength vs SPY 748 · "no setup" 632 · score floor
  721 plan rejections · AI SKIP 199 of 210 plans (92/95 Mon, 76/76 Tue, 31/39 Wed).
- **Traced examples.**
  - *AMD Sep 14*: opened −6%, rallied +3.7% off the low → rejected 36× as "weak
    RS" because the move is measured only vs yesterday's close.
  - *AMD Sep 16*: at its strongest (RSI 80–82) it was "no setup" (RSI cap 78);
    when RSI cooled to 57–60 while holding +4% its score fell to 41–56 (floor
    80); one AI TAKE → 4% dip order → expired.
  - *META Sep 14*: RSI 83–89 pre-market = no setup; score-93 plan skipped by the
    AI's extended-hours "RSI ≥ 74" rule; then a re-entry penalty (prior loss).
    META's Sep 15/16 runs were only +1–2% vs the prior close → scores 8–67.
  - *MSFT Sep 14*: 4 plans scored 80–90, all AI SKIP citing "sideways trend".
  - *SNAP*: RSI 79–80 = no setup / AI SKIP ("overbought", 0.7× volume).
  - *AAPL*: never moved more than ~1.3% intraday — no opportunity to miss.
- **"Sideways" was a mislabel.** `classifyTrend()` returned BULLISH only when
  SPY itself was green, so every stock above VWAP and beating a flat/red market
  was SIDEWAYS — the AI's most common SKIP reason, and an automatic SKIP
  outside regular hours.

### Re-checked with replay (every trade, every skipped plan, every Sep 14–16 candidate; live exits; 10 bps)

**Dip size**
| Entry | Jul 1–Aug 21 candidates | Aug 22–Sep 11 candidates | Sep 14–16 all candidates |
|---|---|---|---|
| Buy immediately | −$3,805 | −$2,463 | −$1,869 |
| Dip 1.0 stop / 120 min (v8.2) | 282 buys | 70 buys | **1 buy of 1,055** |
| **Dip 0.25 stop / 60 min** | −$607 | +$161 | **+$524** (209 buys, 58% win) |
| Dip 0.5 stop / 60 min | −$146 | −$147 | +$144 |
| Dip 0.1 stop / 30 min | −$742 | −$361 | −$70 |
| Small dip or buy anyway after 15–30 min | +$1,614…+$1,873 | −$837…−$1,222 | −$446…−$787 |

**Positions that go red**
- The existing behaviour: hard stop; after the time budget (150 session-min,
  ×0.7 volatile / ×1.5 calm) anything under +0.5% exits, with one 45-min grace
  if the short trend is rising; Mon–Thu end-of-day closes losers.
- History: 79 stale exits −$751; 51 of 75 got back above entry within 6 h, but
  only 8 reached Target 1 (median best +0.41%). Stop-losses were mostly right
  (5 of 26 recovered).
- Holding longer (240 min, 390 min, no time exit) was **worse** than the current
  rule in every recent sample. "Wait for breakeven, then sell" also hurt with
  immediate entries (Sep 14–16 −$2,619 vs −$1,869) but **helped with the small
  dip** — and is what was adopted:

| Small dip (0.25 / 60 min) | without the wait | **with the wait** |
|---|---|---|
| Real trades Jul 1–Aug 21 | +$357 | +$337 |
| Real trades Aug 22–Sep 11 | −$65 | **+$42** |
| Candidates Jul 1–Aug 21 | −$607 | **−$237** |
| Candidates Aug 22–Sep 11 | +$161 | **+$315** |
| All candidates Sep 14–16 | +$524 | **+$541** |

**Score floor 80** ("every score band under 80 lost money across 114 audited trades")
| Bought at signal | Jul 1–Aug 21 | Aug 22–Sep 11 | Sep 14–16 |
|---|---|---|---|
| score 80+ | +$1,416 | **−$2,011** | −$109 |
| score <80 | −$5,221 | −$161 | −$603 |
| 90+ band | +$897 | −$1,529 | −$99 |

Real trades since the floor went live (Aug 6): 80–89 −$48 (40), 90+ −$74 (56).
With the small dip the bands flip again (<80: −$1,135 / +$46 / +$399; 70–79:
−$172 / −$3 / +$149). **The old claim is outdated, but no band wins
consistently**, so the floor was neither lowered nor raised.

**Per-stock dynamic threshold — not supported.** Across 30 symbols with ≥ 8
candidates in both periods, early results predicted later results *backwards*
(correlation −0.23): the best third early went on to −0.068R, the worst third
to +0.021R. Real trades flip the same way (MU +$105 → −$79, AMD −$89 → +$77,
TSLA −$120 → +$6).

**AI veto.** Early on, plans it took beat plans it skipped; since Aug 22 its
TAKEs did no better than its SKIPs in either recent sample (small dip:
Aug 22–Sep 11 −0.034 vs +0.011 avgR; Sep 14–16 −0.186 vs −0.030). Not changed
beyond the trend-label fix; flagged for review.

### What changed

- **Dip entry** `DT_DIP_ENTRY_DEPTH_OF_STOP` 1.0 → **0.25**,
  `DT_DIP_ENTRY_WINDOW_MINUTES` 120 → **60** (≈ 0.5–1.25% dips).
- **Wait for breakeven** (`DT_STALE_WAIT_FOR_BREAKEVEN=true`,
  `DT_STALE_BREAKEVEN_EXIT_PCT=0.1`): a position **bought on a dip** whose time
  budget runs out while red is held and sold as soon as it is back at +0.1%
  (`STALE_RECOVERED`). Stop, profit protection, Mon–Thu end-of-day loser close,
  Friday close-all and the 8× wall-clock ceiling all still apply.
  Immediate/adopted/manual positions keep the old time exit.
  Telegram: "⏳ SYM — time's up but it's red… holding until breakeven";
  status line state `WAITING_BREAKEVEN`; trade records carry
  `waitedForBreakevenSince`.
- **Trend label**: BULLISH = above VWAP with relative strength ≥ floor,
  regardless of SPY's sign (CHOP regime still SIDEWAYS).
- **Score-floor rejection text** no longer cites the outdated 114-trade claim.
- `src/replay-exits.js`: variants `DIP_010_30M`, `DIP_025_30M`,
  `DIP_*_OR_MKT_*`, `HOLD_240M`, `HOLD_390M`, `NO_STALE_EXIT`,
  `STALE_TO_BREAKEVEN*`, `DIP_025_60M_BE`, `NO_BREAKEVEN_WAIT`,
  `DIP_025_60M_NO_WAIT`; shadow samples carry `outcomeDetail`; the engine's
  breakeven wait is mirrored.
- Tests: 400 pass (new: breakeven wait, dip-only scope, ceiling, stop while
  waiting, status line, Telegram label, trend label).

### Not changed, and why (evidence did not support it)

- Score floor stays 80; no per-stock thresholds.
- RSI 78 cap: the "RSI too high" group broke even when bought at the signal
  (+$3 on 32) and RSI 78+ was mixed across periods (−0.669 / −0.012 / +0.091 avgR).
- Relative strength vs SPY: "weak RS" rejections lost when bought (−$427 on 137).

### Open for the next review

The score is dominated by 5-minute RSI and the move is measured only against
yesterday's close, so intraday reversals and steady grinders are structurally
invisible. That needs a scoring redesign tested on the shadow data, not a
threshold tweak.

---

## 2026-09-14 — docs · README rewritten for humans and AI agents

`README.md` previously described only the July 2026 eToro API probe scripts.
It now documents the whole bot: status snapshot (server, PM2 name, account,
risk, track record, current experiment), rules for AI agents (owner
preferences, `.env` overrides, evidence and look-ahead rules, position lock,
P&L accounting, secrets), the trading pipeline in plain language including dip
entry, every exit reason, safety controls, schedules, Telegram messages, data
files, every journal event, configuration (secret names only, key live
values), a code map, operator commands, testing/replay tools, the two-week
dip-entry review plan, the deployment procedure, a one-line version history,
open items and a glossary.

No code or settings changed. Also: the local scratch copies of the server
settings used for replays were deleted because they included the Telegram bot
token; replay env files must contain only non-secret `DT_` values.

---

## 2026-09-13 — v8.2 · Buy the dip after the signal, not the spike

### What the logs showed

- The losses do not come from buying stocks that were already up a lot on the
  day. Rebuilt from daily closes for all 210 trades, stocks bought 8%+ above
  yesterday's close won 78% (+$359) and stocks up only 1–3% lost −$227.
- They come from the moment of the buy: the scan approves a stock right after
  the spike that made it score well, and it then drifts. "Stale" time exits
  (79 trades, −$751) and stop-losses (26, −$1,518) are the damage; since
  Aug 22 every bucket lost (49 trades, 43% win, −$393).

### What changed

An AI-approved plan is no longer bought at once. It becomes an order that
buys only if the price dips one full stop distance below the approval price
within 120 minutes, checked on the 1-minute tick with one batched quote call.
The plan is moved to the fill price with the same stop percentage, so size
and dollar risk are unchanged. No dip in time = no trade. An order is also
cancelled if the price falls a further stop distance (a breakdown) or a
new-entry gate closes while it waits (Friday/EOD cutoff, loss limit, halt,
overnight freeze). A stock with a waiting order is not re-planned or re-sent
to the AI.

Settings: `DT_DIP_ENTRY_ENABLED` (default true; false restores buy-now),
`DT_DIP_ENTRY_DEPTH_OF_STOP` (1.0), `DT_DIP_ENTRY_WINDOW_MINUTES` (120).

### Replay evidence (`src/replay-exits.js`, v8 exits, 10 bps, split Aug 22)

A dip can only fill on a bar that starts after the approval; that bar's high
is not counted as profit (it may have printed before the dip).

| Entry | Real trades Jul 1–Aug 21 | Real trades Aug 22–Sep 11 | All candidates Jul 1–Aug 21 | All candidates Aug 22–Sep 11 |
|---|---|---|---|---|
| Buy at once (old) | 157 · +$255 | 49 · −$406 | 1,322 · −$3,851 (−0.05R) | 733 · −$1,927 (−0.05R) |
| Dip ¼ stop, 60 min | 72 · +$357 | 34 · −$70 | 712 · −$577 | 261 · +$8 |
| Dip ½ stop, 120 min | 55 · +$486 | 21 · +$1 | 577 · −$310 | 174 · −$334 |
| **Dip 1 stop, 120 min** | **19 · +$210** | **5 · +$48** | **282 · +$602 (+0.05R)** | **65 · +$315 (+0.13R)** |

The chosen setting is the only one positive in every column, and deeper dips
earned more per trade in both periods. It buys far fewer stocks, so the live
sample grows slowly; `DIP_ENTRY` journal records (ARMED, FILLED,
BLOCKED_AT_FILL, EXPIRED, CANCELLED) carry `deepestDipOfStop` for every
approval, so the depth can be re-tuned from live results.

### Telegram

- **Approved, waiting:** one message per scan listing every stock now waiting
  for its dip ("approved $X → buy at $Y").
- **Bought:** the usual OPEN message, plus "📉 Bought on a dip: approved at $X,
  bought at $Y (−Z%) after N min".
- **Not bought:** one grouped message per 1-minute check for orders that
  ended without a buy — ⌛ no dip in time (lowest price, where it is now), ✋
  cancelled (breakdown, Friday/EOD cutoff, loss limit, halt, overnight freeze),
  🚫 dipped but the buy was blocked (slots, cash, spread, earnings).
- **End of day:** the stats message ends with "📉 Dip orders today: N approved ·
  N bought on a dip · N not bought".

### Logging for the two-week review

Every approved stock ends in exactly one terminal `DIP_ENTRY` record:
FILLED, BLOCKED_AT_FILL, EXPIRED, CANCELLED — including when the bot is
stopped or restarted while orders wait (CANCELLED, "bot stopped or
restarted"). Each record carries:

- the approval snapshot (`approval`: % up today, move vs ATR, RSI, relative
  strength, VWAP, setup, news catalyst, regime, SPY, AI confidence), so "what
  did the rockets we skipped have in common" needs no joins;
- the price path while waiting (lowest, highest, last, `deepestDipOfStop`,
  `moveFromSignalPct`);
- data-quality counters: `quoteMisses` (minutes with no usable quote) and
  `checkFailures` (minutes the dip check crashed, also journaled as
  `ERROR DIP_ENTRY_CHECK`);
- for BLOCKED_AT_FILL, the exact refusal (`HELD_AT_EXECUTION`, slots, gross
  exposure, spread, earnings, cash…), also shown on Telegram.

`fetch-replay-candles.js` now captures 5-minute history for every symbol with
a `DIP_ENTRY` record, so what a skipped rocket did after its window can be
measured. Trades bought on a dip carry `plan.dipEntry` into TRADE_OPENED and
trade-history, so their results separate cleanly from older trades.

### Also

- The Sep 11 18:45 `UNTRACKED_POSITION` alerts for SMCI and AFRM were a
  momentary lost record during a meta race (the v8 lock fixes that class);
  both positions were managed and closed normally.
- `src/replay-exits.js`: `DIP_*` variants, fill counts and R per signal.

---

## 2026-09-13 — v8.1 · Closing the risks left open by the v8 audit

### Risk per trade halved (`DT_RISK_PCT_DAY` 0.01 → 0.005, `.env`)

The v8 replay found no entry edge: even with the wider stop the expected
result is about −0.03R per trade. Pausing entries was the alternative;
trading at half risk was chosen so the new shadow log collects live
evidence at roughly half the bleed. `config.js` defaults are unchanged —
this is an operator setting. Revisit only when a new entry rule clears the
go-live bar (≥150 out-of-sample signals above +0.05R after costs in replay,
plus a 3–4 week shadow run that agrees).

### Manual closes can no longer race the bot

`src/position-lock.js` now also owns `data/position-meta.lock` (O_EXCL). The
bot and `close-position.js` — separate processes — take the same lock; the
manual tool re-reads positions and meta inside it and skips anything the
bot closed while it was waiting. A lock left by a dead process is taken over
at once; one held past 5 min is treated as hung; no caller waits more than
90 s.

### Unexplained equity changes leave a trail and raise an alert

Since v8 the reconciliation compares realized with realized, so a remaining
gap is money the bot cannot account for. Every material gap (≥ $25, and
moved since the last record) writes `EQUITY_DRIFT` to the journal; a gap
that forces a ledger correction raises `UNEXPLAINED_EQUITY_CHANGE` on
Telegram instead of the old neutral "capital reconciled" note.

### Pre-v8 trade history: estimated partials added, never overwritten

`node src/backfill-partial-pnl.js --apply` (run once on the server) added
`estimatedPartialPnlDollars` / `estimatedTradePnlDollars` to every pre-v8
record from the journal's partial-exit decisions. `pnlDollars` is untouched.
Result on live data: 57 of 210 trades, **+$1,008.23**; 17 recorded losses
were really wins; whole-trade total −$855.52 → +$152.71. Stats and the
weekly self-evaluation now read `tradeResultDollars()`, and the Telegram
report shows the "since the v8 accounting fix" and "before the fix" eras
separately.

### Drawdown peak repaired

`node src/capital-repair.js --reset-peak 10032.85 --apply`: the $10,098.27
peak was created on 2026-08-21 by the pre-v8 reconciliation counting open
P&L twice; the last genuine recorded peak was $10,032.85. Resets may only
lower a peak and never below current effective capital, and are written to
`repairHistory`.

### Data capture for the next strategy test

- `src/fetch-replay-candles.js`, cron `15 5 * * 2-6` (01:15 ET, inside the
  overnight freeze): merges 1h / 15m / 5m eToro candles into
  `data/replay-candles/` daily so fine-grained history accumulates beyond the
  API's 1,000-bar window. Seeded with the audit's fetch.
- `SHADOW_SIGNAL` journal record per candidate per scan
  (`strategies/shadow-signals.js`): scan-time price, day move, ATR, VWAP
  distance, range position, distance below the high, RSI, relative strength,
  planner stop distance, and the final outcome (SCORING_REJECTED … AI_SKIP …
  OPENED). Recorded at decision time, so a replay cannot leak future bars into
  entry features — the look-ahead trap the v8 audit hit once.
- `node src/replay-exits.js --set shadow` replays those records with real
  exits, grouped by outcome.

---

## 2026-09-12 — v8 · Full audit: why the bot loses, what was broken, what changed

Evidence base: 210 closed trades, 40 days of decision journals (60k
rejections, 11.6k scored candidates, 7k plans), PM2/agent logs, live account
equity, and fresh eToro candles (1h / 15m / 5m) for 146 symbols.

### Account truth

Live agent-portfolio equity on 2026-09-12 (flat book): **$9,369.27** on a
$10,000 base — **−$630.73** (≈ −$22 real at the 0.035 copy ratio).
`trade-history.json` said −$855.52 since 07-17 — wrong, see bug 1.

### Why it is losing (measured, not assumed)

1. **The entry signal has no forward edge.** Within 150 min, TAKEN entries hit
   +1R before −1R 14–15% of the time and −1R first 15–16%; AI-skipped plans
   and score-floor rejections resolve the same way (AI skips slightly worse).
   Lowering thresholds would add more zero-edge trades.
2. **Half the trades were bad entries, not mismanaged winners.** 104/210 never
   reached +0.4R (median best +0.18R) and cost −$2,203. Only 1 trade reached
   +1R and was then managed into a scratch.
3. **Late entries are real — but not filterable with this data.** With
   hindsight, entries made after ≥75% of the day's up-move lost −$1,094 and
   those before 50% made +$1,073. Every at-entry proxy tested (range position,
   % below high, move/ATR, RSI, score, SPY trend) either flipped sign between
   halves or lost its edge once look-ahead was removed. No entry filter added.
4. **The score floor selects for extension.** Score 90–100 plans had a median
   day move of 4.65% (1.11× ATR, RSI 73) vs 1.84% below score 40, and the
   score swings a median 7.5 points (p90 27) between 10-minute scans.
5. **Payoff shape was asymmetric the wrong way.** Winners averaged +0.42R,
   losers −0.51R; stop-outs rose a median +2.65% within 4h of the stop.

### Bugs fixed

1. 🔴 **Partial profits never recorded.** Partials sold units and realized
   cash, but trade history, Telegram stats, the daily tracker, the loss
   cooldown and the BAD-DAY rule saw only the runner's P&L (HOOD 09-03: +$37.70
   banked, +$44.07 recorded). ~$1,000 missing over 57 trades; 17 winning trades
   were recorded as losses and given loss cooldowns. Every earlier "audit" of
   this file inherited the bias. Now: partials book to the ledger when they
   fill and ride on the meta; the closed-trade record (one shared builder for
   exit monitor, EOD closer and `close-position.js`) is the whole trade, with
   both legs, MFE, MAE and giveback.
2 🔴 **Exit monitor blind during scans.** Exit ticks and the price-stream
   emergency path skipped while a scan ran (~133s of every 10 min). Replaced
   the skip flags with a position lock (`src/position-lock.js`) held only
   while positions are read/written.
3. 🟠 **Unserialised meta writers.** The EOD cron and the daily reviewer could
   save a stale copy of `position-meta.json` over a newer one. Both now run
   under the lock; the reviewer applies its verdicts to freshly loaded meta.
4. 🟠 **Reconciliation booked open P&L as realized**, then booked it again at
   close (the $10,098.27 "peak" on 08-21). Now compares realized with realized
   and always uses a fresh fetch.
5. 🟠 **Entries after the Friday force-close** (META 07-10, META+GOOGL 07-31,
   PLTR 08-07) ran into weekends with no exit monitor. Blocked; plus a 30-min
   pre-close window (Mon–Thu entries there: 2/7, −$113).
6. 🟡 **Stale quotes.** eToro rate timestamps were ignored: AMD was re-planned
   and re-screened 24× at a frozen $477.385 after the 09-04 close; 1,553 of
   7,015 plans were identical-price repeats. Quotes older than 15 min are
   dropped, and identical plans reuse a recent AI verdict.
7. 🟡 **"Today's" candles used the UTC date prefix**, so the previous ET
   evening leaked into today's VWAP/high/low.
8. 🟡 EOD closes stored `exitPrice: null`; the reviewer derived price from the
   bot's entry rather than eToro's fill.

### Strategy change (replay-validated)

DAY stop **0.5× → 1.0× daily ATR**, clamp 3% → 5%, same dollars at risk.
See the table in `config.js`. Out-of-sample avgR −0.080 → −0.027 (2,055
journal entries) and −0.149 → −0.032 (real trades); drawdown roughly halves.
**No tested change made the strategy profitable** — this reduces the bleed.

Tested and **rejected**: early-failure exits, wider MFE giveback, T1 at 1.5R
(no gain on top of the wider stop), removing the profit-stall lock (neutral),
**adding to winners at +1R** (mixed IS, flat OOS), range-position/anti-chase
entry filters (look-ahead artefact).

### Diagnostics

- `🧮 Funnel:` line + `SCAN_FUNNEL` journal record every scan.
- `📍` position status every 10 exit ticks + `POSITION_STATUS` record:
  HOLD / TRIM / RUNNER / WEAKENING / EXIT, P&L, peak, effective exit level,
  next trim, time budget left, banked partials.

### Tools

- `src/replay-exits.js` — exit-management replay with a virtual clock over
  the real engine. Calibrated on the 206 real trades with candles: mean
  simulated R −0.004 vs actual +0.009, same sign on 86% of trades.
- `src/replay-harness.js --data-dir` — run on a copy of server data.

### Not in scope

DE / TSM "cannot trim" messages come from **etoro-v2** (PM2 `etoro-bot` on the
other server), not this bot — this bot has no trim counter and never traded DE.

---

## 2026-09-02 — v7.13 · Manual VIX override + a bug-hunt pass

### Manual VIX override (`src/vix-override.js`)

FRED's VIXCLS is a daily **close** published with a lag — the bot ran the
whole 2026-09-01 session on the 2026-08-28 print. That is not a cosmetic
staleness: `market-regime` tightens its CHOP threshold when VIX is elevated,
so a stale-calm reading makes the bot treat a fearful tape as a quiet one.

```bash
node src/vix-override.js 28.5              # use 28.5 for 24h
node src/vix-override.js 28.5 "CPI day"    # with a note
node src/vix-override.js 28.5 --hours 6    # custom window
node src/vix-override.js --status          # which source is live
node src/vix-override.js --clear           # back to FRED now
```

Safety properties, each covered by a test:

- **Expires on its own** (default 24h) and reverts to FRED with no action —
  a number typed once can never silently drive the bot for weeks.
- **Refuses values outside 5–100.** A decimal slip would mis-drive the
  regime classifier all day; the VIX has never closed outside that range.
- **A refused value leaves the existing override intact.**
- **The source is always named in the log**, so no reading is ambiguous:
  `VIX (MANUAL override, 6.0h left, CPI day): 31.20 — FRED ignored until this expires`
  `VIX (FRED, 2026-08-28, 4 days old): 14.43`

FRED readings now also state their age when the print is 2+ days old. The
old line looked authoritative; "4 days old" does not.

No restart needed — the bot picks up the file on its next scan.
17 new tests, 324 total.

### Bug found in the override's own CLI, before shipping

Argument parsing excluded `args[hoursFlagIndex + 1]` to skip the `--hours`
value. With no `--hours` flag `indexOf` returns `-1`, so the expression
became `0` and swallowed **the VIX value itself**, reporting the note as
"not a number". Guarded.

### `computeRiskLevels()` — dead code with an inverted sign 🟡

Exported from `risk-manager.js`, **called from nowhere** in `src/` or
`test/` (verified). It applied the slippage buffer with the *same* sign to
the stop and the target. For a long those need opposite signs: a stop nudged
up triggers earlier (protective), but a target nudged up triggers *later*,
the opposite of what a slippage allowance is for.

The live path (`buildTradePlan`) was never affected. Fixed rather than
deleted, and marked clearly, so reviving it cannot reintroduce the error.

---

## 2026-09-01 — v7.12 · Half the watchlist was permanently retired 🔴

Found while investigating why the bot took zero trades. This is the root
cause, and it outranks everything in v7.11.

`checkCooldown()` expires the time window off `exitAtMs`.
`getReentryJustification()` **never read that field**, so the SCORE half of
the penalty was permanent. Nothing in the design intended it — the comment
only says the bar outlives the cooldown window, not that it lasts forever.

Measured on the live server:

```
symbols carrying a re-entry score penalty     26
of those, requiring a score of 90             24
oldest penalties     CRWV 41d · DELL 41d · AAPL 39d · MSFT 33d · AVGO 33d
highest score anywhere on the watchlist that day    87
```

**24 of 26 needed a 90 that the scorer never produced.** AAPL was gated by a
loss from 39 days ago. The list is almost exactly the mega-cap and semi
names — including the mega-cap bucket that was the **only profitable one**
in the forensic audit (68% win, +$202.99).

The July clamp fixed "mathematically impossible" (`priorScore + 15 > 100`).
This fixes "permanent", which was the other half of the same bug.

Added `DT_REENTRY_PENALTY_EXPIRY_HOURS` (default 120 = 5 trading days). A
loss six weeks old says nothing about today's setup; the penalty exists to
stop revenge-trading the same broken idea within days.

**Freed on deploy (24):** AAPL AMD ANET ARM AVGO BA CRWV DELL GOOGL HOOD
IONQ META MRVL MSFT MU NBIS PLTR QCOM RIVN RKLB SMCI SNAP SOFI TSM
**Still gated (2):** AFRM, AMZN — losses inside the 5-day window, working
as intended.

### Why this was invisible

META cleared the entry floor **three times** on 2026-09-01 (84, 87, 83) and
was blocked every time by the 90 bar. The log said "re-entry blocked",
which reads as a deliberate risk control rather than a stuck record. Only
counting how many symbols were in that state, and how old they were,
exposed it.

6 new tests, including the expiry boundary and proof a *fresh* loss is
still gated.

### Caught in a self-review of the same day's work

`downgradedFromSwing` (v7.11) was set on the plan and **never persisted**.
It lived in the in-memory plan object and died there, so the month's trade
history would have shown swing-grade setups as ordinary DAY trades with no
way to tell them apart — making the exact question the downgrade exists to
answer unanswerable. Now copied into `positionMeta.entryConditions`.

Also: `pipeline-fixes-v7-11.test.js` read `config.swingEntryDays`, which
does not exist (the key is `swingEntryDaysET`). It fell through to a `|| 2`
default and passed by luck rather than by testing what it claimed. Both
fixed; 307 tests.

### Correction to the v7.11 note

v7.11 said the binding constraint was the score-80 floor. That was
generalising from one session. Plans built per day tell a fuller story:

```
Jul – mid Aug   124–396 plans/day    3–7 trades/day
Aug 26 – 28      57–148 plans/day    3–7 trades/day
Aug 31 – Sep 1    31–76 plans/day    0 trades
```

The collapse tracks the v7.7/v7.8 filter stack landing **and** the re-entry
penalties accumulating past the point where enough symbols were locked out
to matter. The floor is real but secondary; it is still untouched, and
should now be judged on data gathered with the watchlist actually available.

---

## 2026-09-01 — v7.11 · Pipeline unblocked before the one-month run

Read a full live session end to end. The bot took **zero trades in ~10
hours**, and the logs explain why: three independent defects were quietly
emptying the funnel.

Measured from that day's journal and pm2 log:

```
watchlist candidates rejected   72   median score 36 · p90 70 · floor 80
plans reaching the AI screener  31
plans approved                   0
trades taken                     0
```

### Fix 1 — swing capacity now DOWNGRADES instead of discarding 🔴

`classifyTradeType()` returns `SWING` only when a candidate passes **every**
trend-persistence bar (TRENDING regime, RSI < 70, relative strength ≥ 1.5,
above VWAP). Failing any one already demotes it to `DAY`, which trades
normally.

With `DT_MAX_SWING_POSITIONS=0` (swings paused since v7.7), the old check
`swingCount >= maxSwingPositions` evaluated `0 >= 0` — **true for every
swing-qualified candidate**. The result was an inverted quality filter:
clear every bar and you were thrown away; fail one and you were traded.

Observed live: `MMED` and `CRK` rejected as "swing slots full" on six
consecutive scans.

Now demoted to `DAY` and passed to the DAY slot check. The plan carries
`downgradedFromSwing: true` so a month of live results can answer whether
swings deserve re-enabling — with evidence rather than a guess. The DAY cap
is still enforced, so the downgrade cannot be used to exceed
`maxDayPositions`.

### Fix 2 — tradability is checked BEFORE enrichment, not after 🟠

`resolveTickerToInstrumentId()` ran inside `tryOpenPosition` — after
enrichment, after plan construction, and after the paid AI screener call.
Discovery routinely surfaces small US names eToro does not list, so the bot
spent the whole session enriching, planning and screening `RDIB`, `FGL`,
`NIPG`, `FCUV`, `WFCF` and `LEXX`. **Every plan that reached the screener
that day was unbuyable.**

Moved to the pre-filter loop. Watchlist candidates arrive from eToro's quote
path with `instrumentId` already set, so they cost nothing extra; only
discovered names trigger a lookup.

### Fix 3 — failed instrument lookups are cached 🟠

`instrumentIdCache` stored successes only, so unlistable symbols re-hit the
search API on every scan forever — roughly **600 wasted calls/day**, twice
per symbol per scan.

Added `instrumentIdNegativeCache` with a 6h TTL
(`DT_INSTRUMENT_NEGATIVE_CACHE_HOURS`). Deliberately **not** permanent:
eToro adds listings, and a transient search failure must never blacklist a
good symbol for the life of the process. Network/HTTP errors are not cached
at all — only a definitive "no acceptable match" from a successful search.

### Fix 4 — FMP analyst-actions 403 backs off, and says what it costs 🟡

`/upgrades-downgrades-rss-feed` is a premium FMP route not included in the
current key's plan. It returned 403 on **every** scan, and since only
successes were cached it retried every 10 minutes all day.

Now suppressed after the first 401/403 with a warning that names the real
consequence: `hasVerifiedBullishCatalyst` depends on this feed, so **the
entire analyst-catalyst path is dead** while it 403s — no candidate can earn
a catalyst override. That was invisible before.

### Fix 5 — `PLAN_REJECTED` records numbers, not prose ⭐

The highest-value change for the coming month. Rejections previously stored
only the reason string, with the score buried in text ("score 58 below the
entry floor of 80") and **no price at all**. That makes the month's central
question unanswerable: *"what would a floor of 65 have earned?"* needs a
numeric score and an entry price to measure forward returns from.

Now carries a structured snapshot — score, price, ATR%, move%, RSI, relative
strength, VWAP state, setup, source, sector bucket, regime, SPY change.

Since ~90% of candidates die at the floor, these records are the bulk of the
evidence: **a month with few trades still yields thousands of labelled
counterfactuals.**

### Fix 6 — de-risking warning logged on transition, not every call 🟡

`getCapitalState()` is called more than once per scan, so the de-risking
warning printed twice per cycle for the entire de-risked stretch. Now logs
on change, plus a "de-risking cleared" line that never existed.

### Also

- Entry-floor rejections print `toFixed(1)`. A rejected 79.6 printed as
  "score 80 below the entry floor of 80", which reads as an off-by-one bug
  that is not there.
- 14 new tests in `test/pipeline-fixes-v7-11.test.js` (300 total).

### What these fixes do NOT do

They do not make the bot trade more. On 2026-09-01's data the funnel would
have been **emptier**, not fuller — the untradable microcaps that reached
the screener are now dropped earlier, and nothing replaces them. The binding
constraint is unchanged: the score-80 floor against a watchlist whose median
score is 36 and p90 is 70.

The floor was deliberately **not** touched. It is a tuning decision, and
tuning it in the same change as three bug fixes would make the month's
results uninterpretable. Fix 5 exists precisely so that decision can be made
from data at the end of the month instead of guessed at now.

---

## 2026-09-01 — v7.10 · Every printed time is Bahrain; freeze re-anchored to ET

**The freeze shift had silently reverted.** The server `.env` was back to
`23:30–09:30` with `DT_OVERNIGHT_FREEZE_TIMEZONE` missing entirely, so the
freeze was running 16:30→02:30 ET — blocking the after-hours window the
audit found was the best one (80% win, +$15.17/trade at score ≥80).

Two causes, both now fixed:

1. The earlier edit used a regex that did not account for trailing comments.
   `DT_OVERNIGHT_FREEZE_ENABLED=true    # default on` did not match, so
   stale lines survived the rewrite.
2. `pm2 restart` without `--update-env` reuses the cached environment. A
   change could look applied and not be running. All restarts now pass it.

Re-applied as `00:00–04:00 America/New_York`, verified hour by hour:

```
Bahrain  ET      frozen?
06:00    23:00   open
07:00    00:00   FROZEN
10:00    03:00   FROZEN
11:00    04:00   open
23:00    16:00   open   ← after-hours restored
```

### All printed times converted to the operator's clock

Added `easternClockToLogZone(hour, minute)` to `market-hours.js`. It walks
today's UTC hours to find the instant matching an ET wall clock, then reads
it in `DT_LOG_TIMEZONE` — so it is DST-correct by construction rather than
by a hardcoded offset.

| Was | Now |
|---|---|
| `daily position review Mon-Thu 15:00 ET` | `22:00 Bahrain` |
| `EOD close at 15:45 ET` | `22:45 Bahrain` |
| `Overnight freeze (23:30-09:30 Bahrain)` | `07:00-11:00 Bahrain, tracks 00:00-04:00 ET` |
| `regular session opens at 9:30 AM ET` | `16:30 Bahrain (9:30 AM ET)` |

The ET anchor is deliberately kept in brackets. These schedules genuinely
**are** ET-anchored — that is what makes them auto-shift when US clocks
change — so hiding it would imply a fixed Bahrain time is configured.
Come 2026-11-01 the same config prints `08:00–12:00` with no intervention.

---

## 2026-08-28 — v7.9 · Replay harness, and two of its own findings reversed

Built `src/replay-harness.js` (Tier 2 offline replay). Read-only, touches no
trading code, safe to run while the bot is live.

**Why it exists:** the trade log only contains trades the bot actually took
(213). Loosening any filter creates trades that never existed, so the log is
silent on them. The journal holds **8,940 `CANDIDATE_SCORED` events** —
roughly 42 evaluated candidates per trade taken — which can be replayed
under any threshold using historical candles.

**It caught a bug in itself on first use.** Sweeps showed trade counts
*rising* as thresholds tightened, which is impossible. Cause:
`buildTradePlan()` applies `config.minEntryScore` internally, so every sweep
row was silently re-filtered at the live value (80) regardless of the value
under test. Fixed by overriding config per row and restoring it in a
`finally`. Also pins `sessionAwareTimeBudgets` off during replay, because it
measures elapsed session minutes against `Date.now()` and would make results
depend on what time of day the harness ran.

### Finding 1 — `move/ATR >= 1.0` was a small-sample artifact

Claimed from 213 real trades to be "the strongest filter found anywhere"
(45 trades, 62% win, +$315.48). Across 7,197 replayed candidates:

```
move/ATR   trades   avg/trade
>= 0        7197     +$1.17
>= 0.3      4990     +$2.84   <- best
>= 0.6      3445     +$2.77
>= 1.0      2362     +$2.29
>= 1.5      1549     +$0.24
```

Enabling it at 1.0 would have made things worse. It remains **disabled**.

### Finding 2 — the ATR ceiling sits at the worst value on the curve, and was left there anyway

7% was the bottom of the tested range (-$0.57/trade); 5% was the best
(+$2.28). Changed to 5.0, then **reverted to 7.0 the same day**.

The revert is the right call for two reasons, both about experiment design
rather than about which number is better:

1. **The curve is non-monotonic.** Tightening from "any" to 9% makes things
   *worse* before improving below 6%. A structural signal improves steadily
   as it tightens. This dips and rebounds, so part of the apparent edge is
   noise.
2. **Changing it now would contaminate the one-month test.** The month
   would be validating a setting chosen by the very evidence it is meant to
   check independently — and 5% roughly halves trade count (5153 → 2678)
   exactly when sample size matters most.

Re-run `--sweep atr` after the month, on data this setting did not help
select. If 5% still wins on a genuinely independent sample, change it then.

**This is the third time in one day that a threshold fitted to one sample
looked compelling and then moved** (score-80 degraded +$166.68 → -$33.22;
move/ATR≥1.0 was a small-sample artifact; ATR 7% vs 5%). The pattern is the
finding, more than any individual number.

### Reading replay numbers correctly

Absolute dollars are **meaningless** — the harness simulates every scored
candidate as a trade, with no position caps, cash limits, cooldowns or
sector caps. It measures **per-signal edge**, not portfolio outcome. Only
the relative comparison between rows is valid. Win rates read 42-45% vs 48%
live, as expected given replay assumes the stop hit first whenever stop and
target fall inside the same hourly candle.

Every change below is dated, states the **evidence** that motivated it, and
records what was **rejected or reverted** and why. Reversals are kept in
place deliberately: a change that was tried and undone is more useful to
remember than one that was never tried.

All P&L figures are **bot-account (agent portfolio) dollars** unless marked
otherwise. Telegram displays these scaled to the real copy account.

---

## Standing gotcha — read this before changing any config

`.env` **silently overrides** `src/config.js` defaults. Editing a default in
`config.js` does nothing if the key exists in `.env`.

This was hit twice on 2026-08-28 (`DT_MAX_CANDIDATES`,
`DT_MIN_AVG_DOLLAR_VOLUME`). In the first case it would have made the entire
watchlist diversification cosmetic — the new names would have been ranked
below the semis and cut before reaching the AI. **If a change appears to do
nothing, check `.env` first.**

---

## 2026-08-28 — v7.8 · Instrumentation for the one-month test

**Why:** the 2026-08-28 forensic audit had to *reconstruct* the raw entry
move (backed out of `relativeStrength + spyChangePercent`) and join sector
buckets from the watchlist file by hand. Reconstruction works only while
every input survives, and it fails silently when one changes.

**Added to `entryConditions` on every trade:**

| Field | Why it matters |
|---|---|
| `priceChangePercent` | Raw move at entry — previously not stored at all |
| `moveToAtrRatio` | Strongest predictor found: `>=1.0` cohort was 62% win / +$315.48; every band below lost money |
| `sectorBucket` | Sector P&L was the biggest finding of the audit; was only obtainable by joining the watchlist file |
| `sizeMultiplier` | So per-symbol sizing can be evaluated |
| `filtersActive` | Snapshot of the live filter config, so a later analysis can tell a **config change** apart from a **market change** |

Without these, a month of trading produces data that is far harder to
analyse than it needs to be. This is the highest-value change in v7.8.

---

## 2026-08-28 — v7.7 · Selection-bias fixes

### The core finding

Across 172 closed trades, grouped by watchlist sector bucket:

```
mega_cap    19 trades  11% of book  68% win  +$202.99   +$10.68/trade
semi        69 trades  40% of book  45% win  -$439.46    -$6.37/trade
```

The bot's **best** cohort was 11% of the book; its **worst** was 40%. The
mechanism is the pre-filter: it requires a >=1% intraday move before a stock
is even enriched with indicators. Semis average **7.58% ATR** and clear that
constantly; mega-caps average **3.57%** and clear it occasionally.

The scoring model then *amplifies* the bias — score rises with ATR, so
across buckets **score and profitability are inversely related** (ai: score
87.7, -$37.84 · mega_cap: score 71.4, +$202.99).

### Changed

| Change | Evidence |
|---|---|
| **ATR ceiling 7%** (`DT_MAX_ENTRY_ATR_PCT`) | `ATR<5%`: 55 tr, 56% win, +$31.13 · `ATR>=7%`: 67 tr, 43% win, **-$280.88** |
| **`maxCandidates` 8 → 12** | Candidates are sorted by score and sliced; without more slots the new low-ATR names rank below semis and never reach the AI |
| **RIVN removed** | `ev` bucket -$18.59/trade over 14 trades; RIVN alone -$140.54 |
| **TSLA kept at `sizeMultiplier: 0.5`** | Kept by explicit request; new per-symbol sizing field added so a name can be retained but traded smaller |
| **Discovery dollar-volume floor $2M → $15M** | Discovery is a "% biggest gainers" screen and surfaced only micro-cap pumps (CBRS +14.2%, RCMT, DUOT, BUUU, FXHO). **2 discovered trades ever executed, both losers, -$1.42** |
| **Ethics filter extended** | Added tobacco, interest-based banking, insurance, crypto-primary businesses. Matters because *discovery* pulls arbitrary tickers |
| **QCOM / MRVL / ANET added to sector map** | Pre-existing gap — on the watchlist but absent from `STATIC_BUCKETS`, so every scan paid a Finnhub lookup |

### Watchlist: 31 → 54 symbols, 18 sectors

Previously **zero** non-tech diversification apart from BA.

```
healthcare  LLY ISRG VRTX ABBV      energy      XOM COP
industrials CAT DE GE HON ETN       consumer    NKE HD
transport   UPS UNP FDX             automotive  GM F
software    CRM PANW                ecommerce   SHOP MELI
materials   LIN                     telecom     TMUS
```

**Rejected after checking, not assumed:**

- `CVX` — not available as an equity on eToro
- `TM` (Toyota), `HMC` (Honda), `RACE` (Ferrari) — listed but
  `isCurrentlyTradable=false`; orders would be rejected at execution
- `STLA` — not on eToro
- `COST`, `TGT` — meaningful alcohol/pork revenue, likely above the 5%
  threshold most Islamic screens use

### Honest caveat on the additions

Earlier in the same audit the advice was *"do not add symbols — the
bottleneck is the 1% gate, not coverage."* That advice was then partially
contradicted by adding 23 names on request.

The distinction that makes it defensible: the additions are mostly
**low-ATR**, which is the profitable cohort, and the ATR ceiling removes
their high-volatility competition. But this is an **untested bet**. The
one-month test exists partly to settle it.

---

## 2026-08-28 — REVERTED · Lowering the move gate

**Tried:** `prefilterMinMovePct` 1.0% → 0.6%, to let calm mega-caps into the
pipeline more often and raise trade count.

**Reverted the same day.** Testing against history:

```
move at entry   trades  win%    net P&L     avg
1% to 2%          44     50%    -$77.33    -$1.76
2% to 3%          31     48%   -$368.16   -$11.88
3% to 5%          31     39%   -$220.26    -$7.11
5%+               66     52%   +$156.29    +$2.37
```

The **0.6–1.0% band has zero historical trades** — history is silent on it —
and the adjacent 1–2% band already loses money. Lowering the gate would have
manufactured weaker setups, not better access to good ones.

### What the test found instead

The predictor is not the raw move but the move **relative to that stock's own
daily range**:

```
move/ATR ratio  trades  win%    net P&L     avg
0    to 0.3       35     46%   -$126.07    -$3.60
0.3  to 0.6       51     41%   -$440.42    -$8.64
0.6  to 1.0       41     44%   -$258.45    -$6.30
1.0+              45     62%   +$315.48    +$7.01   <- only profitable band
```

A 0.6% move on a 3.5% ATR mega-cap is a ratio of **0.17** — deep in the
losing zone. Implemented as `DT_MIN_MOVE_TO_ATR_RATIO`, **default 0
(disabled)**: enabling it at 1.0 cuts trade count ~74%, which conflicts with
the goal of trading more. That trade-off belongs to the operator.

---

## 2026-08-06 — v7.6 · Volatility read, contango-aware

VXX is used for **direction only, never as a level**. Its price tracks VIX
*futures*, bleeds under contango and has been reverse-split repeatedly —
VXX at $20.51 does **not** mean VIX 20.51. The absolute level stays with
FRED, explicitly labelled as the lagging daily close it is.

Two corrections to v7.4:

1. **Expansion no longer requires SPY to be red.** The old rule
   (`VXX>=3% AND SPY<0`) missed the most valuable case — volatility bidding
   up *before* the index turns. SPY falling is now confirmation (double
   vote), not a gate.
2. **Contango dead-band added.** VXX decays ~0.2–0.4%/day structurally, so
   its neutral baseline is slightly negative. A -0.3% print is decay, not
   "volatility falling", and is now labelled as such.

---

## 2026-08-06 — v7.5 · Log timezone + Telegram money

- **Log timestamps were in UTC, not Bahrain.** Server clock is `Etc/UTC` and
  winston stamped from it, so every log line was 3 hours behind what the
  same line's "X Bahrain" text implied. Now formatted in `DT_LOG_TIMEZONE`.
- **Telegram money now shows the real (copy) account only.** The weekly
  performance report and Friday self-evaluation were still printing raw
  bot-account dollars — they build from `computeStats()`/`totalPnl()`
  directly and never went through the shared formatter.

---

## 2026-08-06 — v7.4 · Edge filters + the DIA discovery

- **Score gate `DT_MIN_ENTRY_SCORE=80`** — every band below 80 lost money
  (-$476.24 combined). **See the v7.x caveat below: this has since degraded.**
- **Overnight dead zone 00:00–04:00 ET** — all 16 trades in that window lost
  (-$170.05, 31% win), and the score filter made it *worse* there, not
  better (3 high-score overnight trades: 0% win, -$27.07 each). Every other
  session is profitable at score>=80, so **24/5 stays enabled** and only this
  window closes.
- **`DIA` was resolving to a $0.11 crypto token.** eToro has no equity
  listing for that symbol; the only exact match was Diadata on its Digital
  Currency exchange. It fed a fabricated "Dow +5.30%" into the AI prompts.
  The resolver now **refuses cross-asset-class matches** — this was a
  *trading* risk, not just bad data, since the same resolver supplies
  instrument IDs for orders.
- **Live VXX replaces stale FRED VIX** for real-time volatility direction.
  Measured: server date 2026-08-06, newest FRED VIX 2026-08-04.

### Caveat recorded 2026-08-28

The score>=80 threshold **degraded on more data**:

```
                    then (114 trades)    now (172 trades)
score 80-100        +$166.68             -$33.22
```

It still cuts 69 trades worth **-$476.24**, so it earns its place — but the
surviving book is now roughly breakeven, not profitable. **80 is not a
validated number.** This is the overfitting risk that was flagged when it
shipped, and it materialised within days.

---

## Earlier fixes (condensed)

- **v7.3** — Phantom withdrawal: cash reserved for pending orders was
  excluded from equity, so equity read $2,764 instead of $9,314 and the
  auto-detector recorded a **$6,596.66 withdrawal that never happened**,
  rewriting the capital base. Fixed at the root; transfer detection now
  requires no pending orders **and** 3 consecutive confirmations.
- **v7.2** — Self-healing position sync (META was tracked at $2,150 vs a real
  $1,113.74 for four hours); current price now derived from eToro's real
  `openPrice`; untracked positions alerted and re-adopted; all seven eToro
  order arrays read, not just `positions`; **stale-cash overspend** fixed —
  five positions opened in one scan totalling 125% of capital because every
  plan checked the same pre-scan cash figure.
- **v7.1** — Node 20 returns hour **24** at midnight ET (`hour12:false`
  doesn't pin the hour cycle). Invisible in local testing on Node 22. Broke
  regime detection and RVOL for one hour every day. Also: day-position cap
  wasn't enforced at execution (3 allowed, 5 opened); permanent re-entry
  lockout above score 85; session-aware time budgets.

---

## Open items — not fixed

**Verified still open as of 2026-09-01, before the one-month run.**

0. **The FMP catalyst feed is dead** — but it is NOT suppressing approvals.
   🟡 *(Corrected 2026-09-01 — an earlier version of this entry called it a
   red blocker. That was wrong, and the correction is kept visible rather
   than edited away.)*

   `/upgrades-downgrades-rss-feed` is a premium route not on the current
   key; it 403s every scan (v7.11 stops the retry storm but cannot restore
   the data). The analyst-catalyst path and the swing catalyst override are
   therefore dead code.

   The claim that this was starving the screener came from reading only the
   DISCOVERED rejections. Split by source over six sessions:

   ```
   DISCOVERED    1 TAKE / 375 SKIP     0.3%
   WATCHLIST    15 TAKE / 127 SKIP    10.6%
   ```

   The pump-profile rule requires FOUR conditions together — discovered AND
   under ~$10 AND extreme move AND no verified catalyst — so it never fires
   on watchlist names. Their rejections cite tape and technicals ("risk-off
   tone, breadth 26%, RSI 76"), not catalysts. A 375-of-376 rejection rate
   on discovered pumps beside 10.6% approval on watchlist setups is correct
   calibration, not starvation.

   The zero-TAKE sessions were caused by watchlist plans never REACHING the
   screener (score floor + the v7.12 re-entry lockout), not by the screener
   refusing them. Real impact of the 403: no catalyst override, so nothing
   can earn a SWING on catalyst grounds. Worth fixing eventually; not a
   blocker for the one-month run.
1. **No backtest/replay harness.** ~135 tunables against 172 observations.
   Every threshold is fitted to a sample too small to distinguish edge from
   luck — as the score-80 degradation demonstrated. This remains the single
   highest-value piece of missing infrastructure.
2. **Fill mismatches.** Root cause (stale cash) is fixed, but the bot still
   cannot always read back what eToro actually filled.
3. **Bear-market readiness: F.** Long-only, no hedge, no inverse, no
   defensive rotation. Cannot profit from a decline — only avoid one.
4. **One setup does ~99% of trades.** `MOMENTUM_SURGE` dominates;
   `GAP_AND_GO` and `BREAKOUT` are effectively dead code.
5. **Discovery cannot find quality companies.** A "% gainers" screen
   structurally surfaces low-float spikes. Finding good companies needs a
   fundamentals screen, and there is no fundamentals feed.
