# AI decision-layer review — v7 (2026-07-25)

Covers the two Claude Haiku 4.5 calls in the day-trading bot: the entry
screener (`src/models/ai-screener.js`) and the daily position reviewer
(`src/models/ai-position-reviewer.js`).

---

## 1. Role split — why the screener is not a "portfolio manager"

The request asked for an institutional portfolio-manager role. That was
applied to the **reviewer**, which genuinely manages open risk across a book.
The **screener** was given a different institutional role — entry risk officer
— because it answers one binary question about a single plan whose price,
size, stop and targets are already fixed in code.

Casting the screener as a PM would invite it to re-do work it cannot do in
that seat (sizing, target selection, portfolio construction). That is not
hypothetical: the v5.6.1 header records the screener rejecting ~100% of plans
for weeks, and every rejection was a rationalisation about work it did not
own. Matching the role to the actual decision is what makes the institutional
framing help rather than hurt.

---

## 2. What each prompt now enforces

Both prompts share the same skeleton:

| Layer | Screener | Reviewer |
|---|---|---|
| Role | Entry risk officer | Portfolio manager, daily risk review |
| Separated lenses | Market / Technical / Risk / Decide | Market / Position / Risk / Decide |
| Reasoning before verdict | 3 reads emitted before `decision` | 3 reads + diagnosis + 6 estimates before `action` |
| Confidence | 1-10 + `confidenceRationale` | 1-10 + `confidenceRationale` |
| Evidence sufficiency | `unavailableData` field | `unavailableData` field |
| Anti-invention | Thresholds must be printed in-prompt | Same, plus "no headlines retrieved ≠ no news" |
| Consistency | Identical evidence → identical verdict | Identical evidence → identical action |

**Reasoning-before-verdict is structural, not advisory.** JSON is generated
top to bottom, so placing `decision`/`action` last means the verdict is
conditioned on reads the model already committed to in writing. This was
chosen over extended thinking deliberately: it costs ~60 output tokens rather
than Haiku's 1024-token minimum thinking budget, and unlike thinking tokens it
lands in the decision journal where it can be audited later.

**The `disqualifier` slot** is the specific fix for the mass-rejection
pathology. A SKIP must name one concrete blocking fact from a closed list; a
TAKE requires `disqualifier: null`. Vague objections have nowhere to go.

---

## 3. Dynamic trade management (reviewer)

Actions went from 3 to 5: `HOLD`, `EXTEND`, `TIGHTEN`, **`TAKE_PARTIAL`**,
**`CLOSE`**.

New estimates, all recorded on `positionMeta.lastReview` for later scoring:
`recoveryProbabilityPct`, `expectedUpsideRemainingPct`,
`maxAcceptableDrawdownPct`, `expectedHoldingPeriod`, `reviewIntervalMinutes`,
plus the loss diagnosis (`lossType`, `reversalEvidence`, `thesisStatus`,
`momentum`).

Two of these do real work rather than just being reported:

- **`maxAcceptableDrawdownPct` drives TIGHTEN.** The model just committed to a
  level in writing, so the stop is placed there — clamped so it can only ever
  tighten, and never inside `DT_REVIEWER_TIGHTEN_MIN_STOP_PCT` (0.5% default).
  Without that floor a model answering "0.3%" would place the stop inside
  normal spread and guarantee an instant stop-out.
- **The available action set is computed per position** and stated in the
  prompt. A live smoke test showed the model choosing `TAKE_PARTIAL` on a
  position that had already banked one — the guardrail refused it safely, but
  the review was wasted.

`reviewIntervalMinutes` is **advisory only**. Nothing currently reschedules on
it; the exit monitor's 1-minute tick already covers all hard risk. It is
captured so the cadence question can later be answered from evidence.

### How the new actions reach the market

`TAKE_PARTIAL` and `CLOSE` queue `positionMeta.pendingReviewerAction`. The
ordinary 1-minute exit monitor executes it through the same order and
accounting path as every other exit. This deliberately avoids a second
implementation of close accounting (realized P&L, cooldown, performance
record, journal, shadow tracking).

**Precedence:** the deterministic engine runs first and any `EXIT` it produces
wins outright — a stop-loss can never be displaced by a directive queued hours
earlier on stale prices. A queued partial is dropped if the tier was banked in
the meantime.

Every AI-initiated close is registered with the exit-shadow tracker, so "was
the AI right to bail?" becomes measurable at +30/60/120 minutes rather than a
matter of opinion.

---

## 4. Deliberately reported but NOT executed

`scaleInCase` and the averaging-down assessment are captured, surfaced and
journalled — but never wired to an order.

Adding to an open position is not a prompt change. It needs a re-entry risk
budget, capital-manager and slot plumbing, and it contradicts the
fixed-risk-per-trade architecture that every stop and size in this bot is
derived from. The bot also does not pyramid by design (held symbols are
excluded from candidates), and `DT_LOSS_COOLDOWN_MULTIPLIER` /
`DT_LOSS_REENTRY_MIN_SCORE_IMPROVEMENT` exist specifically to make re-entry
after a loss *harder*.

Collecting the assessment first means the decision to wire it can later be
made against evidence.

---

## 5. Requested but NOT built — no data source exists

Inventing prompt fields for these would manufacture exactly the hallucinations
this rewrite exists to prevent. Each is listed with what it would actually
take.

| Requested | Status | What it would need |
|---|---|---|
| NYSE advance/decline line, true market breadth | **Not built** | A breadth data feed. A *watchlist* breadth proxy is built and is labelled as such in the prompt so it can never be mistaken for the A/D line. |
| Per-stock beta | Not built | Rolling regression vs SPY over ~1y of daily bars, plus storage. Feasible from existing eToro candle data; a real piece of work. |
| Institutional ownership | Not built | A fundamentals provider (FMP has it on paid tiers). |
| Earnings behaviour / gap tendencies / support-resistance quality | Not built | Historical per-symbol statistics and a store to keep them in. |
| Economic calendar, Fed announcements, CPI/PPI, employment, GDP | Not built | CPI/GDP/payrolls are monthly and weeks stale by the time an intraday scan runs — near-zero signal for a day trade, and they give the model something vague to rationalise with. **The 10-year Treasury yield was added instead** (FRED `DGS10`, with its 1-session change in bp): rates are the one macro variable that re-prices whole sectors intraday. |
| Geopolitical risk assessment | **Not built** | A news feed plus a sentiment/geopolitical classifier. This is the largest gap and the highest hallucination risk if faked — a model asked to assess geopolitical risk with no geopolitical data will confidently invent it. |

Everything else requested in the market-intelligence section **was** built —
see §6.

---

## 6. Market brief (`src/strategies/market-context.js`)

One compact block, built once per scan, shared by both prompts. Roughly 198
tokens.

```
INDICES: SPY +0.42% · QQQ +0.71% · DIA +0.12% · IWM -0.30%
BREADTH: 12/20 scanned names up (60%) — watchlist breadth, NOT the NYSE A/D line
VOLATILITY: VIX 17.3 (calm) · regime TRENDING (SPY projected full-day range 0.94%)
RATES: US 10y 4.31% (+3.2bp vs prior session) as of 2026-07-24
SECTORS: leading semi +1.80% | lagging healthcare -0.90%
TONE: RISK_ON (computed by code from 5 available signals: 4 risk-on vs 1 risk-off — do not re-derive)
```

Three design rules:

1. **Nearly free.** One extra batched rates call per 10 minutes for the index
   ETFs (reusing the already-cached closing-price map) plus a 6h-cached FRED
   series. Sector data and VIX are passed in — already fetched by the scan.
2. **Honest absence.** A missing field renders `n/a` or `unavailable`, never a
   zero. This is the same lesson as the momentum-scanner `0.0x volume` bug: a
   model shown a fabricated 0 reads it as a measured 0.
3. **The code does the arithmetic.** `TONE` is computed by counting
   deterministic votes and stated as fact, exactly like the BAD-DAY rule, so
   two identical scans cannot disagree. Below
   `DT_MARKET_BRIEF_MIN_TONE_SIGNALS` available signals it returns `UNKNOWN`
   rather than guessing.

Sector rotation was already computed every scan but **only ever used as a
hidden scoring bonus** — it never reached either prompt. It now appears both
as market-wide leaders/laggards and as a per-stock `sector momentum: LEADING /
LAGGING` line, which is what makes "evaluate a stock within its sector's
context" actually possible.

---

## 7. Token cost — measured, not estimated

Measured with Anthropic's `count_tokens` endpoint against `claude-haiku-4-5`
(raw HTTP — the installed SDK 0.24.3 predates the helper).

| Prompt | v6 | v7 | Δ |
|---|---:|---:|---:|
| Screener, regular session | 1364 | 1402 | +38 (+2.8%) |
| Screener, overnight | 1366 | 1594 | +228 (+16.7%) |
| Position reviewer | 532 | 1818 | +1286 (+242%) |

Components of the v7 screener: system prompt 865 tokens (identical every
call), market brief 198 tokens.

**The screener is the honest headline: +38 tokens while carrying a 198-token
market brief that did not exist in v6.** Net of the new brief, the instruction
and evidence machinery is ~160 tokens *leaner* than v6 — the first draft was
+416, and a compression pass cut the system prompt from 1216 to 865 by letting
the output schema enforce the structure instead of prose describing it.

The reviewer grew a lot in relative terms and very little in absolute terms:
it runs roughly 5 times per day (Mon-Thu, one call per open position), so
+1286 tokens is about +6,400 input tokens/day — under $0.01/day at Haiku
pricing — in exchange for five actions, six estimates and a loss diagnosis.

**Prompt caching does not apply.** Haiku 4.5's minimum cacheable prefix is
4096 tokens and the system prompt is 865. Padding to 4096 to enable caching
would cost more than it saves. If the screener's static block ever exceeds
4096 tokens, revisit this — a `cache_control` breakpoint on the system block
would then pay for itself from the second candidate in each scan.

---

## 8. Live smoke-test results

One real Haiku call per case, checking schema validity and calibration:

| Case | Result |
|---|---|
| Clean watchlist setup, regular session | `TAKE` conf 7, `disqualifier: null` ✅ |
| Pump profile (discovered, $4.20, +62%, generic headline) | `SKIP` conf 3, named the pump profile precisely ✅ |
| Clean watchlist setup, **overnight** | `TAKE` conf 7 — **did not invent stricter overnight thresholds** ✅ |
| Reviewer, profitable DAY position, partial already banked | Valid action, all six estimates populated ✅ |

The overnight case is the important one: inventing stricter thresholds
("RSI 66 is near the ceiling", "1.5 RS needed overnight") was the documented
v6 failure and did not recur.

---

## 9. What to watch in the journal

1. **`CLOSE` calibration.** It is the only new action with real teeth. The
   confidence floor is 7 and every AI close is shadow-tracked — check whether
   closed positions recovered at +30/60/120 min.
2. **`disqualifier` distribution.** If SKIPs cluster on one reason, that rule
   is either miscalibrated or doing all the work.
3. **`unavailableData` contents.** Whatever the model repeatedly reports as
   missing is the highest-value next data source to wire.
4. **Estimate accuracy.** `recoveryProbabilityPct` and
   `expectedUpsideRemainingPct` are now recorded on every review — after
   enough samples they can be scored against real outcomes, which is the only
   way to know whether the estimates are worth their tokens.
5. **`screenerMinConfidenceToTake`** (default 4, permissive). A downgraded
   TAKE logs distinctly. Raise toward 6-7 only if low-confidence TAKEs are
   demonstrably losing.

---

## 10. Rollback

Everything is config-gated:

- `DT_MARKET_BRIEF_ENABLED=false` — prompts fall back to SPY % + regime word.
- `DT_REVIEWER_ALLOW_CLOSE=false`, `DT_REVIEWER_ALLOW_TAKE_PARTIAL=false` —
  reviewer returns to the v6 three-action behaviour.
- `DT_SCREENER_MIN_CONF_TAKE=1` — disables the confidence floor.

Prompt text itself is not env-gated; reverting it means reverting the commit.
