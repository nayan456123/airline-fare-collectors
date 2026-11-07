# SpiceJet Fare Desk

A local browser-driven collector for SpiceJet's public booking website. It
supports one adult, one-way searches in INR, records each flight's lowest
available starting fare and itemized charges, and verifies the response against
the displayed flight card. Failed searches remain failures; no-flight results
require both an empty airline response and the website's visible no-flight notice.

## Setup and start

Install Node.js 20+, Google Chrome and Xvfb on Linux (`sudo apt install xvfb`), then run:

```sh
cd spicejet-collector
npm ci
npm run web
```

Open http://127.0.0.1:8790/. Choose routes, day offsets and Background Chrome, then
select **Collect fares**. **Use all nine routes** fills the same route set used
by the sibling collectors. Exact saved dates can also be entered individually.
The dashboard shows progress, verified fares, fare breakdowns, screenshots,
airline responses, saved-run history and a Stop control. It runs one search at
a time with a 20-second rest between searches. A temporary server or network
failure may receive one delayed retry; every attempt stays recorded. Browser admission is shared with
the sibling collectors to avoid excessive simultaneous browser use.

Background Chrome uses a separate virtual display, so no windows open on your
desktop. It is the default dashboard mode on Linux. Native headless Chrome is
also available but returned HTTP 403 during initial tests. HTTP
401, 403, 429 or a detected block stops queued searches; access is never retried
automatically. A zero-failure test batch measures that batch only and cannot
guarantee future website access or inventory.

If Chrome is installed elsewhere, set `SPICEJET_CHROME_PATH` to its executable
before starting. The launcher checks standard Chrome installation locations on
Linux, Windows and macOS. The background dashboard requires Linux and Xvfb;
set `SPICEJET_XVFB_PATH` for a custom Xvfb installation. The launcher can also
reuse the virtual-display runtime already installed by the sibling collector.
Windows and macOS are not live-tested here. `start.sh`
is a Bash shortcut; on Windows use `npm run web` from PowerShell.

## Terminal use and verification

Use a current or future travel date:

```sh
npm run collect -- --search DEL:BOM:YYYY-MM-DD --background
npm run verify -- runs/RUN_ID
npm run verify:batch -- web-runs/RUN_ID
npm test
```

A successful search stores `result.json`, the availability response, rendered
page, flight card HTML, screenshot, evidence hashes, progress events, browser
mode/version and source fingerprint in `runs/`. Dashboard batches are saved in
`web-runs/`. These private local artifacts and browser dependencies are excluded
from Git.

The verifier binds the requested route/date to the response, checks every
flight card and fare, and verifies evidence hashes. A rescheduled flight records
both the revised displayed times and the response's original times; a mismatch
is accepted only when the original times are explicitly crossed out in that
same card. Connecting flights preserve all flight numbers and their actual
origin/destination, including when a stopover airport appears later in the text.

See `LIVE-TEST-2026-11-04.md` for recorded test outcomes. The original failed runs
are preserved even when a later fixed run succeeds.
