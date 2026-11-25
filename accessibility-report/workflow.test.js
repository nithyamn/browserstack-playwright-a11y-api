'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const wf = require('./workflow');
const { ERROR_CODES } = wf;

// ---------------------------------------------------------------- helpers
const TH = 'duinwkvpf2wv2qvo2hwckshkpclq9ahv23zv0qna';
const TASK = 'task_ABC.def-123_exactly/as=returned';
const CREDS = { username: 'user', accessKey: 'secret-key' };
const ENV = { BROWSERSTACK_USERNAME: 'user', BROWSERSTACK_ACCESS_KEY: 'secret-key' };
const silent = { info() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-'));

function res(status, body, { text, headers } = {}) {
  const raw = text !== undefined ? text : body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (headers || {})[k.toLowerCase()] || null },
    text: async () => raw,
    arrayBuffer: async () => Buffer.from(raw),
  };
}

/** Scripted fetch: routes get a queue of responses (or Error to throw). Records every call. */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const u = new URL(url);
    const key = u.origin + u.pathname + (u.searchParams.has('task_id') ? '?task_id' : u.searchParams.has('build_id') ? '?build_id' : '');
    const queue = routes[key];
    if (!queue || queue.length === 0) throw new Error(`unexpected request: ${key}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

const HOST = 'https://api-accessibility.browserstack.com';
const LIST = `${HOST}/api/automated-tests/v1/builds`;
const ISSUES_BUILD = `${HOST}/api/automated-tests/v1/builds/issues?build_id`;
const ISSUES_TASK = `${HOST}/api/automated-tests/v1/builds/issues?task_id`;
const CSV_URL = 'https://signed.example.com/report.csv?sig=abc';
const CSV_ROUTE = 'https://signed.example.com/report.csv';

function makeCtx(fetch, extra = {}) {
  const waits = [];
  return {
    ctx: {
      apiHost: HOST,
      credentials: CREDS,
      fetch,
      wait: async (ms) => waits.push(ms),
      logger: silent,
      polling: { POLLING_INTERVAL_MS: 1 * 60 * 1000, MAX_POLL_ATTEMPTS: 3 },
      outputDir: tmp(),
      now: () => new Date('2026-11-04T13:20:00.000Z'),
      ...extra,
    },
    waits,
  };
}

const build = (over = {}) => ({ id: 1, name: 'fashionstack-e2e-rca-demo #7', startedAt: '2026-11-04T13:16:00.000Z', thBuildId: TH, ...over });
const listOf = (builds) => res(200, { builds, pagination: { has_next: false } });
const CSV_BODY = 'Issue type,Issue name,Severity,Component,Behavior,Issue description,Affected page,Guideline(s)\nimage-alt,Image missing alt,Critical,c,b,d,/p,SC 1.1.1\n';

// ---------------------------------------------------------------- SDK execution metadata
test('SDK execution metadata: read from env var', () => {
  const exec = wf.getCurrentSDKExecution({ env: { BROWSERSTACK_TESTHUB_UUID: TH }, exists: () => false, logger: silent });
  assert.equal(exec.thBuildId, TH);
  assert.equal(exec.source, 'env:BROWSERSTACK_TESTHUB_UUID');
});

test('SDK execution metadata: read from SDK log (latest execution)', () => {
  const log = [
    '2026-10-26T12:48:11.888Z CLI info    Config : {"projectName":"Old","buildName":"old-build"}',
    '2026-10-26T12:50:00.000Z CLI info [TEST REPORTING AND ANALYTICS:module]  [oldoldold]  [x]  Visit https://automation.browserstack.com/builds/oldoldold to view',
    '2026-11-04T13:15:00.000Z CLI info    Config : {"projectName":"FashionStack Ecommerce","buildName":"fashionstack-e2e-rca-demo"}',
    `2026-11-04T13:17:30.516Z CLI info [TEST REPORTING AND ANALYTICS:module]  [${TH}]  [x]  Visit https://automation.browserstack.com/builds/${TH} to view`,
  ].join('\n');
  const exec = wf.getCurrentSDKExecution({ env: {}, exists: () => true, readFile: () => log, logger: silent });
  assert.equal(exec.thBuildId, TH);
  assert.equal(exec.buildName, 'fashionstack-e2e-rca-demo');
  assert.equal(exec.projectName, 'FashionStack Ecommerce');
  assert.equal(exec.startedAt, '2026-11-04T13:15:00.000Z');
});

test('SDK execution metadata: missing metadata is reported', () => {
  assert.throws(
    () => wf.getCurrentSDKExecution({ env: {}, exists: () => false, logger: silent }),
    (e) => e.code === ERROR_CODES.MISSING_SDK_METADATA
  );
});

// ---------------------------------------------------------------- build identification
test('correct build identification via SDK build id (validated through API)', async () => {
  const { ctx } = makeCtx(mockFetch({ [LIST]: [listOf([build({ thBuildId: 'other' }), build()])] }));
  const r = await wf.identifyCurrentBuild(ctx, { thBuildId: TH, source: 'env' });
  assert.equal(r.thBuildId, TH);
  assert.equal(r.method, 'sdk-build-id(build-list)');
});

test('build list without thBuildId (live API shape): id is accepted and validated by the report request', async () => {
  const { ctx } = makeCtx(mockFetch({ [LIST]: [listOf([build({ thBuildId: undefined })])] }));
  const r = await wf.identifyCurrentBuild(ctx, { thBuildId: TH, source: 'env' });
  assert.equal(r.thBuildId, TH);
  assert.equal(r.method, 'sdk-build-id(report-request)');
});

test('invalid build id: rejected by the build-level request (422) is reported as INVALID_BUILD_ID', async () => {
  const { ctx } = makeCtx(mockFetch({ [ISSUES_BUILD]: [res(422, { success: false, data: null, error: ['invalid build'] })] }));
  await assert.rejects(wf.initiateBuildReportGeneration(ctx, TH), (e) => e.code === ERROR_CODES.INVALID_BUILD_ID);
});

test('live API envelope { success, data, error } is unwrapped for task_id and report_link', async () => {
  const fetch = mockFetch({
    [ISSUES_BUILD]: [res(200, { success: true, data: { task_id: TASK, message: 'initiated' }, error: null })],
    [ISSUES_TASK]: [res(200, { success: true, data: { report_link: CSV_URL }, error: null })],
  });
  const { ctx } = makeCtx(fetch);
  assert.equal(await wf.initiateBuildReportGeneration(ctx, TH), TASK);
  assert.equal((await wf.checkBuildReportAvailability(ctx, TASK)).reportLink, CSV_URL);
});

test('correlation by name + time picks the matching build, not the latest', async () => {
  const builds = [
    build({ thBuildId: 'latest-unrelated', name: 'something-else', startedAt: '2026-11-04T14:00:00.000Z' }),
    build({ thBuildId: 'match' }),
  ];
  const { ctx } = makeCtx(mockFetch({ [LIST]: [listOf(builds)] }));
  const r = await wf.identifyCurrentBuild(ctx, { buildName: 'fashionstack-e2e-rca-demo', startedAt: '2026-11-04T13:15:00.000Z' });
  assert.equal(r.thBuildId, 'match');
  assert.equal(r.method, 'name+time');
});

test('ambiguous build identification stops and reports candidates', async () => {
  const builds = [build({ thBuildId: 'a' }), build({ thBuildId: 'b', startedAt: '2026-11-04T13:17:00.000Z' })];
  const { ctx } = makeCtx(mockFetch({ [LIST]: [listOf(builds)] }));
  await assert.rejects(
    wf.identifyCurrentBuild(ctx, { buildName: 'fashionstack-e2e-rca-demo', startedAt: '2026-11-04T13:15:00.000Z' }),
    (e) => e.code === ERROR_CODES.AMBIGUOUS_BUILD && e.details.candidates.length === 2
  );
});

test('no matching build reports correlation failure', async () => {
  const { ctx } = makeCtx(mockFetch({ [LIST]: [listOf([])] }));
  await assert.rejects(
    wf.identifyCurrentBuild(ctx, { buildName: 'x', startedAt: '2026-11-04T13:15:00.000Z' }),
    (e) => e.code === ERROR_CODES.BUILD_NOT_CORRELATED
  );
});

test('build list pagination follows next_page until has_next is false', async () => {
  const fetch = mockFetch({
    [LIST]: [
      res(200, { builds: [build({ thBuildId: 'p1' })], pagination: { has_next: true, next_page: 'TOKEN2' } }),
      res(200, { builds: [build({ thBuildId: 'p2' })], pagination: { has_next: false } }),
    ],
  });
  const { ctx } = makeCtx(fetch);
  const all = await wf.getAccessibilityBuildList(ctx);
  assert.deepEqual(all.map((b) => b.thBuildId), ['p1', 'p2']);
  assert.equal(fetch.calls.length, 2);
  assert.equal(new URL(fetch.calls[1].url).searchParams.get('next_page'), 'TOKEN2');
});

// ---------------------------------------------------------------- report generation
test('report-generation request uses build-level endpoint and extracts task_id exactly', async () => {
  const fetch = mockFetch({ [ISSUES_BUILD]: [res(200, { task_id: TASK })] });
  const { ctx } = makeCtx(fetch);
  const id = await wf.initiateBuildReportGeneration(ctx, TH);
  assert.equal(id, TASK);
  const url = new URL(fetch.calls[0].url);
  assert.equal(url.pathname, '/api/automated-tests/v1/builds/issues');
  assert.equal(url.searchParams.get('build_id'), TH);
  assert.ok(!/test-?case|test_id/i.test(fetch.calls[0].url), 'must not use the test-case endpoint');
});

test('Basic auth header is sent and credentials never appear in the URL', async () => {
  const fetch = mockFetch({ [ISSUES_BUILD]: [res(200, { task_id: TASK })] });
  const { ctx } = makeCtx(fetch);
  await wf.initiateBuildReportGeneration(ctx, TH);
  assert.equal(fetch.calls[0].opts.headers.Authorization, 'Basic ' + Buffer.from('user:secret-key').toString('base64'));
  assert.ok(!fetch.calls[0].url.includes('secret-key'));
});

test('missing task_id is reported', async () => {
  const { ctx } = makeCtx(mockFetch({ [ISSUES_BUILD]: [res(200, {})] }));
  await assert.rejects(wf.initiateBuildReportGeneration(ctx, TH), (e) => e.code === ERROR_CODES.MISSING_TASK_ID);
});

test('authentication failure (401) is reported', async () => {
  const { ctx } = makeCtx(mockFetch({ [ISSUES_BUILD]: [res(401, { error: { message: 'bad creds' } })] }));
  await assert.rejects(wf.initiateBuildReportGeneration(ctx, TH), (e) => e.code === ERROR_CODES.AUTH_FAILED);
});

test('API error (5xx) is reported with the HTTP status', async () => {
  const { ctx } = makeCtx(mockFetch({ [ISSUES_BUILD]: [res(500, { error: { message: 'boom' } })] }));
  await assert.rejects(wf.initiateBuildReportGeneration(ctx, TH), (e) => e.code === ERROR_CODES.API_ERROR && /500/.test(e.message));
});

test('missing credentials fail fast', () => {
  assert.throws(() => wf.getCredentials({}), (e) => e.code === ERROR_CODES.MISSING_CREDENTIALS);
});

// ---------------------------------------------------------------- polling
test('report available immediately: one check, no waiting', async () => {
  const { ctx, waits } = makeCtx(mockFetch({ [ISSUES_TASK]: [res(200, { report_link: CSV_URL })] }));
  const r = await wf.pollForBuildReport(ctx, TASK);
  assert.equal(r.attempts, 1);
  assert.equal(r.reportLink, CSV_URL);
  assert.equal(waits.length, 0);
});

test('report available after retries: same task_id each time, polling-interval waits between checks', async () => {
  const fetch = mockFetch({ [ISSUES_TASK]: [res(200, {}), res(200, { report_link: null }), res(200, { report_link: CSV_URL })] });
  const { ctx, waits } = makeCtx(fetch);
  const r = await wf.pollForBuildReport(ctx, TASK);
  assert.equal(r.attempts, 3);
  assert.deepEqual(waits, [60000, 60000]);
  fetch.calls.forEach((c) => assert.equal(new URL(c.url).searchParams.get('task_id'), TASK));
});

test('three-attempt maximum: exactly 3 checks, 2 waits, then TIMEOUT (no 4th check)', async () => {
  const fetch = mockFetch({ [ISSUES_TASK]: [res(200, {})] });
  const { ctx, waits } = makeCtx(fetch);
  await assert.rejects(wf.pollForBuildReport(ctx, TASK), (e) => e.code === ERROR_CODES.TIMEOUT);
  assert.equal(fetch.calls.length, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits.every((w) => w === 60 * 1000));
});

test('polling never creates a new task (no build_id calls)', async () => {
  const fetch = mockFetch({ [ISSUES_TASK]: [res(200, {})] });
  const { ctx } = makeCtx(fetch);
  await assert.rejects(wf.pollForBuildReport(ctx, TASK));
  assert.ok(fetch.calls.every((c) => !new URL(c.url).searchParams.has('build_id')));
});

test('network failure during polling is handled separately and consumes an attempt', async () => {
  const fetch = mockFetch({ [ISSUES_TASK]: [new Error('ECONNRESET'), res(200, { report_link: CSV_URL })] });
  const { ctx, waits } = makeCtx(fetch);
  const r = await wf.pollForBuildReport(ctx, TASK);
  assert.equal(r.attempts, 2);
  assert.equal(waits.length, 1);
});

test('persistent network failure ends in TIMEOUT after three checks', async () => {
  const fetch = mockFetch({ [ISSUES_TASK]: [new Error('ENOTFOUND')] });
  const { ctx } = makeCtx(fetch);
  await assert.rejects(wf.pollForBuildReport(ctx, TASK), (e) => e.code === ERROR_CODES.TIMEOUT);
  assert.equal(fetch.calls.length, 3);
});

test('auth failure while polling is fatal immediately (not treated as not-ready)', async () => {
  const fetch = mockFetch({ [ISSUES_TASK]: [res(401, {})] });
  const { ctx } = makeCtx(fetch);
  await assert.rejects(wf.pollForBuildReport(ctx, TASK), (e) => e.code === ERROR_CODES.AUTH_FAILED);
  assert.equal(fetch.calls.length, 1);
});

test('task ID expiry (404) is surfaced, not silently reused', async () => {
  const fetch = mockFetch({ [ISSUES_TASK]: [res(404, { error: { message: 'task not found' } })] });
  const { ctx } = makeCtx(fetch);
  await assert.rejects(wf.pollForBuildReport(ctx, TASK), (e) => e.code === ERROR_CODES.TASK_EXPIRED);
  assert.equal(fetch.calls.length, 1);
});

// ---------------------------------------------------------------- download + validation
test('CSV download saves accessibility-{buildId}-{timestamp}.csv and validates', async () => {
  const fetch = mockFetch({ [CSV_ROUTE]: [res(200, undefined, { text: CSV_BODY, headers: { 'content-type': 'text/csv' } })] });
  const { ctx } = makeCtx(fetch);
  const d = await wf.downloadBuildReportCSV(ctx, CSV_URL, TH);
  assert.match(path.basename(d.filePath), new RegExp(`^accessibility-${TH}-.+\\.csv$`));
  assert.equal(fs.readFileSync(d.filePath, 'utf8'), CSV_BODY); // saved untouched
  assert.ok(wf.validateDownloadedReport(d).size > 0);
  assert.ok(!('Authorization' in (fetch.calls[0].opts.headers || {})), 'signed URL must not receive the Basic auth header');
});

test('invalid report link: non-HTTPS and malformed URLs are rejected before any request', async () => {
  const fetch = mockFetch({});
  const { ctx } = makeCtx(fetch);
  await assert.rejects(wf.downloadBuildReportCSV(ctx, 'http://insecure.example.com/r.csv', TH), (e) => e.code === ERROR_CODES.INVALID_REPORT_URL);
  await assert.rejects(wf.downloadBuildReportCSV(ctx, 'not a url', TH), (e) => e.code === ERROR_CODES.INVALID_REPORT_URL);
  assert.equal(fetch.calls.length, 0);
});

test('CSV download failure (HTTP 403) is reported', async () => {
  const { ctx } = makeCtx(mockFetch({ [CSV_ROUTE]: [res(403, undefined, { text: 'expired' })] }));
  await assert.rejects(wf.downloadBuildReportCSV(ctx, CSV_URL, TH), (e) => e.code === ERROR_CODES.DOWNLOAD_FAILED);
});

test('network failure during download is reported as NETWORK_ERROR', async () => {
  const { ctx } = makeCtx(mockFetch({ [CSV_ROUTE]: [new Error('socket hang up')] }));
  await assert.rejects(wf.downloadBuildReportCSV(ctx, CSV_URL, TH), (e) => e.code === ERROR_CODES.NETWORK_ERROR);
});

test('empty CSV is rejected by validation', async () => {
  const { ctx } = makeCtx(mockFetch({ [CSV_ROUTE]: [res(200, undefined, { text: '' })] }));
  const d = await wf.downloadBuildReportCSV(ctx, CSV_URL, TH);
  assert.throws(() => wf.validateDownloadedReport(d), (e) => e.code === ERROR_CODES.INVALID_CSV && /empty/i.test(e.message));
});

test('JSON/HTML error body saved as CSV is rejected by validation', async () => {
  const { ctx } = makeCtx(mockFetch({ [CSV_ROUTE]: [res(200, undefined, { text: '{"error":"x"}' })] }));
  const d = await wf.downloadBuildReportCSV(ctx, CSV_URL, TH);
  assert.throws(() => wf.validateDownloadedReport(d), (e) => e.code === ERROR_CODES.INVALID_CSV);
});

// ---------------------------------------------------------------- end-to-end orchestration (mocked)
function fullRoutes({ th = TH, task = TASK, csv = CSV_BODY, tasks } = {}) {
  return {
    [LIST]: [listOf([build({ thBuildId: th })])],
    [ISSUES_BUILD]: [res(200, { task_id: task })],
    [ISSUES_TASK]: tasks || [res(200, { report_link: CSV_URL })],
    [CSV_ROUTE]: [res(200, undefined, { text: csv })],
  };
}

const runWf = (fetch, extra = {}) =>
  wf.executeAccessibilityReportWorkflow({
    env: ENV,
    execution: { thBuildId: TH, buildName: 'n', projectName: 'p', source: 'env' },
    fetch,
    wait: async () => {},
    logger: silent,
    outputDir: tmp(),
    ...extra,
  });

test('workflow: success path produces a summary with build, task, attempts and file', async () => {
  const waits = [];
  const summary = await runWf(mockFetch(fullRoutes({ tasks: [res(200, {}), res(200, { report_link: CSV_URL })] })), { wait: async (ms) => waits.push(ms) });
  assert.equal(summary.status, 'SUCCESS');
  assert.equal(summary.thBuildId, TH);
  assert.equal(summary.taskId, TASK);
  assert.equal(summary.attempts, 2);
  assert.ok(fs.existsSync(summary.filePath));
  assert.equal(waits.length, 1);
  assert.ok(!JSON.stringify(summary).includes('secret-key'));
});

test('workflow: only one build-level generation request is made (no per-test-case requests)', async () => {
  const fetch = mockFetch(fullRoutes());
  await runWf(fetch);
  assert.equal(fetch.calls.filter((c) => new URL(c.url).searchParams.has('build_id')).length, 1);
});

test('workflow: TIMEOUT status after three unsuccessful checks', async () => {
  const summary = await runWf(mockFetch(fullRoutes({ tasks: [res(200, {})] })));
  assert.equal(summary.status, 'TIMEOUT');
  assert.equal(summary.error.code, ERROR_CODES.TIMEOUT);
});

test('workflow: expired task gives recovery guidance and does not reuse the task', async () => {
  const summary = await runWf(mockFetch(fullRoutes({ tasks: [res(404, {})] })));
  assert.equal(summary.status, 'FAILED');
  assert.equal(summary.error.code, ERROR_CODES.TASK_EXPIRED);
  assert.match(summary.error.recovery, /fresh task_id/);
});

test('workflow: concurrent executions keep independent build and task ids', async () => {
  const [a, b] = await Promise.all([
    runWf(mockFetch(fullRoutes({ th: 'buildA', task: 'taskA', csv: 'a,b\n1,2\n' })), { execution: { thBuildId: 'buildA', source: 'env' } }),
    runWf(mockFetch(fullRoutes({ th: 'buildB', task: 'taskB', csv: 'c,d\n3,4\n' })), { execution: { thBuildId: 'buildB', source: 'env' } }),
  ]);
  assert.deepEqual([a.thBuildId, a.taskId], ['buildA', 'taskA']);
  assert.deepEqual([b.thBuildId, b.taskId], ['buildB', 'taskB']);
});

test('workflow: auth failure and missing credentials are reported in the summary', async () => {
  const authFail = await runWf(mockFetch({ [LIST]: [res(401, {})] }));
  assert.equal(authFail.status, 'FAILED');
  assert.equal(authFail.error.code, ERROR_CODES.AUTH_FAILED);

  const noCreds = await runWf(mockFetch({}), { env: {} });
  assert.equal(noCreds.error.code, ERROR_CODES.MISSING_CREDENTIALS);
});

test('API host: default, region, and explicit override', () => {
  const { resolveApiHost } = require('./config');
  assert.equal(resolveApiHost({}), 'https://api-accessibility.browserstack.com');
  assert.equal(resolveApiHost({ BROWSERSTACK_ACCESSIBILITY_REGION: 'eu' }), 'https://api-accessibility-eu.browserstack.com');
  assert.equal(resolveApiHost({ BROWSERSTACK_ACCESSIBILITY_API_HOST: 'https://api-accessibility-in.browserstack.com/' }), 'https://api-accessibility-in.browserstack.com');
  assert.throws(() => resolveApiHost({ BROWSERSTACK_ACCESSIBILITY_REGION: 'xx' }));
});

// ---------------------------------------------------------------- Guideline(s) column (column H)
const HEADER_15 = 'Issue type,Issue name,Severity,Component,Behavior,Issue description,Affected page,Guideline(s),HTML snippet,CSS selector,Needs review,Needs Review Status,Best practice,How to fix this issue,Issue link';

function writeCsv(body) {
  const file = path.join(tmp(), 'report.csv');
  fs.writeFileSync(file, body);
  return file;
}

test('guidelines: reads column H per row, with distinct values and per-criterion counts', () => {
  const file = writeCsv(
    [
      HEADER_15,
      'color-contrast,Elements must meet minimum color contrast ratio,Serious,c,b,d,/p,SC 1.4.3,<a>,.x,No,,No,fix,link',
      'label,Label must be correctly associated,Critical,c,b,d,/p,"SC 2.4.6, SC 3.3.2",<input>,.y,No,,No,fix,link',
      'color-contrast,Elements must meet minimum color contrast ratio,Serious,c,b,d,/p,SC 1.4.3,<b>,.z,No,,No,fix,link',
    ].join('\n') + '\n'
  );
  const g = wf.readGuidelines(file);
  assert.equal(g.header, 'Guideline(s)');
  assert.deepEqual(g.values, ['SC 1.4.3', 'SC 2.4.6, SC 3.3.2', 'SC 1.4.3']);
  assert.deepEqual(g.distinct, [
    { value: 'SC 1.4.3', count: 2 },
    { value: 'SC 2.4.6, SC 3.3.2', count: 1 },
  ]);
  assert.deepEqual(g.criteria, [
    { criterion: 'SC 1.4.3', count: 2 },
    { criterion: 'SC 2.4.6', count: 1 },
    { criterion: 'SC 3.3.2', count: 1 },
  ]);
});

test('guidelines: quoted commas, escaped quotes and newlines inside fields do not shift column H', () => {
  const file = writeCsv(
    HEADER_15 + '\n' + 'a,"Name, with comma",S,c,b,"multi\nline ""quoted"" text",/p,SC 4.1.2,"<button class=""x"">",.s,No,,No,fix,link\n'
  );
  assert.deepEqual(wf.readGuidelines(file).values, ['SC 4.1.2']);
});

test('guidelines: BOM and CRLF line endings are handled', () => {
  const file = writeCsv('\ufeff' + HEADER_15 + '\r\n' + 'a,b,S,c,b,d,/p,SC 2.4.1,h,s,No,,No,fix,link\r\n');
  assert.deepEqual(wf.readGuidelines(file).values, ['SC 2.4.1']);
});

test('guidelines: column found by header name when the export is reordered', () => {
  const file = writeCsv('Guideline(s),Issue name\nSC 1.3.5,Autocomplete\n');
  assert.deepEqual(wf.readGuidelines(file).values, ['SC 1.3.5']);
});

test('guidelines: CSV with fewer than 8 columns and no Guideline(s) header is rejected', () => {
  const file = writeCsv('a,b,c\n1,2,3\n');
  assert.throws(() => wf.readGuidelines(file), (e) => e.code === ERROR_CODES.INVALID_CSV);
});

test('workflow: summary includes the Guideline(s) column read from the downloaded file', async () => {
  const csv = HEADER_15 + '\n' + 'a,b,S,c,b,d,/p,SC 1.4.3,h,s,No,,No,fix,link\n';
  const summary = await runWf(mockFetch(fullRoutes({ csv })));
  assert.equal(summary.status, 'SUCCESS');
  assert.deepEqual(summary.guidelines.values, ['SC 1.4.3']);
  assert.deepEqual(summary.guidelines.criteria, [{ criterion: 'SC 1.4.3', count: 1 }]);
});
