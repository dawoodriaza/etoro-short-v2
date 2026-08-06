// src/strategies/market-context.js
//
// v7 NEW MODULE — THE MARKET BRIEF.
//
// Before v7 both AI calls saw the market through a pinhole: the screener got
// SPY's % change plus a regime word, and the daily position reviewer got the
// same two values from the PREVIOUS scan. Everything else the bot already
// knew about the tape — sector rotation (computed every scan, used only as a
// hidden scoring bonus and never shown to the model), the VIX (fetched, used
// only to nudge one threshold), the breadth of its own watchlist (implicit in
// data already in memory) — never reached either prompt.
//
// This module assembles that into ONE compact brief, built once per scan
// cycle and shared by both prompts. Design rules:
//
//   1. NEARLY FREE. The only new network work is a single batched rates call
//      for 4 index ETFs (reusing the already-cached closing-price map, the
//      same proven path sector-rotation.js uses) plus one 6h-cached FRED
//      series. Sector data and the VIX are PASSED IN by the caller — already
//      fetched, so there is no second fetch.
//   2. NEVER BLOCKS. Every field degrades to null and every failure path
//      returns a usable brief. A macro nicety must never stop a scan.
//   3. HONEST ABSENCE. A missing field renders as an explicit "n/a" or
//      "unavailable", never as a zero or a silent omission. This is the same
//      lesson as the momentum-scanner "0.0x volume" bug: a model shown a
//      fabricated 0 reads it as a measured 0 and reasons confidently from it.
//   4. THE CODE DOES THE ARITHMETIC. riskTone is computed here by counting
//      deterministic votes, so the same tape always produces the same tag —
//      the model is told the conclusion as a fact, exactly like the BAD-DAY
//      rule. Two identical scans cannot disagree because the model felt
//      differently about the numbers.
//
// DELIBERATELY NOT INCLUDED (no data source exists; see docs/ai-prompt-
// review-2026-07-25.md): NYSE advance/decline line, per-stock beta,
// institutional ownership, the economic calendar, Fed announcements,
// CPI/PPI/GDP/employment prints, and geopolitical risk. Inventing prompt
// fields for those would manufacture exactly the hallucinations this rewrite
// exists to prevent.
require("dotenv").config();
const { logger } = require("../logger");
const config = require("../config");
const etoroMarketData = require("../data-sources/etoro-market-data");
const etoroClient = require("../etoro-client");
const fred = require("../data-sources/fred");

// Broad-market ETFs. SPY is deliberately absent — the caller already has a
// real SPY quote from the scan and passes it in, so re-fetching would spend a
// call to learn something we know.
const INDEX_ETFS = {
  QQQ: "Nasdaq-100",
  // DIA (Dow 30) REMOVED 2026-08-06. eToro has no equity/ETF listing for
  // this symbol — the only exact match is "DIA", a $0.11 crypto token on
  // its Digital Currency exchange. That produced a fabricated "Dow +5.30%"
  // in the market brief and fed it to the AI prompts as fact. The resolver
  // now refuses cross-asset-class matches (see etoro-client.js), so the
  // symbol would resolve to null anyway; removing it keeps the brief
  // honest instead of permanently printing "DIA n/a".
  IWM: "Russell 2000",
  // v7.4 — LIVE VOLATILITY. FRED's VIXCLS is a daily CLOSE published with
  // a lag: measured on 2026-08-06 the newest value available was
  // 2026-08-04, and a 6h client cache sits on top of that. Every distinct
  // VIX date in the entire log is a prior trading day. For a bot deciding
  // on a 10-minute cycle, that input is 1-3 days stale at all times, and
  // the VIX can move 30% in one session.
  //
  // eToro does not list the VIX index, but it does list VXX (verified live,
  // instrumentId 3163) — short-term VIX futures. It costs nothing: this
  // batched rates call already runs every cycle, so VXX is one more
  // instrument in a request we were making anyway. No new key, no new
  // provider, no new failure mode, and real-time instead of two days late.
  //
  // It also changes the semantics usefully. An absolute VIX level answers
  // "how fearful was the market at Monday's close"; VXX's live change
  // answers "is volatility expanding right now", which is the question an
  // intraday system actually needs. FRED is kept as the slow absolute
  // reference and for the 10-year yield.
  VXX: "Volatility (short-term VIX futures)",
};

const VIX_CALM_BELOW = 20;
const VIX_ELEVATED_ABOVE = 25;

let cachedIndexChanges = null;
let cachedIndexAtMs = 0;

// ── Index ETF changes (one batched call, ~10 min cache) ─────────────────────
async function fetchIndexChanges() {
  const now = Date.now();
  const cacheMs = config.marketBriefIndexCacheMinutes * 60 * 1000;
  if (cachedIndexChanges && now - cachedIndexAtMs < cacheMs) {
    return cachedIndexChanges;
  }
  if (!etoroMarketData.isConfigured()) return {};

  try {
    const instrumentIdByTicker = {};
    for (const ticker of Object.keys(INDEX_ETFS)) {
      const instrumentId = await etoroClient.resolveTickerToInstrumentId(ticker);
      if (instrumentId) instrumentIdByTicker[ticker] = instrumentId;
    }

    const instrumentIds = Object.values(instrumentIdByTicker);
    if (instrumentIds.length === 0) return {};

    const [ratesByInstrumentId, closingPriceByInstrumentId] = await Promise.all([
      etoroMarketData.fetchBatchedRates(instrumentIds),
      etoroMarketData.getClosingPriceMap(),
    ]);

    const changeByTicker = {};
    for (const [ticker, instrumentId] of Object.entries(instrumentIdByTicker)) {
      const rate = ratesByInstrumentId[instrumentId];
      const previousClose = closingPriceByInstrumentId[instrumentId]?.daily;
      if (!rate || !previousClose) continue;
      const currentPrice = (rate.ask + rate.bid) / 2;
      changeByTicker[ticker] =
        ((currentPrice - previousClose) / previousClose) * 100;
    }

    cachedIndexChanges = changeByTicker;
    cachedIndexAtMs = now;
    return changeByTicker;
  } catch (fetchError) {
    logger.warn("Index brief fetch failed (non-fatal): " + fetchError.message);
    return {};
  }
}

// ── Breadth, from quotes the scan ALREADY fetched (zero API cost) ───────────
//
// This is watchlist breadth, NOT the NYSE advance/decline line — a few dozen
// hand-picked momentum names are a biased sample of the market. It is still a
// genuine read on "is my universe participating or is one name carrying the
// tape", which is the question that matters for this bot. It is labelled as
// watchlist breadth everywhere it is rendered so the model can never mistake
// it for true market breadth.
function computeWatchlistBreadth(quotesBySymbol) {
  const changes = Object.values(quotesBySymbol || {})
    .map((quote) => (quote ? quote.priceChangePercent : null))
    .filter((change) => typeof change === "number" && !isNaN(change));

  if (changes.length < config.marketBriefMinBreadthSample) return null;

  const advancers = changes.filter((change) => change > 0).length;
  return {
    advancers,
    decliners: changes.length - advancers,
    total: changes.length,
    advancingPct: Number(((advancers / changes.length) * 100).toFixed(0)),
  };
}

// ── Sector leaders / laggards from the already-computed proxy changes ────────
function rankSectors(sectorProxyChanges) {
  const entries = Object.entries(sectorProxyChanges || {}).filter(
    ([, change]) => typeof change === "number" && !isNaN(change),
  );
  if (entries.length === 0) return { leaders: [], laggards: [] };

  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  const threshold = config.sectorRotationMinChangePct;
  const shape = ([bucket, change]) => ({ bucket, changePct: change });

  return {
    leaders: sorted
      .filter(([, change]) => change >= threshold)
      .slice(0, 3)
      .map(shape),
    laggards: sorted
      .filter(([, change]) => change <= -threshold)
      .slice(-3)
      .reverse()
      .map(shape),
  };
}

// ── Deterministic risk tone ────────────────────────────────────────────────
//
// Counts votes rather than asking the model to weigh the numbers, so the same
// inputs always yield the same tag. Returns UNKNOWN rather than guessing when
// too few signals are available — an honest "not enough evidence" is the
// whole point of this rewrite.
function classifyRiskTone({
  spyChangePercent,
  indexChanges,
  breadth,
  vix,
  volatilityExpanding,
}) {
  let riskOnVotes = 0;
  let riskOffVotes = 0;
  let availableSignals = 0;

  const voteOnChange = (change) => {
    if (typeof change !== "number" || isNaN(change)) return;
    availableSignals += 1;
    if (change > 0) riskOnVotes += 1;
    else if (change < 0) riskOffVotes += 1;
  };

  voteOnChange(spyChangePercent);
  voteOnChange(indexChanges.QQQ);
  voteOnChange(indexChanges.IWM); // small caps lead risk appetite in both directions

  if (breadth) {
    availableSignals += 1;
    if (breadth.advancingPct >= 55) riskOnVotes += 1;
    else if (breadth.advancingPct <= 45) riskOffVotes += 1;
  }

  if (typeof vix === "number") {
    availableSignals += 1;
    if (vix < VIX_CALM_BELOW) riskOnVotes += 1;
    else if (vix > VIX_ELEVATED_ABOVE) riskOffVotes += 1;
  }

  // v7.4: LIVE volatility expansion is a risk-off vote in its own right,
  // and unlike the FRED VIX level it reflects this minute rather than a
  // close from one to three days ago.
  if (volatilityExpanding === true) {
    availableSignals += 1;
    riskOffVotes += 1;
  }

  if (availableSignals < config.marketBriefMinToneSignals) {
    return { tone: "UNKNOWN", riskOnVotes, riskOffVotes, availableSignals };
  }
  if (riskOnVotes >= riskOffVotes + 2) {
    return { tone: "RISK_ON", riskOnVotes, riskOffVotes, availableSignals };
  }
  if (riskOffVotes >= riskOnVotes + 2) {
    return { tone: "RISK_OFF", riskOnVotes, riskOffVotes, availableSignals };
  }
  return { tone: "MIXED", riskOnVotes, riskOffVotes, availableSignals };
}

// ── Public: build the brief ────────────────────────────────────────────────
//
// spyChangePercent / regime / vix / sectorProxyChanges are all values the
// caller already has from the current scan. Only the index ETFs and the 10y
// yield are fetched here.
async function buildMarketBrief({
  spyChangePercent,
  regime,
  rangePct,
  vix,
  sectorProxyChanges,
  quotesBySymbol,
  session,
}) {
  const [indexChanges, tenYear] = await Promise.all([
    fetchIndexChanges(),
    fred.getTenYearYield().catch(() => null),
  ]);

  const breadth = computeWatchlistBreadth(quotesBySymbol);
  const { leaders, laggards } = rankSectors(sectorProxyChanges);

  // v7.4: live volatility read. Volatility is EXPANDING when VXX is rising
  // sharply while SPY falls — the two moving together in that direction is
  // what a genuine risk-off impulse looks like intraday. A stale daily VIX
  // close cannot express this at all.
  const vxxChange = indexChanges.VXX;
  const volatilityExpanding =
    typeof vxxChange === "number" &&
    vxxChange >= config.vxxExpansionPct &&
    typeof spyChangePercent === "number" &&
    spyChangePercent < 0;

  const toneResult = classifyRiskTone({
    spyChangePercent,
    indexChanges,
    breadth,
    vix,
    volatilityExpanding,
  });

  return {
    asOf: new Date().toISOString(),
    session: session || "REGULAR",
    spyChangePercent:
      typeof spyChangePercent === "number" ? spyChangePercent : null,
    indexChanges,
    breadth,
    vix: typeof vix === "number" ? vix : null,
    // v7.4: live volatility, alongside the slow FRED VIX level.
    vxxChangePercent: typeof vxxChange === "number" ? vxxChange : null,
    volatilityExpanding,
    tenYear,
    regime: regime || "UNKNOWN",
    rangePct: typeof rangePct === "number" ? rangePct : null,
    sectorLeaders: leaders,
    sectorLaggards: laggards,
    riskTone: toneResult.tone,
    riskToneDetail: toneResult,
  };
}

// ── Public: render the brief as compact prompt lines ────────────────────────
//
// Deliberately terse and label-value shaped rather than prose. This whole
// block costs roughly the same as two sentences of English while carrying
// every macro input the bot actually possesses.
function formatBriefForPrompt(brief) {
  if (!brief) return "MARKET BRIEF: unavailable this cycle.";

  const pct = (value) =>
    typeof value === "number" && !isNaN(value)
      ? (value >= 0 ? "+" : "") + value.toFixed(2) + "%"
      : "n/a";

  const lines = [];

  lines.push(
    "INDICES: SPY " +
      pct(brief.spyChangePercent) +
      " · QQQ " +
      pct(brief.indexChanges.QQQ) +
      " · IWM " +
      pct(brief.indexChanges.IWM),
  );

  lines.push(
    brief.breadth
      ? "BREADTH: " +
          brief.breadth.advancers +
          "/" +
          brief.breadth.total +
          " scanned names up (" +
          brief.breadth.advancingPct +
          "%) — watchlist breadth, NOT the NYSE A/D line"
      : "BREADTH: unavailable (too few quoted names this cycle)",
  );

  const vixLabel =
    brief.vix == null
      ? "VIX n/a"
      : "VIX " +
        brief.vix.toFixed(1) +
        (brief.vix > VIX_ELEVATED_ABOVE
          ? " (elevated)"
          : brief.vix < VIX_CALM_BELOW
            ? " (calm)"
            : " (normal)");
  // v7.4: the LIVE reading leads; the FRED close follows, explicitly
  // labelled as lagging so the model never mistakes it for current.
  const vxxLabel =
    brief.vxxChangePercent == null
      ? "VXX n/a"
      : "VXX " +
        pct(brief.vxxChangePercent) +
        (brief.volatilityExpanding ? " — VOLATILITY EXPANDING NOW" : "");
  lines.push(
    "VOLATILITY: " +
      vxxLabel +
      " · " +
      vixLabel +
      " (daily close, lags 1-3 days) · regime " +
      brief.regime +
      (brief.rangePct != null
        ? " (SPY projected full-day range " + brief.rangePct.toFixed(2) + "%)"
        : ""),
  );

  lines.push(
    brief.tenYear
      ? "RATES: US 10y " +
          brief.tenYear.value.toFixed(2) +
          "%" +
          (brief.tenYear.changeBps != null
            ? " (" +
              (brief.tenYear.changeBps >= 0 ? "+" : "") +
              brief.tenYear.changeBps.toFixed(1) +
              "bp vs prior session)"
            : " (1-session change unavailable)") +
          " as of " +
          brief.tenYear.asOf
      : "RATES: unavailable",
  );

  const describeSectors = (list) =>
    list.map((item) => item.bucket + " " + pct(item.changePct)).join(", ");
  if (brief.sectorLeaders.length > 0 || brief.sectorLaggards.length > 0) {
    lines.push(
      "SECTORS: leading " +
        (brief.sectorLeaders.length > 0
          ? describeSectors(brief.sectorLeaders)
          : "none") +
        " | lagging " +
        (brief.sectorLaggards.length > 0
          ? describeSectors(brief.sectorLaggards)
          : "none"),
    );
  } else {
    lines.push("SECTORS: no sector proxy showed a decisive move this cycle");
  }

  lines.push(
    "TONE: " +
      brief.riskTone +
      " (computed by code from " +
      brief.riskToneDetail.availableSignals +
      " available signal(s): " +
      brief.riskToneDetail.riskOnVotes +
      " risk-on vs " +
      brief.riskToneDetail.riskOffVotes +
      " risk-off — do not re-derive)",
  );

  return lines.join("\n");
}

module.exports = {
  buildMarketBrief,
  formatBriefForPrompt,
  computeWatchlistBreadth,
  classifyRiskTone,
  rankSectors,
  INDEX_ETFS,
};
