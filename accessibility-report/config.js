'use strict';

// API + polling settings, kept separate from implementation logic.

// Region codes come from the Accessibility "Geo Region Restriction" docs:
// US (default, no code) | eu | in
const REGION_CODES = ['eu', 'in'];

function resolveApiHost(env = process.env) {
  if (env.BROWSERSTACK_ACCESSIBILITY_API_HOST) {
    return env.BROWSERSTACK_ACCESSIBILITY_API_HOST.replace(/\/+$/, '');
  }
  const region = (env.BROWSERSTACK_ACCESSIBILITY_REGION || '').toLowerCase();
  if (region) {
    if (!REGION_CODES.includes(region)) {
      throw new Error(`Unsupported BROWSERSTACK_ACCESSIBILITY_REGION "${region}". Use one of: ${REGION_CODES.join(', ')}`);
    }
    return `https://api-accessibility-${region}.browserstack.com`;
  }
  return 'https://api-accessibility.browserstack.com';
}

const ENDPOINTS = {
  buildList: '/api/automated-tests/v1/builds',
  buildIssues: '/api/automated-tests/v1/builds/issues',
};

const POLLING = {
  POLLING_INTERVAL_MS: 1 * 60 * 1000, // 1 minute
  MAX_POLL_ATTEMPTS: 3, // includes the initial immediate check
};

const CORRELATION = {
  // How far from the SDK execution start an accessibility build's startedAt may be.
  START_TIME_TOLERANCE_MS: 15 * 60 * 1000,
  // Max build-list pages to walk while correlating.
  MAX_BUILD_LIST_PAGES: 20,
};

const OUTPUT_DIR = 'output/accessibility-reports';
const SDK_LOG_PATH = 'log/sdk-cli.log';

module.exports = { resolveApiHost, ENDPOINTS, POLLING, CORRELATION, OUTPUT_DIR, SDK_LOG_PATH, REGION_CODES };
