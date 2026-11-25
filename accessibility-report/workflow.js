'use strict';

const fs = require('fs');
const path = require('path');
const { resolveApiHost, ENDPOINTS, POLLING, CORRELATION, OUTPUT_DIR, SDK_LOG_PATH } = require('./config');

// ---------------------------------------------------------------------------
// Errors / status
// ---------------------------------------------------------------------------
class AccessibilityReportError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AccessibilityReportError';
    this.code = code; // machine-readable, see ERROR_CODES
    this.details = details;
  }
}

const ERROR_CODES = {
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS',
  MISSING_SDK_METADATA: 'MISSING_SDK_METADATA',
  BUILD_NOT_CORRELATED: 'BUILD_NOT_CORRELATED',
  AMBIGUOUS_BUILD: 'AMBIGUOUS_BUILD',
  MISSING_TH_BUILD_ID: 'MISSING_TH_BUILD_ID',
  AUTH_FAILED: 'AUTH_FAILED',
  INVALID_BUILD_ID: 'INVALID_BUILD_ID',
  MISSING_TASK_ID: 'MISSING_TASK_ID',
  API_ERROR: 'API_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TASK_EXPIRED: 'TASK_EXPIRED',
  TIMEOUT: 'TIMEOUT',
  INVALID_REPORT_URL: 'INVALID_REPORT_URL',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  INVALID_CSV: 'INVALID_CSV',
};

const defaultLogger = {
  info: (m) => console.log(`[a11y-report] ${m}`),
  warn: (m) => console.warn(`[a11y-report] WARN ${m}`),
  error: (m) => console.error(`[a11y-report] ERROR ${m}`),
};

const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// HTTP helpers (credentials only ever live inside the Authorization header)
// ---------------------------------------------------------------------------
function getCredentials(env = process.env) {
  const username = env.BROWSERSTACK_USERNAME;
  const accessKey = env.BROWSERSTACK_ACCESS_KEY;
  if (!username || !accessKey) {
    throw new AccessibilityReportError(
      ERROR_CODES.MISSING_CREDENTIALS,
      'BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY must be set in the environment.'
    );
  }
  return { username, accessKey };
}

function basicAuthHeader({ username, accessKey }) {
  return 'Basic ' + Buffer.from(`${username}:${accessKey}`).toString('base64');
}

/**
 * GET JSON from the Accessibility API. Network failures are thrown as NETWORK_ERROR
 * so callers can tell them apart from "report not ready" responses.
 * Response shape: { status, body }.
 */
async function apiGet(ctx, urlPath, query = {}) {
  const url = new URL(ctx.apiHost + urlPath);
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  let res;
  try {
    res = await ctx.fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: basicAuthHeader(ctx.credentials), Accept: 'application/json' },
    });
  } catch (err) {
    throw new AccessibilityReportError(ERROR_CODES.NETWORK_ERROR, `Network error calling ${urlPath}: ${err.message}`);
  }
  let body = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (_) {
      body = { raw: text.slice(0, 500) };
    }
  }
  // The live API wraps payloads as { success, data, error }; the docs show the bare payload.
  // Accept both: unwrap `data` when present, keep `error` for messages.
  if (body && typeof body === 'object' && body.data && typeof body.data === 'object' && 'success' in body) {
    body = { ...body.data, error: body.error };
  }
  return { status: res.status, body };
}

function raiseForStatus(status, body, what) {
  if (status === 401 || status === 403) {
    throw new AccessibilityReportError(ERROR_CODES.AUTH_FAILED, `Authentication failed (HTTP ${status}) while ${what}. Check BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY.`);
  }
  if (status < 200 || status >= 300) {
    const err = body && body.error;
    const msg = err && err.message ? err.message : JSON.stringify(err || body || {}).slice(0, 300);
    throw new AccessibilityReportError(ERROR_CODES.API_ERROR, `API error (HTTP ${status}) while ${what}: ${msg}`, { status, body });
  }
}

// ---------------------------------------------------------------------------
// 1. SDK execution context
// ---------------------------------------------------------------------------
/**
 * Reads the current SDK execution context.
 * Sources, in order of preference:
 *   1. BROWSERSTACK_TESTHUB_UUID in the environment (set by the SDK for the process it runs).
 *      Same value as the Test Reporting & Analytics build id, i.e. the accessibility `thBuildId`.
 *   2. The most recent execution recorded in the SDK log (log/sdk-cli.log):
 *      "Visit https://automation.browserstack.com/builds/<id>" + Config line (project/build name).
 */
function getCurrentSDKExecution({ env = process.env, logPath = SDK_LOG_PATH, readFile = fs.readFileSync, exists = fs.existsSync, logger = defaultLogger } = {}) {
  const exec = { thBuildId: null, buildName: null, projectName: null, startedAt: null, finishedAt: null, source: null };

  if (env.BROWSERSTACK_TESTHUB_UUID) {
    exec.thBuildId = env.BROWSERSTACK_TESTHUB_UUID;
    exec.source = 'env:BROWSERSTACK_TESTHUB_UUID';
  }

  if (exists(logPath)) {
    const lines = String(readFile(logPath, 'utf8')).split('\n');
    const visitRe = /^(\S+Z)\s.*Visit https:\/\/automation\.browserstack\.com\/builds\/([a-z0-9]+)/;
    let lastVisit = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(visitRe);
      if (m) {
        lastVisit = { index: i, finishedAt: m[1], id: m[2] };
        break;
      }
    }
    if (lastVisit) {
      // The nearest preceding Config line carries project/build names and the start time.
      let configLine = null;
      for (let i = lastVisit.index; i >= 0; i--) {
        if (lines[i].includes('Config :')) {
          configLine = lines[i];
          break;
        }
      }
      if (configLine) {
        const jsonStart = configLine.indexOf('{');
        try {
          const cfg = JSON.parse(configLine.slice(jsonStart));
          exec.buildName = cfg.buildName || null;
          exec.projectName = cfg.projectName || null;
        } catch (_) {
          logger.warn('Could not parse SDK Config line from log.');
        }
        exec.startedAt = configLine.split(' ')[0];
      }
      exec.finishedAt = lastVisit.finishedAt;
      if (!exec.thBuildId) {
        exec.thBuildId = lastVisit.id;
        exec.source = `log:${logPath}`;
      } else if (exec.thBuildId !== lastVisit.id) {
        logger.warn('Env build id differs from last build in SDK log; trusting env.');
        exec.startedAt = null;
        exec.finishedAt = null;
      }
    }
  }

  if (!exec.thBuildId && !exec.buildName) {
    throw new AccessibilityReportError(
      ERROR_CODES.MISSING_SDK_METADATA,
      `No SDK execution metadata found (no BROWSERSTACK_TESTHUB_UUID and no usable ${logPath}). Run tests with "npm run test:bstack" first.`
    );
  }
  return exec;
}

// ---------------------------------------------------------------------------
// 2. Build list + identification
// ---------------------------------------------------------------------------
async function getAccessibilityBuildList(ctx) {
  const builds = [];
  let nextPage;
  for (let page = 0; page < CORRELATION.MAX_BUILD_LIST_PAGES; page++) {
    const { status, body } = await apiGet(ctx, ENDPOINTS.buildList, { next_page: nextPage });
    raiseForStatus(status, body, 'listing accessibility builds');
    builds.push(...((body && body.builds) || []));
    const p = body && body.pagination;
    if (p && p.has_next && p.next_page) {
      nextPage = p.next_page;
    } else {
      return builds;
    }
  }
  ctx.logger.warn(`Stopped build-list pagination after ${CORRELATION.MAX_BUILD_LIST_PAGES} pages.`);
  return builds;
}

/**
 * Validate a thBuildId through the Accessibility API.
 * The live build-list response does not carry thBuildId (the docs say it does), so when the list
 * cannot confirm the id, the build-level report request is the validation: an unknown id is
 * rejected (404/422 -> INVALID_BUILD_ID), a known one returns a task_id.
 */
async function validateBuildId(ctx, thBuildId) {
  if (!thBuildId) throw new AccessibilityReportError(ERROR_CODES.MISSING_TH_BUILD_ID, 'No thBuildId available to validate.');
  const builds = await getAccessibilityBuildList(ctx);
  const match = builds.find((b) => b.thBuildId === thBuildId);
  if (match) return { build: match, validatedBy: 'build-list' };
  ctx.logger.info('thBuildId not present in the build list response; validating via the build-level report request instead.');
  return { build: null, validatedBy: 'report-request' };
}

/**
 * Establish which accessibility build belongs to this SDK execution. Never "latest build".
 *  - If the SDK exposed a thBuildId: validate it against the accessibility build list.
 *  - Otherwise correlate by build name + start time (within tolerance).
 *    More than one candidate => AMBIGUOUS_BUILD; zero => BUILD_NOT_CORRELATED.
 */
async function identifyCurrentBuild(ctx, execution) {
  if (execution.thBuildId) {
    ctx.logger.info(`SDK exposed build id (${execution.source}); validating via Accessibility API.`);
    const { build, validatedBy } = await validateBuildId(ctx, execution.thBuildId);
    return { thBuildId: execution.thBuildId, build, method: `sdk-build-id(${validatedBy})` };
  }

  if (!execution.buildName || !execution.startedAt) {
    throw new AccessibilityReportError(ERROR_CODES.BUILD_NOT_CORRELATED, 'SDK execution has no build id and not enough metadata (build name + start time) to correlate.');
  }
  const builds = await getAccessibilityBuildList(ctx);
  const execStart = Date.parse(execution.startedAt);
  const candidates = builds.filter((b) => {
    if (!b.thBuildId) return false;
    const nameOk = typeof b.name === 'string' && b.name.startsWith(execution.buildName);
    const t = Date.parse(b.startedAt);
    const timeOk = Number.isFinite(t) && Math.abs(t - execStart) <= CORRELATION.START_TIME_TOLERANCE_MS;
    return nameOk && timeOk;
  });
  if (candidates.length === 0) {
    throw new AccessibilityReportError(ERROR_CODES.BUILD_NOT_CORRELATED, `No accessibility build matched name "${execution.buildName}" near ${execution.startedAt}.`);
  }
  if (candidates.length > 1) {
    throw new AccessibilityReportError(
      ERROR_CODES.AMBIGUOUS_BUILD,
      `${candidates.length} accessibility builds match "${execution.buildName}" near ${execution.startedAt}; refusing to guess.`,
      { candidates: candidates.map((c) => ({ thBuildId: c.thBuildId, name: c.name, startedAt: c.startedAt })) }
    );
  }
  return { thBuildId: candidates[0].thBuildId, build: candidates[0], method: 'name+time' };
}

// ---------------------------------------------------------------------------
// 3. Build-level report generation + polling
// ---------------------------------------------------------------------------
async function initiateBuildReportGeneration(ctx, thBuildId) {
  const { status, body } = await apiGet(ctx, ENDPOINTS.buildIssues, { build_id: thBuildId });
  if (status === 404 || status === 422) {
    throw new AccessibilityReportError(ERROR_CODES.INVALID_BUILD_ID, `Build ${thBuildId} was rejected by the Accessibility API (HTTP ${status}).`, { status, body });
  }
  raiseForStatus(status, body, 'requesting build report generation');
  const taskId = body && body.task_id;
  if (!taskId || typeof taskId !== 'string') {
    throw new AccessibilityReportError(ERROR_CODES.MISSING_TASK_ID, 'Build report request succeeded but no task_id was returned.', { body });
  }
  return taskId; // preserved exactly as returned
}

/**
 * One availability check. Returns { state: 'ready'|'pending', reportLink? }.
 * Throws TASK_EXPIRED (404 / 410), AUTH_FAILED, API_ERROR, NETWORK_ERROR.
 */
async function checkBuildReportAvailability(ctx, taskId) {
  const { status, body } = await apiGet(ctx, ENDPOINTS.buildIssues, { task_id: taskId });
  if (status === 404 || status === 410) {
    throw new AccessibilityReportError(ERROR_CODES.TASK_EXPIRED, `task_id ${taskId} is no longer valid (HTTP ${status}).`, { status, body });
  }
  raiseForStatus(status, body, 'checking report availability');
  // Docs show `report_link`; the live API returns `reportLink`. Accept both.
  const link = body && (body.report_link || body.reportLink);
  if (typeof link === 'string' && link.trim()) {
    return { state: 'ready', reportLink: link.trim() };
  }
  return { state: 'pending' };
}

/**
 * Up to MAX_POLL_ATTEMPTS availability checks (first one immediate), POLLING_INTERVAL_MS apart.
 * No seventh check, and the same task_id is used throughout.
 * Network errors count as a failed check (they use up an attempt) but are logged distinctly.
 */
async function pollForBuildReport(ctx, taskId) {
  const { POLLING_INTERVAL_MS, MAX_POLL_ATTEMPTS } = ctx.polling;
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    try {
      const result = await checkBuildReportAvailability(ctx, taskId);
      if (result.state === 'ready') {
        ctx.logger.info(`Report link available on attempt ${attempt}/${MAX_POLL_ATTEMPTS}.`);
        return { reportLink: result.reportLink, attempts: attempt };
      }
      ctx.logger.info(`Attempt ${attempt}/${MAX_POLL_ATTEMPTS}: report not ready yet.`);
    } catch (err) {
      if (err.code === ERROR_CODES.NETWORK_ERROR) {
        ctx.logger.warn(`Attempt ${attempt}/${MAX_POLL_ATTEMPTS}: network error (${err.message}); will retry if attempts remain.`);
      } else {
        throw err; // auth / API error / expiry are not "not ready"
      }
    }
    if (attempt < MAX_POLL_ATTEMPTS) await ctx.wait(POLLING_INTERVAL_MS);
  }
  throw new AccessibilityReportError(ERROR_CODES.TIMEOUT, `TIMEOUT: report_link not available after ${MAX_POLL_ATTEMPTS} checks (task_id ${taskId}).`, { taskId });
}

// ---------------------------------------------------------------------------
// 4. Download + validate
// ---------------------------------------------------------------------------
function assertHttpsUrl(link) {
  let u;
  try {
    u = new URL(link);
  } catch (_) {
    throw new AccessibilityReportError(ERROR_CODES.INVALID_REPORT_URL, 'report_link is not a valid URL.');
  }
  if (u.protocol !== 'https:') {
    throw new AccessibilityReportError(ERROR_CODES.INVALID_REPORT_URL, 'report_link must be an HTTPS URL.');
  }
  return u;
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Downloads the signed URL as-is (no Authorization header: it is a pre-signed link).
 * Saves to output/accessibility-reports/accessibility-{buildId}-{timestamp}.csv.
 */
async function downloadBuildReportCSV(ctx, reportLink, thBuildId) {
  const url = assertHttpsUrl(reportLink);
  let res;
  try {
    res = await ctx.fetch(url.toString(), { method: 'GET' });
  } catch (err) {
    throw new AccessibilityReportError(ERROR_CODES.NETWORK_ERROR, `Network error downloading report: ${err.message}`);
  }
  if (!res.ok) {
    throw new AccessibilityReportError(ERROR_CODES.DOWNLOAD_FAILED, `CSV download failed (HTTP ${res.status}).`, { status: res.status });
  }
  const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
  const buffer = Buffer.from(await res.arrayBuffer());
  const outDir = path.resolve(ctx.outputDir);
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, `accessibility-${thBuildId}-${timestampForFile(ctx.now())}.csv`);
  fs.writeFileSync(filePath, buffer);
  return { filePath, contentType, bytes: buffer.length };
}

function validateDownloadedReport({ filePath, contentType }) {
  if (!fs.existsSync(filePath)) {
    throw new AccessibilityReportError(ERROR_CODES.INVALID_CSV, `Downloaded file does not exist: ${filePath}`);
  }
  const size = fs.statSync(filePath).size;
  if (size <= 0) {
    throw new AccessibilityReportError(ERROR_CODES.INVALID_CSV, `Downloaded CSV is empty: ${filePath}`);
  }
  // Format check without parsing/transforming: reject JSON/HTML error bodies saved as .csv.
  const head = fs.readFileSync(filePath, { encoding: 'utf8' }).slice(0, 200).trimStart();
  if (/^(<!doctype|<html|<\?xml)/i.test(head) || /^[{[]/.test(head)) {
    throw new AccessibilityReportError(ERROR_CODES.INVALID_CSV, 'Downloaded content looks like JSON/HTML, not CSV.');
  }
  if (contentType && /(text\/html|application\/json)/i.test(contentType)) {
    throw new AccessibilityReportError(ERROR_CODES.INVALID_CSV, `Unexpected content-type for CSV: ${contentType}`);
  }
  return { size };
}

// ---------------------------------------------------------------------------
// 4b. Read the Guideline(s) column (column H) from the downloaded CSV
// ---------------------------------------------------------------------------
const GUIDELINES_COLUMN_INDEX = 7; // column H (A=0 ... H=7)
const GUIDELINES_COLUMN_NAME = 'Guideline(s)';

/** Minimal RFC-4180 reader: handles quoted fields, escaped quotes ("") and newlines inside quotes. */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

/**
 * Reads column H ("Guideline(s)") of the downloaded CSV.
 * Returns { header, values (one per issue row, file order), distinct: [{ value, count }], criteria: [{ criterion, count }] }.
 * The column is located by header name first (so a reordered export still works) and falls back to position H.
 * The CSV file itself is not modified.
 */
function readGuidelines(filePath, { readFile = fs.readFileSync } = {}) {
  const rows = parseCsvRows(String(readFile(filePath, 'utf8')));
  if (rows.length === 0) {
    throw new AccessibilityReportError(ERROR_CODES.INVALID_CSV, `CSV has no rows: ${filePath}`);
  }
  const [header, ...data] = rows;
  let idx = header.findIndex((h) => h.trim() === GUIDELINES_COLUMN_NAME);
  if (idx === -1) idx = GUIDELINES_COLUMN_INDEX;
  if (idx >= header.length) {
    throw new AccessibilityReportError(ERROR_CODES.INVALID_CSV, `CSV has no column H (only ${header.length} columns).`);
  }
  const values = data.map((r) => (r[idx] || '').trim());

  const distinctMap = new Map();
  const criteriaMap = new Map();
  values.forEach((v) => {
    if (!v) return;
    distinctMap.set(v, (distinctMap.get(v) || 0) + 1);
    v.split(',').map((c) => c.trim()).filter(Boolean).forEach((c) => criteriaMap.set(c, (criteriaMap.get(c) || 0) + 1));
  });
  const byCountThenName = (a, b) => b.count - a.count || String(a.value || a.criterion).localeCompare(String(b.value || b.criterion));
  return {
    header: header[idx],
    values,
    distinct: [...distinctMap].map(([value, count]) => ({ value, count })).sort(byCountThenName),
    criteria: [...criteriaMap].map(([criterion, count]) => ({ criterion, count })).sort(byCountThenName),
  };
}

// ---------------------------------------------------------------------------
// 5. Orchestration
// ---------------------------------------------------------------------------
function buildContext(overrides = {}) {
  const env = overrides.env || process.env;
  return {
    apiHost: overrides.apiHost || resolveApiHost(env),
    credentials: overrides.credentials || getCredentials(env),
    fetch: overrides.fetch || globalThis.fetch,
    wait: overrides.wait || defaultWait,
    logger: overrides.logger || defaultLogger,
    polling: overrides.polling || POLLING,
    outputDir: overrides.outputDir || OUTPUT_DIR,
    now: overrides.now || (() => new Date()),
  };
}

/**
 * Runs the full flow for ONE SDK execution (one build, one task_id, one CSV).
 * Concurrent SDK executions each call this with their own execution -> independent ids.
 * Always resolves with a summary; it never throws for expected failures.
 */
async function executeAccessibilityReportWorkflow(overrides = {}) {
  const summary = {
    status: 'FAILED',
    thBuildId: null,
    taskId: null,
    attempts: 0,
    filePath: null,
    bytes: 0,
    guidelines: null,
    correlation: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  let ctx;
  try {
    ctx = buildContext(overrides);
    const execution = overrides.execution || getCurrentSDKExecution({ env: overrides.env || process.env, logger: ctx.logger });
    ctx.logger.info(`SDK execution: build="${execution.buildName}" project="${execution.projectName}" idSource=${execution.source}`);

    const identified = await identifyCurrentBuild(ctx, execution);
    summary.thBuildId = identified.thBuildId;
    summary.correlation = identified.method;
    ctx.logger.info(`Using accessibility build ${identified.thBuildId} (matched by ${identified.method}).`);

    summary.taskId = await initiateBuildReportGeneration(ctx, identified.thBuildId);
    ctx.logger.info(`Report generation task created: ${summary.taskId}`);

    const polled = await pollForBuildReport(ctx, summary.taskId);
    summary.attempts = polled.attempts;

    const downloaded = await downloadBuildReportCSV(ctx, polled.reportLink, identified.thBuildId);
    validateDownloadedReport(downloaded);
    summary.filePath = downloaded.filePath;
    summary.bytes = downloaded.bytes;
    summary.guidelines = readGuidelines(downloaded.filePath);
    summary.status = 'SUCCESS';
    ctx.logger.info(`CSV saved: ${downloaded.filePath} (${downloaded.bytes} bytes)`);
  } catch (err) {
    const logger = (ctx && ctx.logger) || defaultLogger;
    if (err instanceof AccessibilityReportError) {
      summary.status = err.code === ERROR_CODES.TIMEOUT ? 'TIMEOUT' : 'FAILED';
      summary.error = { code: err.code, message: err.message, details: err.details };
      if (err.code === ERROR_CODES.TASK_EXPIRED) {
        // Recovery: request a NEW task for the same build via build_id; never reuse the expired one.
        summary.error.recovery = `Re-run the workflow: it requests a fresh task_id via GET ${ENDPOINTS.buildIssues}?build_id={thBuildId}.`;
      }
    } else {
      summary.error = { code: 'UNEXPECTED', message: err.message };
    }
    logger.error(`${summary.error.code}: ${summary.error.message}`);
  }
  summary.finishedAt = new Date().toISOString();
  return summary;
}

module.exports = {
  AccessibilityReportError,
  ERROR_CODES,
  getCredentials,
  getCurrentSDKExecution,
  getAccessibilityBuildList,
  identifyCurrentBuild,
  validateBuildId,
  initiateBuildReportGeneration,
  checkBuildReportAvailability,
  pollForBuildReport,
  downloadBuildReportCSV,
  validateDownloadedReport,
  parseCsvRows,
  readGuidelines,
  executeAccessibilityReportWorkflow,
};
