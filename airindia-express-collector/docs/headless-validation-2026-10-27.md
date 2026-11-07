# Native headless validation — 27 October 2026

The final default workflow completed 12 requested searches: 12 first-attempt
successes, 0 first-attempt failures, 0 retries, and 245 independently verified
fare rows. No query was omitted from the denominator. The separate dashboard end-to-end check also passed: 1/1 first-attempt search
with 19 verified fares. The terminal matrix below remains a distinct 12-query
sample; combined, the final source produced 13/13 successful searches and
264 verified fare rows.

## Matrix

Each cell is the number of verified exact-route fare rows. Every cell passed
on attempt 1 with zero verification errors.

| Route | 1 Nov 2026 | 11 Nov 2026 | 26 Nov 2026 | Total |
| --- | ---: | ---: | ---: | ---: |
| DEL → BOM | 19 | 19 | 18 | 56 |
| DEL → BLR | 23 | 23 | 22 | 68 |
| BOM → DEL | 19 | 18 | 16 | 53 |
| BLR → DEL | 23 | 23 | 22 | 68 |
| **Total** | **84** | **83** | **78** | **245** |

## Reproduction

From `airindia-express-collector/`, after installation, this command selects
the normal defaults without a browser-mode or transport override:

```sh
npm run collect -- \
  --search DEL:BOM:2026-11-01 --search DEL:BOM:2026-11-11 --search DEL:BOM:2026-11-26 \
  --search DEL:BLR:2026-11-01 --search DEL:BLR:2026-11-11 --search DEL:BLR:2026-11-26 \
  --search BOM:DEL:2026-11-01 --search BOM:DEL:2026-11-11 --search BOM:DEL:2026-11-26 \
  --search BLR:DEL:2026-11-01 --search BLR:DEL:2026-11-11 --search BLR:DEL:2026-11-26
```

Those dates reproduce the validation plan and become historical after travel.
For later collection, substitute valid future travel dates. The normal retry
policy remains enabled, but this run needed no retries. Searches run
sequentially, with at least 20 seconds between launches.

Environment: Linux, Chrome 153.0.8010.12, no configured proxy. Effective settings
were native headless Chrome, ordinary Chrome over loopback CDP,
`chrome-compatible` user-agent profile, and `browser-native` HTTP transport.
The UA was the installed browser's own reduced-version UA with only
`HeadlessChrome` replaced by `Chrome`; authentication used the same browser.
The dedicated persistent headless profile was used without copying a visible
browser session or rotating profiles after failures.

## Evidence and audit

Local run: `runs/2026-10-27T10-29-06-185Z-8cc901/`.
The run's `matrix-audit.json` records every requested query, attempt outcome,
verified fare and final denominator; `native-process-audit.json` records the
running-process check. A separate offline audit in
`independent-root-audit.json` also verified all 12 results, the 245 fare rows,
source fingerprint and process evidence. These files and the original per-query evidence remain
local because they can contain travel or session data.

All 12 queries used this unchanged source fingerprint, matching the source
when independently audited:

```text
7e186bc6d61991372ac563b45e3ad1d8d136e50fbf227b30383ad3a16abf8001
```

The manifest recorded `nativeHeadless: true`, `browserLauncher: cdp`, and
`browserTransport: external-chrome-cdp`. Independent inspection of PID 30069
confirmed the actual `--headless` and `--ozone-platform=headless` arguments,
loopback-only debugging, and absence of DISPLAY/WAYLAND display variables.
This used Chrome's native headless renderer, without a virtual display or
visible fallback. No webdriver override, TLS-validation exception or proxy
substitution was used.

Each query was independently rechecked from saved evidence: file SHA-256
hashes; an official fresh POST 200 JSON response from
`api.airindiaexpress.com/b2c-flightsearch/v4/fsa` after submission; reparsed
journey identities, route/date, fare totals and breakdown; one-to-one agreement
with the rendered exact-route page rows and saved row HTML; and required form,
result-page and screenshot evidence. Station/configuration JSON cannot qualify
as a fare response. The audit found 12 verified successes and no failures.

The local test suite also passed all 40 tests, including actual native
headless process/UA checks, signal cleanup, response/page verification, and
terminal handling for CAPTCHA, rate limits and verification-service failures.

## Separate dashboard end-to-end check

API job `2026-10-27T10-35-39-024Z-cdaeae` submitted DEL–BOM at offset T+5
without browser or mode fields. The worker inherited the normal native
headless Chrome defaults and completed on attempt 1 with 19 independently
verified fares. Its run is
`web-runs/2026-10-27T10-35-39-024Z-cdaeae/agent-1/2026-10-27T10-35-39-323Z-9770ad/`.
It used the same source fingerprint shown above, browser-native HTTP and
authentication, no proxy, and a process with the actual `--headless` flag.
Independent saved-evidence verification passed. This check is counted
separately from the 12-query terminal matrix.

## Limits

This is a small, sequential, nonrandom sample on one computer and network,
not a production-wide or future success guarantee. Prices and availability
are timestamped observations. Earlier failed native/HTTP2, Firefox, token
transport and verification-service diagnostics remain preserved; the final
matrix does not erase them. CAPTCHA, access denial, session expiry, rate
limits and verification-service unavailability still stop work rather than
triggering a visible fallback or challenge bypass.
