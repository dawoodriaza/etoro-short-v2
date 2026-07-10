// src/data-sources/sec-edgar.js
//
// v5.1 NEW MODULE — SEC EDGAR full-text search (completely free, no key,
// no rate-limit key required — just a required User-Agent identifying you,
// which SEC's fair-access policy requires).
//
// Job: FRESH INSIDER BUYING (Form 4). An open-market BUY by an officer or
// director, filed in the last 1-2 days, is a genuinely different discovery
// signal than price/volume — it's forward-looking information from people
// with the best view of the company, not a lagging technical confirmation.
//
// This uses EDGAR's full-text search endpoint filtered to Form 4 filings.
// It's a light-weight approximation (headline-level: "who filed a Form 4
// recently"), not a full transaction-code/derivative parse — good enough
// as a discovery TRIGGER; the trade planner and AI screener still do the
// real work of deciding if the setup is tradeable.
//
// Fails open: any error → [] and discovery proceeds without it.
require("dotenv").config();
const axios = require("axios");
const { logger } = require("../logger");

const EDGAR_FULL_TEXT_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";
// SEC requires a descriptive User-Agent with contact info for fair access.
const SEC_USER_AGENT =
  process.env.SEC_EDGAR_USER_AGENT ||
  "etoro-v2-short-bot research-contact@example.com";

let cachedFilers = null;
let cachedAtMs = 0;
const CACHE_MS = 60 * 60 * 1000; // Form 4s trickle in; hourly is plenty

// Returns [{ symbol, companyName, filedDate }] for Form 4s filed in the
// last 2 days. Best-effort ticker extraction from the company name — SEC's
// full-text search doesn't return tickers directly, so entries without a
// resolvable ticker are dropped (better to miss a few than guess wrong).
async function getRecentInsiderBuyFilers() {
  if (cachedFilers && Date.now() - cachedAtMs < CACHE_MS) {
    return cachedFilers;
  }

  try {
    const response = await axios.get(EDGAR_FULL_TEXT_SEARCH_URL, {
      params: {
        q: '"acquired" "10b5-1"', // rough heuristic text present in many open-market buy Form 4s
        forms: "4",
        dateRange: "custom",
        startdt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
        enddt: new Date().toISOString().slice(0, 10),
      },
      headers: { "User-Agent": SEC_USER_AGENT },
      timeout: 12000,
    });

    const hits = response.data?.hits?.hits || [];
    const seenTickers = new Set();
    const filers = [];

    for (const hit of hits) {
      const tickers = hit._source?.tickers || [];
      for (const rawTicker of tickers) {
        const symbol = String(rawTicker || "").toUpperCase();
        if (!symbol || seenTickers.has(symbol)) continue;
        seenTickers.add(symbol);
        filers.push({
          symbol,
          companyName: (hit._source?.display_names || [])[0] || symbol,
          filedDate: hit._source?.file_date || null,
        });
      }
    }

    cachedFilers = filers;
    cachedAtMs = Date.now();

    if (filers.length > 0) {
      logger.info(
        "🕵️ SEC EDGAR: " +
          filers.length +
          " ticker(s) with a recent insider Form 4 filing",
      );
    }
    return filers;
  } catch (fetchError) {
    logger.warn("SEC EDGAR fetch failed: " + fetchError.message);
    return [];
  }
}

module.exports = { getRecentInsiderBuyFilers };
