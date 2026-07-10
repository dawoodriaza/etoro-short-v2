// src/strategies/sector-map.js
//
// v5 NEW MODULE — DYNAMIC CORRELATION BUCKETS.
//
// The old design was a hardcoded ticker→bucket dictionary in
// risk-manager.js. That had a silent, structural hole: every DISCOVERED
// ticker (by definition NOT on the watchlist) fell through to bucket
// "other" and completely BYPASSED the correlation guard — the trades most
// likely to cluster in a single hot theme got zero protection.
//
// New resolution order (first hit wins):
//   1. STATIC_BUCKETS — the curated map, kept for the watchlist names
//      (fast, free, and lets us group e.g. COIN/MARA/RIOT as "crypto_beta"
//      more intelligently than raw industry labels would).
//   2. Finnhub industry lookup (via data-sources/finnhub.js, disk-cached
//      forever) normalized through INDUSTRY_TO_BUCKET so a discovered
//      semiconductor still collides with NVDA/AMD in bucket "semi".
//   3. Raw lowercased Finnhub industry string — still a real bucket: two
//      discovered names from the same unknown industry collide with each
//      other, which is exactly what the guard exists for.
//   4. "other" — only when nothing is known (no key / API down). Same
//      behavior as before, but now it's the last resort, not the default
//      for every discovery.
//
// getSectorBucket() is async (may hit the network once per new ticker,
// then cached on disk forever). checkPreTradeSafety in risk-manager is
// async in v5 to await it.
require("dotenv").config();
const { logger } = require("../logger");
const finnhub = require("../data-sources/finnhub");

// Curated buckets for known names (formerly SECTOR_BUCKETS in risk-manager)
const STATIC_BUCKETS = {
  TSLA: "ev",
  RIVN: "ev",
  LCID: "ev",
  NIO: "ev",
  NVDA: "semi",
  AMD: "semi",
  SMCI: "semi",
  TSM: "semi",
  TSMC: "semi", // legacy alias — real ticker is TSM
  ASML: "semi",
  ARM: "semi",
  AVGO: "semi",
  MU: "semi",
  COIN: "crypto",
  MARA: "crypto",
  RIOT: "crypto",
  MSTR: "crypto",
  SOFI: "fintech",
  HOOD: "fintech",
  AFRM: "fintech",
  UPST: "fintech",
  PLTR: "ai",
  SOUN: "ai",
  IONQ: "ai",
  NBIS: "ai",
  RKLB: "space",
  DKNG: "consumer",
  RDDT: "social",
  SNAP: "social",
  META: "mega_cap",
  NFLX: "mega_cap",
  GOOGL: "mega_cap",
  AMZN: "mega_cap",
  MSFT: "mega_cap",
  AAPL: "mega_cap",
};

// Normalize common Finnhub industry labels into the SAME bucket names as
// the static map, so a discovered semi collides with watchlist semis.
const INDUSTRY_TO_BUCKET = {
  semiconductors: "semi",
  banking: "fintech",
  "financial services": "fintech",
  automobiles: "ev",
  "auto components": "ev",
  software: "ai",
  technology: "ai",
  media: "social",
  "internet content & information": "social",
  aerospace: "space",
  "aerospace & defense": "space",
  "hotels restaurants & leisure": "consumer",
  retail: "consumer",
  biotechnology: "biotech",
  pharmaceuticals: "biotech",
  "oil gas & consumable fuels": "energy",
  energy: "energy",
  "metals & mining": "materials",
};

// In-memory memo on top of finnhub's disk cache (avoids repeated awaits
// for the same symbol within one process lifetime).
const resolvedBucketBySymbol = {};

// SYNC fast path: static map only. Used where async isn't possible.
function getStaticBucket(symbol) {
  return STATIC_BUCKETS[(symbol || "").toUpperCase()] || null;
}

// ASYNC full resolution: static → Finnhub industry (normalized) → raw
// industry → "other".
async function getSectorBucket(symbol) {
  const upperSymbol = (symbol || "").toUpperCase();
  if (!upperSymbol) return "other";

  if (resolvedBucketBySymbol[upperSymbol]) {
    return resolvedBucketBySymbol[upperSymbol];
  }

  const staticBucket = getStaticBucket(upperSymbol);
  if (staticBucket) {
    resolvedBucketBySymbol[upperSymbol] = staticBucket;
    return staticBucket;
  }

  const industry = await finnhub.getCompanyIndustry(upperSymbol);
  if (industry) {
    const normalizedIndustry = industry.toLowerCase().trim();
    const mappedBucket = INDUSTRY_TO_BUCKET[normalizedIndustry];
    const resolvedBucket = mappedBucket || normalizedIndustry;
    resolvedBucketBySymbol[upperSymbol] = resolvedBucket;
    logger.info(
      "Sector bucket resolved: " +
        upperSymbol +
        " → '" +
        resolvedBucket +
        "'" +
        (mappedBucket ? " (normalized from '" + industry + "')" : ""),
    );
    return resolvedBucket;
  }

  // No key or lookup failed — last resort, same as old behavior
  resolvedBucketBySymbol[upperSymbol] = "other";
  return "other";
}

module.exports = { getSectorBucket, getStaticBucket, STATIC_BUCKETS };
