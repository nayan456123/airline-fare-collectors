# Air India Fare Desk

A local, direct Air India flight fare collector. It opens the real Air India website in a rendered browser, searches the route and travel date you choose, and saves the displayed flight cards together with the matching airline response. The desk shows a fare only when those two sources agree. A failed or blocked search saves its cause and page evidence; it never becomes a made-up fare or a “sold out” claim.

The interface matches the IndiGo and Akasa desks: DGCA Category I route shortcuts plus custom airport pairs, T+1 / T+5 / T+9 / T+15 / T+30 / T+45 dates, live steps for each search, all verified flights and their price breakdowns, source links, saved runs, and a button to retry one failed route/date. The dashboard runs at **http://127.0.0.1:8789/** and binds only to your computer.

## Verified live result

On 9 October 2026, a visible-Chrome DEL–BOM search for 14 October with the
explicit free audio helper verified **27 exact-airport itineraries**. Lowest:
AI 9486, **₹6,788 = ₹4,990 base + ₹1,798 included taxes/fees**. The airline's
additional ₹475 was retained separately, not added to the displayed starting
fare. The independent evidence verifier passed. A preceding ordinary dashboard
search stopped at CAPTCHA; the helper result does not erase that failure.

A subsequent dashboard search with the explicitly selected helper verified
**20 DEL–BLR itineraries for 24 October**, lowest AI 2757 at **₹11,298 =
₹8,879 + ₹2,419**. The live option dispatch, collecting indicator, and saved
verified records were checked in the browser. These observations do not prove
headless operation or guarantee that every future challenge will clear.

On 29 September 2026, a headed Chrome search with the free local audio helper verified 20 DEL–BLR fares for 4 October. A second dashboard batch requested two workers on a 5.2 GiB RAM computer; the memory guard used one worker and completed both 8 October searches in sequence: **26 DEL–BOM fares and 20 DEL–BLR fares**. The full batch passed `node src/verify.mjs`. Its lowest displayed fares were AI 2951, DEL–BOM, **₹6,423** and AI 2653, DEL–BLR, **₹8,722**. These are dated observations, not current prices. See [STATUS.md](STATUS.md) for run IDs, failures, and limits.

Some searches encounter access checks, an image puzzle, a blank booking shell, or a network failure. Dashboard jobs stop on CAPTCHA, access denial, rate limiting, or session expiry and save the exact outcome. The **optional free audio verification helper** can be selected explicitly in the Air India console or the combined dashboard, with visible Chrome on the direct connection. It is off by default. It uses Google's free speech recognition when Google offers an audio challenge; it may fail or be rate limited. Fare data still comes only from Air India's own page and fare response. Unresolved challenges and access denial stop the batch.

## Requirements and automatic setup

Normal collection needs Git, Node.js 20 or newer, Google Chrome, and internet access. No Air India API key, paid scraping API, or airline account is required. `npm ci` followed by `npm run web` is sufficient when Node and Chrome are installed. The setup scripts also install Python and FFmpeg; the optional helper environment needs the separate setup below. Keep enough disk space for saved pages, screenshots, and airline responses.

### Optional audio helper setup

The observed helper used Python 3.12 and FFmpeg. From this project directory on
Ubuntu/macOS, with Python 3.12 available:

```sh
python3.12 -m venv .session/audio-venv
.session/audio-venv/bin/python -m pip install playwright==1.63.0 pydub==0.25.1 SpeechRecognition==3.10.4
```

On Windows PowerShell:

```powershell
py -3.12 -m venv .session/audio-venv
.\.session\audio-venv\Scripts\python.exe -m pip install playwright==1.63.0 pydub==0.25.1 SpeechRecognition==3.10.4
```

If Ubuntu setup installed Python using uv, use
`~/.local/bin/uv run --python 3.12 python -m venv .session/audio-venv` for the
first command. No extra browser download is needed: the helper attaches to
the collector's existing Chrome. The console finds this environment, or uses
`AIRINDIA_SOLVER_PYTHON` if supplied. Windows/macOS live helper operation has
not been tested. The helper is unavailable in headless/proxy dashboard mode.

The repository is public, so downloading the code does not require a GitHub login. GitHub credentials are not used by the collector or sent to Air India. Clone it with Git, then run the setup command for your operating system.

### Ubuntu x86-64

```bash
git clone https://github.com/nayan456123/airline-fare-collectors.git
cd airline-fare-collectors/airindia-collector
bash ./setup-ubuntu.sh
```

This uses `apt` for FFmpeg and prerequisites, NodeSource for Node.js if the installed version is too old, Google’s Chrome package if Chrome is missing, and Python 3.12 or the free `uv` Python installer if your Ubuntu release lacks it. It then starts the page. On future launches:

```bash
cd airline-fare-collectors/airindia-collector
./start.sh
```

### macOS (Apple Silicon or supported Intel macOS)

```bash
git clone https://github.com/nayan456123/airline-fare-collectors.git
cd airline-fare-collectors/airindia-collector
bash ./setup-macos.sh
```

This uses Homebrew to install Node.js, Python 3.12, FFmpeg, and Google Chrome when missing. If Homebrew is absent, its official installer runs first. On future launches:

```bash
cd airline-fare-collectors/airindia-collector
./start.sh
```

### Windows 10/11, PowerShell

```powershell
winget install --id Git.Git -e
```

Open a new PowerShell window, then clone and install:

```powershell
git clone https://github.com/nayan456123/airline-fare-collectors.git
Set-Location airline-fare-collectors\airindia-collector
Set-ExecutionPolicy -Scope Process Bypass
.\setup-windows.ps1
```

This uses Windows Package Manager (`winget`) for Node.js LTS, Python 3.12, FFmpeg, and Google Chrome when missing. On future launches:

```powershell
Set-Location airline-fare-collectors\airindia-collector
Set-ExecutionPolicy -Scope Process Bypass
.\start-windows.ps1
```

If a system installer has just changed `PATH` and the script says a command is missing, open a new terminal and run the start command. The Linux startup path has been tested on the development machine. The macOS and Windows launchers are provided for those operating systems, but have not yet been run on actual macOS and Windows hosts; report a platform-specific failure with its exact terminal output rather than treating that path as verified.

### Manual startup and checks

From the project directory, `npm ci` installs the pinned JavaScript dependencies. `./start.sh` on Ubuntu/macOS or `start-windows.ps1` on Windows starts the local server. Both normal launchers require Node and Chrome and use the current network.

```bash
npm test
node src/verify.mjs web-runs/RUN_ID
```

`npm test` checks routes, dates, worker scheduling, evidence matching, and retry behavior. The verifier checks saved file integrity and fare evidence without sending a new airline search. Replace `RUN_ID` with a saved directory name. A failed search or unverified evidence produces a nonzero exit code.

The verifier requires recorded airline-response provenance by default. To inspect older saved runs that predate that evidence, use `node src/verify.mjs --allow-legacy web-runs/RUN_ID`. The report marks those searches with `provenanceVerified: false`; legacy verification cannot establish the missing response provenance.

## Using the desk

The generic entry is `https://www.airindia.com/`. To use the exact entry verified
on 26 October, start the dashboard with this explicit campaign setting:

```bash
AIRINDIA_ENTRY_URL='https://www.airindia.com/?ai_pc=MYFLIGHTAIR' npm run web
```

The CLI reads the same setting; `--entry-url` overrides it for one invocation.
Dashboard jobs save their entry URL and retain it when retried. The campaign
setting is explicit because its effect on available fares has not been isolated.
On this Linux machine, the default headless Chrome mode uses a dedicated Chrome
process with native `--headless` and a compatible user agent for the installed
Chrome version. Direct headless dashboard searches disable HTTP/2 and use a
separate collector-owned profile for each search; old persistent profiles are
not deleted or copied. Generated dashboard profiles remain under
`.session/dashboard-headless/` and can use significant disk space; they can be
removed when no dashboard searches are running. The dashboard also offers visible Chrome. The 28 October
headless sample is described in [the validation report](docs/headless-validation-2026-10-28.md).

1. Enter one route per line, such as `DEL-BOM`, or use the route shortcuts. The city-pair shortcuts are research presets; the collector still checks the selected airline’s exact airport availability.
2. Select one or more of the six offered future travel dates and choose headless or visible Chrome. Headless is the default.
3. Start the run. Each route/date has its own progress bar, stage log, status, and saved evidence. The desk supports up to 54 searches per batch, spaces starts by at least 20 seconds, and stops queued requests after access denial.
4. For a completed search, inspect every captured flight, displayed total, base, taxes and fees, separate unitemized amount, airline response total, page screenshot, saved page, and saved airline response. A failed search has no fare; its card shows the cause and any available failure page.
5. Use **Retry this search** on an eligible failed card, or **Retry unfinished searches** to retry eligible failed, skipped, or interrupted searches together. The original future travel dates are retained; each retry creates a new saved run, and the prior results and evidence stay saved. Wait until Air India access is available before retrying. Runs with a recorded access denial or challenge cannot be retried.

For a direct command on Ubuntu:

```bash
npm run collect -- \
  --search "DEL:BOM:$(date -d '+5 days' +%F)" \
  --entry-url 'https://www.airindia.com/?ai_pc=MYFLIGHTAIR' \
  --headless
```

This Linux date expression is only an example; the dashboard handles travel dates on every supported OS. CLI runs are stored under `runs/`; dashboard runs are under `web-runs/`. Both directories are excluded from Git.

## Browser worker settings

Console jobs share browser admission with the sibling collectors. Below 8 GiB RAM, simultaneous job submissions are accepted but browser searches wait for one shared slot. Higher-memory computers allow at most three browser workers across sources. Each source retains its launch spacing and denial stop rules.

## Configuration and troubleshooting

| Need | Setting or action |
| --- | --- |
| Chrome installed elsewhere | Set `AIRINDIA_CHROME_PATH` to its executable. The collector also checks standard Windows, macOS, and Linux locations, then the installed Playwright Chromium binary. |
| CLI Chrome HTTP/2 failure | Add `--disable-http2` for a Chrome CLI search. The direct headless dashboard selects this option automatically. |
| Optional helper installed elsewhere | Set `AIRINDIA_SOLVER_PYTHON` to that environment's Python executable before starting the server. |
| HTTP, HTTPS, or SOCKS5 proxy | Set `AIRINDIA_PROXY_SERVER` before starting the desk. CLI also accepts `--proxy`, `--proxy-user`, and `--proxy-password`. Proxy searches use Playwright’s browser path. |
| Port 8789 is occupied | Set `AIRINDIA_PORT` to another local port before starting. |
| No fares shown | Open the search card’s cause and evidence. `CAPTCHA`, `ACCESS_DENIED`, `FARE_RESPONSE_UNVERIFIED`, `EMPTY_RESULTS`, and browser/resource failures are different outcomes. |
| Low memory | The desk no longer queues or rejects by free RAM. Select fewer workers or close other browser-heavy applications if Chrome fails to start. |
| Stale Python helper | Run the setup command again. The launcher uses a version-specific virtual environment rather than the old broken interpreter link. |

Each search records its route, travel date, collection timestamp, flight, price breakdown, response and page evidence when available, and a structured cause on failure. `.session/`, `runs/`, `web-runs/`, and diagnostics stay local and are ignored by Git. Do not publish those files or include proxy credentials in shared logs.

## Source and installation references

- [Playwright browser installation and system dependencies](https://playwright.dev/docs/browsers)
- [Node.js downloads](https://nodejs.org/en/download)
- [Homebrew installation](https://docs.brew.sh/Installation)
- [Windows Package Manager install command](https://learn.microsoft.com/windows/package-manager/winget/install)
- [uv Python 3.12 installation](https://docs.astral.sh/uv/guides/install-python/)

## Shared browser admission

Console/API jobs share browser slots with the other airline collectors installed on this computer. Below 8 GiB RAM, all three can accept jobs at the same time, but browser searches run one at a time and queued jobs display a waiting notice. At 8 GiB or more, at most three workers run across the collectors. Completed workers release admission; surviving workers retain their slot after a server crash. This prevents simultaneous browser pressure, not airline network errors or access challenges. Direct command-line collection is outside this console scheduler.

Fresh visible-Chrome DEL–BOM collection on 1 October 2026 for 6 October captured 24 verified fares. DEL–BLR for 15 November stopped at CAPTCHA: the audio helper returned audio_unrecognized. Headless live collection has not been verified in this test session; the configured access-check helper runs only with visible Chrome. Do not claim both modes are proven or that challenges are always solvable.
