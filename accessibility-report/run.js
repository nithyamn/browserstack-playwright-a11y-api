'use strict';

// CLI: node accessibility-report/run.js
// Run AFTER `npm run test:bstack` has finished (the SDK writes the build id / names to log/sdk-cli.log).
try {
  require('dotenv').config();
} catch (_) {
  /* dotenv is optional here */
}
const { executeAccessibilityReportWorkflow } = require('./workflow');

executeAccessibilityReportWorkflow().then((summary) => {
  console.log('\n===== Accessibility report execution summary =====');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.status === 'SUCCESS' ? 0 : 1);
});
