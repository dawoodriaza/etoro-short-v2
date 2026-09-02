// test/run-tests.js — zero-dependency test runner (same style as the
// sibling long-term bot's test/run-tests.js).
// RUN: node test/run-tests.js
const path = require("path");

const testFiles = [
  "./exit-logic-v6.test.js",
  "./cooldown-tracker-v6.test.js",
  "./capital-manager-v6.test.js",
  "./market-context-v7.test.js",
  "./ai-decision-v7.test.js",
  "./production-fixes-v7.test.js",
  "./capital-transfer-v7.test.js",
  "./position-integrity-v7.test.js",
  "./overnight-freeze-v7.test.js",
  "./edge-filters-v7.test.js",
  "./telegram-money-and-logs-v7.test.js",
  "./selection-bias-v7.test.js",
  "./pipeline-fixes-v7-11.test.js",
];

(async () => {
  let totalPass = 0;
  let totalFail = 0;

  for (const testFile of testFiles) {
    const suite = require(path.join(__dirname, testFile));
    console.log("\n═══ " + suite.name + " ═══");
    let results;
    try {
      results = await suite.run();
    } catch (suiteError) {
      console.log("❌ SUITE CRASHED: " + suiteError.message);
      totalFail++;
      continue;
    }
    for (const result of results) {
      console.log((result.pass ? "✅ " : "❌ ") + result.label);
      result.pass ? totalPass++ : totalFail++;
    }
  }

  console.log(
    "\n══════════════════\n" +
      totalPass +
      " passed, " +
      totalFail +
      " failed\n",
  );
  process.exit(totalFail > 0 ? 1 : 0);
})();
