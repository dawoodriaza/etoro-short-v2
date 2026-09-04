// v7.13 — manual VIX override tests.
//
// The override exists because FRED's VIXCLS is a daily CLOSE published with
// a lag: the bot ran the 2026-09-01 session on the 2026-08-28 print. That
// matters because market-regime tightens its CHOP threshold on an elevated
// VIX, so a stale-calm reading makes it trade a fearful tape as a quiet one.
//
// What must hold: the override wins while live, EXPIRES on its own, refuses
// implausible values, and never leaves the source ambiguous.
const fs = require("fs");
const vixOverride = require("../src/vix-override");

module.exports = {
  name: "manual VIX override v7.13",
  run: async () => {
    const results = [];
    const check = (label, pass) => results.push({ label, pass });

    const filePath = vixOverride.overrideFilePath;
    const hadFile = fs.existsSync(filePath);
    const original = hadFile ? fs.readFileSync(filePath, "utf8") : null;

    try {
      // ── Clean slate: no override means FRED ──────────────────────────
      vixOverride.clearOverride();
      check(
        "no override -> falls through to FRED",
        vixOverride.getActiveOverride() === null,
      );

      // ── Setting one makes it active ──────────────────────────────────
      const set = vixOverride.setOverride(28.5, 24, "CPI day");
      check("set returns the stored record", set.value === 28.5);
      const active = vixOverride.getActiveOverride();
      check(
        "an active override is returned with its value",
        active !== null && active.value === 28.5,
      );
      check("the note is preserved", active.note === "CPI day");
      check(
        "remaining time is positive and within the window",
        vixOverride.hoursRemaining(active) > 23 &&
          vixOverride.hoursRemaining(active) <= 24,
      );

      // ── FRED must actually honour it ─────────────────────────────────
      // The whole feature is worthless if the consumer ignores the file,
      // so this asserts the real getLatestVix() path, not just the store.
      const fred = require("../src/data-sources/fred");
      const returned = await fred.getLatestVix();
      check(
        "fred.getLatestVix() returns the manual value while active",
        returned === 28.5,
      );

      // ── Expiry is the safety property ────────────────────────────────
      // A number typed once must never drive the bot indefinitely.
      const expired = {
        value: 33,
        setAt: new Date(Date.now() - 48 * 3600000).toISOString(),
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        hours: 24,
        note: null,
      };
      fs.writeFileSync(filePath, JSON.stringify(expired));
      check(
        "an expired override is ignored",
        vixOverride.getActiveOverride() === null,
      );
      check(
        "an expired override is deleted, not left on disk",
        !fs.existsSync(filePath),
      );

      // ── Boundary: still live one minute before expiry ────────────────
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          value: 22,
          setAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          hours: 24,
          note: null,
        }),
      );
      check(
        "an override is honoured right up to its expiry",
        (vixOverride.getActiveOverride() || {}).value === 22,
      );

      // ── Typo guard ───────────────────────────────────────────────────
      // A decimal slip here silently mis-drives the regime classifier all
      // day, so implausible values are refused rather than stored.
      let rejectedHigh = false;
      try {
        vixOverride.setOverride(285, 24);
      } catch {
        rejectedHigh = true;
      }
      check("a VIX above the plausible range is refused", rejectedHigh);

      let rejectedLow = false;
      try {
        vixOverride.setOverride(0.5, 24);
      } catch {
        rejectedLow = true;
      }
      check("a VIX below the plausible range is refused", rejectedLow);

      let rejectedText = false;
      try {
        vixOverride.setOverride("abc", 24);
      } catch {
        rejectedText = true;
      }
      check("a non-numeric VIX is refused", rejectedText);

      let rejectedHours = false;
      try {
        vixOverride.setOverride(20, 0);
      } catch {
        rejectedHours = true;
      }
      check("a zero-length window is refused", rejectedHours);

      // A refused value must not have overwritten what was already there.
      check(
        "a refused value leaves the existing override intact",
        (vixOverride.getActiveOverride() || {}).value === 22,
      );

      // ── Clearing works and is idempotent ─────────────────────────────
      check("clear removes an active override", vixOverride.clearOverride());
      check(
        "clear on an empty state is a no-op, not an error",
        vixOverride.clearOverride() === false,
      );
      check(
        "after clearing, the source is FRED again",
        vixOverride.getActiveOverride() === null,
      );
    } finally {
      if (hadFile) fs.writeFileSync(filePath, original);
      else if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    return results;
  },
};
