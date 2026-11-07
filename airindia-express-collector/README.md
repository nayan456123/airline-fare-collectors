# Air India Express Fare Collector

A local collector for the official Air India Express booking site at
https://www.airindiaexpress.com/en/book-flights/. It submits route and date
searches in native headless Chrome by default and saves page and network evidence
locally. Its parser recognizes the observed official
`/b2c-flightsearch/v4/fsa` response and accepts fare rows only when the response
and exact-route rendered page rows agree. It requires one adult, INR, and
included taxes and fees; it reconciles the base and included charges against
the airline's fare totals. Nearby-airport page rows are excluded.

## Native headless validation — 27 October 2026

The default native headless workflow completed **12/12 searches on the first
attempt**, with **zero retries and 245 independently verified fare rows**:
DEL–BOM, DEL–BLR, BOM–DEL and BLR–DEL for 1, 11 and 26 November 2026.
The running Chrome process had the actual `--headless` and
`--ozone-platform=headless` arguments, with no DISPLAY or WAYLAND display.
Authentication and fares used Chrome's native network transport. All queries
used one unchanged source fingerprint and the dedicated headless profile.

This is a measured result on one Linux computer/network with Chrome
153.0.8010.12, not a guaranteed future success rate. See the
[validation report](docs/headless-validation-2026-10-27.md) for the matrix,
reproduction command and evidence checks. A separate dashboard end-to-end check also passed using omitted browser/mode
defaults: 1/1 search on its first attempt, with 19 verified fares and actual
native headless process evidence. The terminal matrix and dashboard check are
distinct: together they produced 13/13 successful final-source searches and
264 verified fare rows.

## Observed live checks — 9 October 2026

On the development computer's network, visible Chrome independently verified
20 exact-route DEL–BOM itineraries for 14 October. The lowest starting fare was
₹6,678 (₹4,880 base + ₹1,798 included charges). A second visible-Chrome search,
started through the dashboard, selected 23 November in the calendar and verified
22 DEL–BLR itineraries. Its lowest fare was ₹13,110 (₹10,501 + ₹2,609), on
IX1196 + IX1383. Those are timestamped observations, not current-price promises.

Headless selected and submitted the November route/date but failed before any
fare request: the anonymous-session `/aai-authentication/v2/auth/token` POST
received no response. The website canceled it after 10 seconds; the forwarder
then reached its 15-second timeout. One retry had the same result. That historical check did not establish working headless collection. Visible Chrome remains available explicitly.

On 27 October 2026, two bounded headless Chrome checks for DEL–BOM on
1 November again selected and submitted the requested form but failed at the
anonymous-session token POST before receiving fares. Native transport reported
`net::ERR_HTTP2_PROTOCOL_ERROR`; a separate native check with `--disable-http2`
reported `net::ERR_ABORTED`. Neither received an authentication HTTP status or
produced verified fares. Disabling HTTP/2 did not resolve headless collection in
those checks; neither setting established a working headless method.
A headless Firefox comparison reached the booking handoff but its booking-page
GET failed with `NS_ERROR_NET_RESET`, also without verified fares.
A temporary diagnostic using ordinary Chrome's standard headless mode over
local CDP also failed the token POST with `net::ERR_HTTP2_PROTOCOL_ERROR`.
That diagnostic did not justify changing the production browser launcher.
Across these four single-attempt headless checks, zero produced verified
fares. They tested one route/date on this computer's current connection and
do not establish a cause or a general headless failure rate.

A later controlled check on 27 October used ordinary Chrome with its actual
`--headless` flag, loopback CDP, and the same installed browser's standard Chrome
user agent. Run `2026-10-27T10-24-29-386Z-5bd0c9` returned the official FSA HTTP
200 response and independently verified 19 DEL–BOM fares for 1 November.
The manifest and Linux process evidence recorded the actual `--headless`
argument. Authentication and fares used Chrome's native network transport.
That initial successful search preceded the completed 12-query matrix above.
Earlier failures remain preserved in their original run evidence.

## Install and run

Requirements: Node.js 20 or newer, Git, and Google Chrome. These public source
downloads do not need a GitHub login. Keep the terminal open while the local
collector is running. Installation is separate from a successful airline
search; access challenges and network failures are recorded as failures.
If system Chrome is unavailable, an already installed Playwright Chromium is
also supported. `AIX_CHROME_PATH` takes precedence over both.

### Ubuntu 22.04/24.04 (x86-64)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl wget git
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource-setup.sh
sudo -E bash /tmp/nodesource-setup.sh
sudo apt-get install -y nodejs
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/google-chrome.deb
sudo apt-get install -y /tmp/google-chrome.deb
git clone https://github.com/nayan456123/airline-fare-collectors.git
cd airline-fare-collectors/airindia-express-collector
npm ci
npm run web
```

### Windows 10/11 (PowerShell)

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Google.Chrome -e
```

Open a new PowerShell window after installation, then run:

```powershell
git clone https://github.com/nayan456123/airline-fare-collectors.git
Set-Location airline-fare-collectors\airindia-express-collector
npm ci
npm run web
```

Open **http://127.0.0.1:8791/** and keep PowerShell open. Press **Ctrl+C** to
stop the server. If Chrome is installed in a nonstandard location, set
`$env:AIX_CHROME_PATH` to the full path to `chrome.exe` before `npm run web`.

### macOS (Terminal)

Install [Homebrew](https://brew.sh/) if needed, then install Node.js, Git, and
Chrome:

```bash
brew install node git
brew install --cask google-chrome
git clone https://github.com/nayan456123/airline-fare-collectors.git
cd airline-fare-collectors/airindia-express-collector
npm ci
npm run web
```

Open **http://127.0.0.1:8791/**, keep Terminal open, and press **Ctrl+C** to
stop. If Chrome is in a nonstandard location, set `AIX_CHROME_PATH` to its
executable before starting.

Firefox is optional. Install its Playwright browser once with
`npx playwright install firefox`, then choose Firefox in the page or pass
`--browser firefox` to the collector. The `--disable-http2` option is available
for Chrome only; it can be selected per search/job and is not enabled by
default.

The browser's native network transport is the default for both terminal and
dashboard searches. On 27 October 2026, four native-transport searches across
three routes/dates succeeded and passed independent evidence verification. A
subsequent dashboard search for DEL–BOM on 1 November also succeeded on its
first attempt, with 19 fares and the dashboard reporting verified evidence.
Three earlier HTTP/1.1 attempts timed out during authentication, while one
earlier HTTP/1.1 search reached the fare response. This small, nonrandom sample
does not guarantee future success. To opt into forwarding accepted HTTPS
requests through Playwright's HTTP/1.1 client, pass `--http-transport http1`
to terminal collection; for example:

```sh
npm run collect -- --search DEL:BOM:YYYY-MM-DD --http-transport http1
```

For Chrome without a configured proxy, the default mode (also selected explicitly
with `--headless`) uses the method
used in that successful check: ordinary Chrome launched with `--headless`,
a nonzero debugging port bound to `127.0.0.1`, and a compatible user agent.
The collector reads the selected installed browser's own native headless user
agent and changes only its `HeadlessChrome` token to `Chrome`, retaining its
platform and native version reduction. Native client hints remain unchanged.
No virtual display, site-code edits, webdriver overrides, TLS exceptions,
proxy substitution, or copied visible-browser session is used.

```sh
npm run collect -- --search DEL:BOM:YYYY-MM-DD --headless
```

Use `--headed` or select Visible in the dashboard for an explicit visible run.
There is no automatic visible fallback. For controlled comparisons, `--browser-launcher playwright` and
`--user-agent-profile native` remain available explicitly. CDP and the compatible
profile require headless Chrome without a proxy. Headed Chrome keeps its
existing ordinary-Chrome launcher; Firefox and proxied sessions retain
Playwright and their native user agents. Dashboard headless Chrome searches
inherit the same effective defaults. Compatible and native UA configurations
have separate default persistent profiles; an explicit `--profile` is honored.
Profiles are never rotated automatically after a failure. Authentication uses the browser's network transport by default.

After submission, the collector allows up to 120 seconds for the official
FSA response and rendered flight rows. Station/configuration JSON cannot count
as a fare response: only the official API's POST 200 JSON at
`/b2c-flightsearch/v4/fsa` qualifies. An incomplete booking navigation, missing
FSA response, or unfinished flight-row rendering becomes a bounded loading
timeout eligible for the ordinary transient retry, provided no challenge,
access denial, rate limit or session expiry is recorded.

The collector retries selected transient failures once by default. Pass
`--retries 0` to disable that retry for a run.

Use `--renew-session` to clear Air India Express cookies before a run while
keeping the persistent browser profile. For a first-page transport failure,
the collector may clear those cookies once before its retry only when recorded
network evidence contains no HTTP 401, 403, or 429. It does not automatically
renew after an access denial, rate limit, expired session, or CAPTCHA. Do not
use `--renew-session` after a 401, 403, 429, or CAPTCHA challenge.

An existing proxy is optional. Set `AIX_PROXY_SERVER=http://host:port` or
`AIX_PROXY_SERVER=socks5://host:port` before starting the server, or pass
`--proxy` to terminal collection. Optional proxy authentication uses
`AIX_PROXY_USERNAME` and `AIX_PROXY_PASSWORD`; credentials are not written to
run manifests. Searches use the current connection when no proxy is set.

## Collection and evidence

The page accepts route pairs and the offered future-date offsets. It runs one
browser worker at a time, with at least 20 seconds between task launches.
Native headless Chrome is the default; visible mode and Firefox can be selected.
Terminal collection is also available, for example:

```sh
npm run collect -- --search DEL:BOM:YYYY-MM-DD
```

Each browser uses a persistent profile under `.session/`. Run evidence is
stored locally under `runs/` for terminal searches and `web-runs/` for page
jobs. Evidence can include the submitted form, result/failure page, screenshots,
observed network metadata, and captured first-party JSON response bodies.
Every run records its build fingerprint, effective browser launcher/transport,
user-agent profile, resolved compatible UA and installed version, browser mode,
`nativeHeadless`, and connected Wi-Fi name when available. `nativeHeadless`
records the selected launch configuration. For ordinary Chrome on Linux,
`browserProcess` separately records the PID and headless argument read from
that process's actual `/proc` command line; the observed argument and evidence
source are null when that observation is unavailable. These settings and process evidence do not themselves prove a
successful fare collection. Transient loading failures receive one retry after a
recorded backoff; challenges and access denial receive no automatic retry.
These files can contain session or travel-search data; keep them local and do
not share them casually.

CAPTCHA, access denial, rate limiting, or session expiry blocks the batch and
stops queued searches. A missing or unrecognized response is a failure with
evidence, never an empty-flight result. A parser result alone does not establish
that a production search succeeded; saved response, exact-route page evidence,
and independent verification must all agree.

Run the local test suite with `npm test`.

Visible Chrome and the default non-proxied headless Chrome use dedicated ordinary Chrome processes with loopback CDP. Explicit Playwright comparisons, Firefox, and configured proxy sessions use Playwright persistent contexts. Navigation, response capture, screenshots, and cleanup have bounded waits. A dashboard worker has a ten-minute outer deadline for both attempts and artifact cleanup and records its last stage if the browser stalls. These protections do not establish live fare success.
