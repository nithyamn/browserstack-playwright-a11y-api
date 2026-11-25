# ecomm-tc-demo

Playwright tests for the FashionStack ecommerce site, run on BrowserStack Automate through the BrowserStack SDK,
plus a workflow that downloads the build-level **accessibility report (CSV)** for each SDK run.

## Project structure

```
accessibility-report/
  config.js           API host/region, endpoints, polling settings, output folder
  workflow.js         the workflow functions (build lookup, report request, polling, download, column H reader)
  run.js              command-line entry point (npm run a11y:report)
  workflow.test.js    mocked tests (no network, no real waiting)
tests/                Playwright specs and helpers
browserstack.yml      BrowserStack SDK config (accessibility: true)
output/accessibility-reports/   downloaded CSVs (git-ignored)
log/sdk-cli.log       written by the SDK; the report workflow reads the latest build from it
```

## Setup

1. `npm install`
2. Put your app logins in `.env` (`TEST_USER`, `TEST_PASS`). This file is git-ignored.
3. Make your BrowserStack credentials available as environment variables. Never write them into files:
   - `BROWSERSTACK_USERNAME`
   - `BROWSERSTACK_ACCESS_KEY`

Optional settings for the report workflow:

| Variable | Purpose |
|---|---|
| `BROWSERSTACK_ACCESSIBILITY_API_HOST` | Full API host override (default `https://api-accessibility.browserstack.com`) |
| `BROWSERSTACK_ACCESSIBILITY_REGION` | `eu` or `in`, for accounts with Geo Region Restriction (uses `api-accessibility-<region>.browserstack.com`) |
| `BROWSERSTACK_TESTHUB_UUID` | Build id to use instead of reading the latest one from `log/sdk-cli.log` |

## Running

| Command | What it does |
|---|---|
| `npm test` | Runs the Playwright tests locally |
| `npm run test:bstack` | Runs the Playwright tests on BrowserStack Automate (Windows 11 / Chrome, see `browserstack.yml`) with accessibility scanning on |
| `npm run a11y:report` | Fetches the accessibility CSV for the build you just ran |
| `npm run test:a11y-report` | Runs the mocked tests for the report workflow |

Typical flow, in the same terminal:

```
npm run test:bstack
npm run a11y:report
```

Run `a11y:report` right after `test:bstack`. It reads the latest build in `log/sdk-cli.log`, so start it before running the SDK again.

## How the accessibility report is fetched

1. **Find the build.** The workflow takes the build id the SDK reported (`BROWSERSTACK_TESTHUB_UUID`, or the latest
   "Visit .../builds/<id>" line in `log/sdk-cli.log`). It never just picks the newest build. If no id is available it
   matches by build name and start time, and stops if more than one build matches.
2. **Request the report** (one request per build, never per test case):
   `GET /api/automated-tests/v1/builds/issues?build_id=<thBuildId>` returns a `task_id`.
3. **Poll for the link** with the same `task_id`:
   `GET /api/automated-tests/v1/builds/issues?task_id=<task_id>`.
   It checks once immediately, then every **1 minute**, up to **3 checks** in total. If there is still no link the run
   ends as `TIMEOUT`. It never creates a second task while polling. Both numbers live in `accessibility-report/config.js`.
4. **Download** the signed HTTPS link (no auth header) to
   `output/accessibility-reports/accessibility-<buildId>-<timestamp>.csv` and check that it is not empty and not a
   JSON/HTML error page.
5. **Read column H** ("Guideline(s)", for example `SC 1.4.3`) and return it in the summary under `guidelines`:
   - `values`: one entry per issue row
   - `distinct`: each distinct cell value with its count
   - `criteria`: each success criterion with its count (cells like `SC 2.4.6, SC 3.3.2` are split)

The run prints a summary and exits `0` on `SUCCESS`, otherwise `1`. The status is `SUCCESS`, `TIMEOUT` or `FAILED`.
On failure the summary has an `error.code` such as `MISSING_CREDENTIALS`, `MISSING_SDK_METADATA`, `INVALID_BUILD_ID`,
`AMBIGUOUS_BUILD`, `AUTH_FAILED`, `TASK_EXPIRED`, `INVALID_REPORT_URL`, `DOWNLOAD_FAILED` or `INVALID_CSV`.
If a task has expired, run the command again to request a fresh one.

## API notes

- The live API wraps responses as `{ "success", "data", "error" }`, and returns the CSV link as `reportLink`.
  The docs show a bare payload and `report_link`. The code accepts both.
- The endpoint `/builds/<build_uuid>/issues?task_id=...` returned 404 "Test case not found" for build-level tasks
  in our testing, so the workflow polls `/builds/issues?task_id=...`.
- The build list response did not include `thBuildId` in our testing, so an id from the SDK is accepted and then
  checked by the report request itself.
- The CSV is saved as downloaded. Only column H is read from it.

## Tests

`npm run test:a11y-report` runs 44 mocked tests (Node's built-in test runner). They use a fake `fetch` and an injected
wait function, so nothing is sent to BrowserStack and no real waiting happens. They cover build identification,
pagination, the report request and `task_id`, polling and the 3-check limit, network failures, auth and API errors,
task expiry, the CSV download and validation, and the column H reader.
