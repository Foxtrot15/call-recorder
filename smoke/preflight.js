#!/usr/bin/env node
// Standalone environment preflight — `npm run smoke:preflight`.
// Prints which env vars are set and exits non-zero if the suite is missing
// anything it needs to run. Handy as a fast pre-deploy sanity check without
// hitting the server.

const { checkEnv, formatReport } = require("./lib/env");

const result = checkEnv();
console.log(formatReport(result));

const failed = result.missingRunner.length > 0 ||
  (result.serverChecked && result.serverMissingCritical.length > 0);

process.exit(failed ? 1 : 0);
