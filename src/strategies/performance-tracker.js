// src/strategies/performance-tracker.js
//
// Records every closed trade and computes the metrics that actually tell you
// whether the bot makes money: win rate, average win, average loss, profit
// factor, expectancy. Without this you can only know if the bot works by
// watching the account balance — this makes it measurable.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { logger } = require("../logger");
const { humanize, toRealDollars } = require("../notifications/format-helpers");
const config = require("../config");

const tradeLogPath = path.join(__dirname, "../../data/trade-history.json");
const dataDir = path.dirname(tradeLogPath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function loadHistory() {
  try {
    if (!fs.existsSync(tradeLogPath)) return [];
    return JSON.parse(fs.readFileSync(tradeLogPath, "utf8"));
  } catch {
    return [];
  }
}
function saveHistory(history) {
  try {
    fs.writeFileSync(tradeLogPath, JSON.stringify(history, null, 2));
  } catch (saveError) {
    logger.warn("Could not save trade history: " + saveError.message);
  }
}

// ══════════════════════════════════════════════════════════════════════
// v8 — ONE DEFINITION OF A CLOSED TRADE'S RESULT.
//
// A partial exit realizes cash the moment it fills, but all three close
// paths (exit monitor, EOD closer, manual close-position.js) recorded only
// the LAST leg: position.unrealizedProfitLoss of whatever was still open.
// Measured 2026-09-03: HOOD banked half at +6.5% (~+$37.70) and
// trade-history recorded +$44.07 for the runner alone. Across 57 of 210
// trades the missing partial profit was roughly +$1,000 (agent dollars), so
// trade-history, the Telegram stats, the loss cooldown, the BAD-DAY rule
// and every threshold "audited" from that file understated each winner
// that reached a target.
//
// pnlDollars is now the WHOLE trade (partials + final leg) on the ORIGINAL
// amount; the legs are kept separately so either view can be rebuilt.
// Records written before this carry no pnlAccountingVersion.
function buildClosedTradeRecord({
  symbol,
  positionMeta,
  livePosition,
  exitReason,
  heldMinutes,
}) {
  const meta = positionMeta || {};
  const live = livePosition || {};
  const finalLegPnlDollars = Number(live.unrealizedProfitLoss || 0);
  const partialPnlDollars = Number(meta.realizedPartialPnl || 0);
  const pnlDollars = finalLegPnlDollars + partialPnlDollars;
  const originalDollarAmount =
    meta.originalDollarAmount || meta.dollarAmount || live.amountInvested || 0;

  const entryPrice = meta.entryPrice || live.openPrice || null;
  const priceBasis = live.openPrice || meta.entryPrice || null;
  const exitPrice = priceBasis
    ? priceBasis * (1 + (live.unrealizedProfitLossPercent || 0))
    : null;
  const percentFromEntry = (price) =>
    entryPrice && price && Number.isFinite(price)
      ? Number(((price / entryPrice - 1) * 100).toFixed(2))
      : null;
  const peakPrice = Math.max(meta.peakPrice || 0, exitPrice || 0) || null;
  const troughPrice =
    Math.min(meta.troughPrice || Infinity, exitPrice || Infinity) || null;
  const mfePercent = percentFromEntry(peakPrice);
  const exitPercent = percentFromEntry(exitPrice);

  return {
    symbol,
    setup: meta.setup,
    tradeType: meta.tradeType || "DAY",
    source: meta.source || "WATCHLIST",
    entryPrice,
    exitPrice: exitPrice != null ? Number(exitPrice.toFixed(4)) : null,
    dollarAmount: originalDollarAmount,
    remainingDollarAmount:
      meta.dollarAmount != null ? meta.dollarAmount : live.amountInvested ?? null,
    pnlDollars: Number(pnlDollars.toFixed(2)),
    pnlPercent:
      originalDollarAmount > 0 ? (pnlDollars / originalDollarAmount) * 100 : 0,
    finalLegPnlDollars: Number(finalLegPnlDollars.toFixed(2)),
    finalLegPnlPercent: (live.unrealizedProfitLossPercent || 0) * 100,
    partialPnlDollars: Number(partialPnlDollars.toFixed(2)),
    partialFills: meta.partialFills || [],
    mfePercent,
    maePercent: Number.isFinite(troughPrice) ? percentFromEntry(troughPrice) : null,
    givebackFromPeakPercent:
      mfePercent != null && exitPercent != null
        ? Number((mfePercent - exitPercent).toFixed(2))
        : null,
    exitReason,
    confidence: meta.confidence,
    openedAt: meta.openedAt ? new Date(meta.openedAt).toISOString() : null,
    heldMinutes,
    entryConditions: meta.entryConditions || null,
    plan: meta.plan || null,
    extendedByReviewer: !!meta.extendedByReviewerAt,
    // v8.3: set when the time budget ran out while red and the bot held for breakeven
    waitedForBreakevenSince: meta.waitingForBreakevenSince
      ? new Date(meta.waitingForBreakevenSince).toISOString()
      : null,
    pnlAccountingVersion: 2,
    // v10.2: eToro's position id (to match the broker's own trade history)
    // and the per-order commission this trade paid — one order to open,
    // one per partial, one to close. pnlDollars stays the market result so
    // every existing stat and threshold reads exactly as before.
    positionId: live.positionId || meta.positionId || null,
    commissionDollars: commissionForTrade(meta.partialFills),
    netPnlDollars: Number(
      (pnlDollars - commissionForTrade(meta.partialFills)).toFixed(2),
    ),
  };
}

function commissionForTrade(partialFills) {
  const perOrder = Number(config.commissionPerOrderDollars) || 0;
  return Number((perOrder * (2 + ((partialFills || []).length || 0))).toFixed(2));
}

// v10.2: what a trade actually did to the account: the best-known market
// result minus eToro's per-order commission. Records written before v10.2
// carry no commissionDollars, so it is worked out from their partial fills.
function tradeNetDollars(trade) {
  const commission =
    trade && trade.commissionDollars != null
      ? Number(trade.commissionDollars)
      : commissionForTrade(trade && trade.partialFills);
  return tradeResultDollars(trade) - commission;
}

function recordTrade(trade) {
  // trade: { symbol, setup, entryPrice, exitPrice, dollarAmount, pnlDollars,
  //          pnlPercent, exitReason, openedAt, closedAt, confidence }
  const history = loadHistory();
  history.push({
    ...trade,
    closedAt: trade.closedAt || new Date().toISOString(),
  });
  saveHistory(history);
}

// v8.1: the best-known result of one trade. v8 records (pnlAccountingVersion
// 2) already hold the whole trade. Older records hold only the runner leg;
// when src/backfill-partial-pnl.js has estimated the missing partial profit,
// it is added here. Every stat reads this, never raw pnlDollars.
function tradeResultDollars(trade) {
  const recorded = Number(trade && trade.pnlDollars) || 0;
  if (!trade || trade.pnlAccountingVersion === 2) return recorded;
  return recorded + (Number(trade.estimatedPartialPnlDollars) || 0);
}

// ══════════════════════════════════════════════════════════════════════
// v10.2 — ETORO'S OWN NUMBERS ON EACH TRADE.
//
// The bot books a trade at eToro's unrealized P&L a moment BEFORE the close
// order fills, so the fill itself (bid, slippage) never reached the record.
// Measured 2026-10-26: NVDA recorded +$12.40, eToro booked +$6.23.
//
// eToro's trade history has one row per closed piece: a partial close is a
// row of its own with the SAME open time and open rate. Rows are grouped
// into positions that way, then each bot record is matched to its position
// by positionId (records from v10.2 on) or, for older records, the nearest
// open time within 15 minutes. Matched records get brokerNetProfit (the sum
// over the pieces) and the real open/close rates; nothing else changes.
// Pure — the caller reads and writes the files.
// ══════════════════════════════════════════════════════════════════════
function groupBrokerRows(rows) {
  const groups = [];
  const sorted = [...(rows || [])].sort((a, b) =>
    String(a.openTimestamp).localeCompare(String(b.openTimestamp)),
  );
  for (const row of sorted) {
    const openMs = Date.parse(row.openTimestamp);
    const group = groups.find(
      (g) =>
        g.instrumentId === row.instrumentId &&
        Math.abs(g.openMs - openMs) < 60000 &&
        Math.abs(g.openRate - row.openRate) < 1e-9,
    );
    if (group) {
      group.rows.push(row);
      group.netProfit += Number(row.netProfit) || 0;
    } else {
      groups.push({
        instrumentId: row.instrumentId,
        openMs,
        openRate: row.openRate,
        rows: [row],
        netProfit: Number(row.netProfit) || 0,
      });
    }
  }
  return groups;
}

function attachBrokerResults(history, brokerRows) {
  const groups = groupBrokerRows(brokerRows);
  const used = new Set();
  const byPositionId = new Map();
  groups.forEach((g, i) => g.rows.forEach((r) => byPositionId.set(r.positionId, i)));
  let matched = 0;
  const updated = (history || []).map((trade) => {
    let index = trade.positionId != null ? byPositionId.get(trade.positionId) : undefined;
    if (index === undefined && trade.openedAt) {
      const openedMs = Date.parse(trade.openedAt);
      let best = null;
      groups.forEach((g, i) => {
        if (used.has(i)) return;
        if (trade.entryPrice && Math.abs(g.openRate / trade.entryPrice - 1) > 0.03) return;
        const gap = Math.abs(g.openMs - openedMs);
        if (gap < 15 * 60000 && (!best || gap < best.gap)) best = { i, gap };
      });
      if (best) index = best.i;
    }
    if (index === undefined || used.has(index)) return trade;
    used.add(index);
    matched++;
    const g = groups[index];
    const last = g.rows.reduce((a, b) =>
      String(a.closeTimestamp) > String(b.closeTimestamp) ? a : b,
    );
    return {
      ...trade,
      brokerNetProfit: Number(g.netProfit.toFixed(2)),
      brokerOpenRate: g.openRate,
      brokerCloseRate: last.closeRate,
      brokerPieces: g.rows.length,
    };
  });
  const brokerNet = groups.reduce((s, g) => s + g.netProfit, 0);
  const unmatched = groups.filter((g, i) => !used.has(i));
  return {
    history: updated,
    summary: {
      brokerRows: (brokerRows || []).length,
      brokerPositions: groups.length,
      brokerNetProfit: Number(brokerNet.toFixed(2)),
      // one order to open each position plus one per closed piece
      brokerOrders: groups.length + (brokerRows || []).length,
      matchedRecords: matched,
      unmatchedBrokerPositions: unmatched.length,
      unmatchedBrokerNetProfit: Number(
        unmatched.reduce((s, g) => s + g.netProfit, 0).toFixed(2),
      ),
    },
  };
}

// v8.1: overall stats plus the two accounting eras side by side, so the
// Telegram report stops mixing understated pre-fix records with v8 ones.
function computeStats(history) {
  const trades = history || loadHistory();
  const overall = computeStatsFor(trades);
  if (!overall.totalTrades) return overall;
  const afterFix = trades.filter((t) => t.pnlAccountingVersion === 2);
  const beforeFix = trades.filter((t) => t.pnlAccountingVersion !== 2);
  overall.segments = {
    afterFix: computeStatsFor(afterFix),
    beforeFix: computeStatsFor(beforeFix),
    beforeFixEstimated: beforeFix.some((t) => t.estimatedPartialPnlDollars != null),
  };
  return overall;
}

function computeStatsFor(trades) {
  if (trades.length === 0) {
    return { totalTrades: 0 };
  }
  const wins = trades.filter((t) => tradeResultDollars(t) > 0);
  const losses = trades.filter((t) => tradeResultDollars(t) <= 0);
  const grossWin = wins.reduce((sum, t) => sum + tradeResultDollars(t), 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + tradeResultDollars(t), 0));
  const totalPnl = grossWin - grossLoss;

  const winRate = (wins.length / trades.length) * 100;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const profitFactor =
    grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  // expectancy per trade in dollars
  const expectancy =
    (winRate / 100) * avgWin - ((100 - winRate) / 100) * avgLoss;

  // per-setup breakdown — which setups actually work
  const bySetup = {};
  for (const t of trades) {
    const key = t.setup || "UNKNOWN";
    if (!bySetup[key]) bySetup[key] = { trades: 0, wins: 0, pnl: 0 };
    bySetup[key].trades++;
    if (tradeResultDollars(t) > 0) bySetup[key].wins++;
    bySetup[key].pnl += tradeResultDollars(t);
  }

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    expectancy,
    totalPnl,
    bySetup,
  };
}

// v7.5: every dollar figure here is stored in trade-history.json as BOT
// (agent-account) dollars — computeStats() just sums pnlDollars as recorded.
// Run each one through toRealDollars() before it reaches Telegram, so this
// report matches every other Telegram message and your actual account.
// Win rate / profit factor are RATIOS and are unaffected by the copy scale.
// v8.1: the two accounting eras side by side. Only rendered when stats came
// from computeStats() (a hand-built stats object has no segments).
function formatAccountingEras(stats, money) {
  if (!stats.segments) return "";
  const line = (label, segment) =>
    segment && segment.totalTrades
      ? label +
        ": " +
        segment.totalTrades +
        " trades · " +
        segment.winRate.toFixed(1) +
        "% win · PF " +
        (segment.profitFactor === Infinity ? "∞" : segment.profitFactor.toFixed(2)) +
        " · " +
        money(segment.totalPnl)
      : label + ": no trades yet";
  return (
    "\n\n" +
    line("Since the v8 accounting fix", stats.segments.afterFix) +
    "\n" +
    line(
      stats.segments.beforeFixEstimated
        ? "Before the fix (partial profits estimated)"
        : "Before the fix (runner leg only — partial profits missing)",
      stats.segments.beforeFix,
    )
  );
}

function formatStatsForTelegram(stats) {
  if (!stats.totalTrades) return "No trades recorded yet.";
  const money = (value) =>
    (value >= 0 ? "+" : "") + "$" + toRealDollars(value).toFixed(2);
  const setupLines = Object.entries(stats.bySetup)
    .map(
      ([setup, s]) =>
        "  " +
        humanize(setup) +
        ": " +
        s.wins +
        "/" +
        s.trades +
        " win, " +
        money(s.pnl),
    )
    .join("\n");
  return (
    "📊 <b>Day-Trade Performance</b>\n\n" +
    "Trades: " +
    stats.totalTrades +
    " (" +
    stats.wins +
    "W / " +
    stats.losses +
    "L)\n" +
    "Win rate: " +
    stats.winRate.toFixed(1) +
    "%\n" +
    "Avg win: $" +
    toRealDollars(stats.avgWin).toFixed(2) +
    " · Avg loss: $" +
    toRealDollars(stats.avgLoss).toFixed(2) +
    "\n" +
    "Profit factor: " +
    (stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)) +
    "\n" +
    "Expectancy/trade: $" +
    toRealDollars(stats.expectancy).toFixed(2) +
    "\n" +
    "Total P&L: " +
    money(stats.totalPnl) +
    formatAccountingEras(stats, money) +
    "\n\n" +
    "By setup:\n" +
    setupLines
  );
}

module.exports = {
  tradeResultDollars,
  tradeNetDollars, // v10.2
  commissionForTrade, // v10.2
  attachBrokerResults, // v10.2
  groupBrokerRows, // v10.2
  buildClosedTradeRecord,
  recordTrade,
  computeStats,
  formatStatsForTelegram,
  loadHistory,
};
