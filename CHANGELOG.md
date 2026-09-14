# Change log — v7.x / v8.x series

Newest first. **Every change gets an entry here** (code, settings, deploys, data
repairs, reverted experiments). See README.md → "For AI agents".

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
