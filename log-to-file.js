// log-to-file.js
//
// Shared helper: call setupFileLogging("test-0") at the top of any test
// script, and every console.log()/console.error() call from that point on
// gets written to BOTH the terminal AND a text file (e.g. test-0-output.txt)
// in this same folder. The file is overwritten fresh each run.
//
// This exists because the raw JSON responses from eToro are large and wrap
// awkwardly in a terminal — much easier to open the .txt file (or just
// attach/paste it) than to copy multi-line wrapped terminal output.
const fs = require("fs");
const path = require("path");

function setupFileLogging(scriptName) {
  const outputFilePath = path.join(__dirname, `${scriptName}-output.txt`);
  fs.writeFileSync(outputFilePath, `=== ${scriptName} run at ${new Date().toISOString()} ===\n\n`);

  const originalLog = console.log;
  const originalError = console.error;

  function formatArgs(args) {
    return args
      .map((arg) =>
        typeof arg === "string" ? arg : JSON.stringify(arg, null, 2),
      )
      .join(" ");
  }

  console.log = (...args) => {
    const line = formatArgs(args);
    originalLog(line);
    fs.appendFileSync(outputFilePath, line + "\n");
  };
  console.error = (...args) => {
    const line = formatArgs(args);
    originalError(line);
    fs.appendFileSync(outputFilePath, line + "\n");
  };

  originalLog(`(Full output also being saved to: ${outputFilePath})\n`);
  fs.appendFileSync(outputFilePath, ""); // ensure file exists even if nothing logged yet

  return outputFilePath;
}

module.exports = { setupFileLogging };
