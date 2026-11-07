# Full-run access status — 28 October 2026 (IST)

The 54-search dashboard run `web-runs/2026-10-28T12-35-18-441Z-256587`
recorded 22 successful searches, then seven `SITE_ERROR` failures before it
was cancelled; one search was interrupted and 24 were skipped. A subsequent
single headless test of the reported BLR–CCU date captured HTTP 403 responses
from Air India's fare and calendar endpoints and stopped as `ACCESS_DENIED`.
The original generic errors did not expose a status, so this later observation
does not prove that all seven earlier failures had the same cause. The collector
now captures sanitized correlated response statuses when available and stops
after repeated site errors. Restart recovery preserves a recorded denial and
prevents stale fare or verification data from appearing on the denied task.
A local 54-search scheduling fixture and the full
browser-enabled suite passed; a successful live 54-search run remains unverified
while the airline denies the tested requests.
The dashboard can create a new batch for eligible unfinished searches while
retaining the original dates and successful evidence; for the saved 54-search
run it identifies 32 unfinished searches. Do not start the retry while access
remains denied. The latest local suite passed 118 tests without failures or skips.

# Earlier dashboard headless recovery — 28 October 2026 (IST)

After the reported HTTP/2 homepage errors and a subsequent failed results
batch, the revised dashboard completed **12/12 searches on their first
attempt**, with **265 verified fares** and no failure or retry events. A
separate two-search retest of the two previously failed dates also passed on
the first attempt. The local browser-enabled suite passed 94/94 without skips.
The results, earlier failures, configuration and limitations are recorded in
the [headless recovery report](docs/headless-recovery-2026-10-28.md).

# Earlier live headless status — 28 October 2026 (IST)

The native-headless Air India CLI completed **12/12 searches on their first
attempt**, saving **265 verified fares** across DEL–BOM and DEL–BLR and six
future dates. A separate default dashboard search completed on its first attempt
with 24 verified fares. All used the explicitly configured campaign entry,
one worker and a direct connection. Chrome's actual `--headless` argument and
the absence of a display were observed. This is a measured sample, not a
guarantee of future availability or access. The report records configuration,
evidence, earlier failures and limits: [28 October headless validation](docs/headless-validation-2026-10-28.md).

# Historical live status — 27 October 2026 (IST)

The final normal-dashboard matrix verified **12/12 queries in 12 first attempts, 275 fares**, with **zero UI Retry clicks**. The independently audited observed success rate is **100% for this twelve-query sample**. Configured local tests passed **75/75 without skips**, and targeted Chromium checks passed **25/25**.

Run: `web-runs/2026-10-26T19-27-41-768Z-c96e78`. Source: `b5dc0297523365fa7391d3484299351d5397ab417bf817af8d2250518bf9c04b`. All evidence hashes, strict page/response comparisons, cabin metadata, route/date checks, and price arithmetic passed independent audit. The ordinary site-error Retry path was not triggered live; its recovery behavior is covered by local fixtures.

This proves the observed sample on Linux, visible Chrome 153/CDP, the dedicated profile, direct connection, one worker, and the explicitly configured user entry. It is not a universal guarantee; headless, other operating systems, proxies, and campaign-parameter effects remain unverified.

Earlier cancelled, blocked, and partial cohorts remain saved with their original outcomes. See the [27 October audit](docs/reliability-2026-10-27.md) for all twelve results, startup instructions, fixes, evidence reports, and preserved history.

# Historical live status — 26 October 2026

The exact user-supplied root URL `https://www.airindia.com/?ai_pc=MYFLIGHTAIR` returned HTTPS 200 in collector checks and exposed a different Angular booking widget. The user reports normal searches work in all browsers on this connection; this was not independently observed in their browser. The collector's root-entry runs have so far failed before Search on a hidden-radio selector and an airport-selection confirmation guard. These are form-handling failures, not access-denied outcomes.

As of the 16:03 UTC adapter run: **four collector run attempts, zero completed fare runs, and one actual flight Search submission**. The first two legacy-entry runs were blocked (one at the booking POST, one at the redirected homepage). A separate UI probe submitted no Search. The new adapter uses ordinary visible controls and strict route/date/one-way checks; the latest bounded airport-commit correction passed independent regressions and is awaiting combined-form live validation. The production default entry remains unchanged pending evidence.

The latest configured local suite passed 55/55, including the strict airport-commit and final form-guard regressions. Live collection and the broader reliability goal remain unfinished. See the [dated reliability review](docs/reliability-2026-10-26.md) for evidence references and current limits.

# Historical live status — 9 October 2026

## Current focused checks

- Ordinary visible-Chrome dashboard collection submitted the requested form and stopped at CAPTCHA. The checkbox-only diagnostic opened an image puzzle and also stopped.
- A separately selected free audio helper cleared the offered audio challenge and verified 27 exact DEL–BOM itineraries for 14 October. Lowest: AI 9486, ₹6,788 displayed starting fare (₹4,990 base + ₹1,798 included charges); ₹475 additional amount stayed separate. Run: `diagnostics/free-audio-2026-10-09/2026-10-09T09-17-58-277Z-044f9f`.
- The helper option was then selected in the combined dashboard and dispatched only to Air India. Visible Chrome verified 20 DEL–BLR itineraries for 24 October, lowest AI 2757, ₹11,298 (₹8,879 + ₹2,419). Saved console run: `web-runs/2026-10-09T09-29-09-537Z-ac043e`. Its independent verifier passed.
- The helper remains optional, off by default, and unavailable for headless/proxy dashboard jobs. It may fail when no usable audio challenge is offered or speech recognition is limited. Those outcomes emit no fare and stop the batch.
- Headless Air India collection is still unverified. These focused checks do not establish a universal success rate or Windows/macOS live operation.
- Previous raw runs were deleted at the user's request. Historical entries below describe previous observations; their old evidence paths may no longer exist.

## Historical status — 30 September 2026

## Three-collector memory check

On 29 September, the three desks each accepted a headed DEL–BOM search for 8 October at the same time. All used the shared browser-capacity pool on the 5.2 GiB machine. The initial 2.5 GiB free-memory threshold caused all three to wait when the three servers together left about 2.4 GiB available; after lowering that start threshold to 2 GiB, only one browser held the shared slot at a time. The jobs then ran in sequence without a recorded out-of-memory event. The saved outcomes were:

- IndiGo `web-runs/2026-09-29T06-35-51-727Z-81fc34`: complete, 68 verified fares.
- Akasa `web-runs/2026-09-29T06-35-51-744Z-ebb030`: complete, 6 verified fares.
- Air India `web-runs/2026-09-29T06-35-51-743Z-87e277`: blocked, zero fares. It submitted the booking search, reached a reCAPTCHA audio challenge, and stopped when the audio could not be recognized. This was an access challenge, not a memory crash. Earlier Air India fare runs below remain verified; this failed attempt remains failed.

The collector now preserves the audio helper's specific outcome in the saved search cause and shows it on the failed card. Solver-result files are replaced atomically, and a retry removes the previous result before starting, so a partial or stale helper result cannot masquerade as the latest attempt. This failure-reporting change passed focused tests; no new live challenge was forced solely to test it.

This verifies serial browser admission and observed system stability for one simultaneous three-desk run. It does not prove that no future run can crash or that every Air India challenge can be cleared.

## New live verification under the memory limit

- `runs/2026-09-29T05-59-36-427Z-bd071c` — a headed DEL–BLR search for 4 October reached HTTP 200 at the booking handoff and then a CAPTCHA, but the local audio helper could not start because its old Python virtual environment linked to a removed interpreter. It saved zero fares and remained blocked. The launcher now selects an available Python 3.11/3.12 and a version-specific virtual environment instead of reusing that broken link.
- `runs/2026-09-29T06-01-31-734Z-99be8b` — the same live search with the repaired free local helper completed. It saved 20 DEL–BLR fares; the lowest displayed fare was INR 9,746 (base 7,852 + taxes and fees 1,894, with a separate unitemized INR 399 in the response). The saved airline response and rendered cards passed independent verification.
- `web-runs/2026-09-29T06-03-44-975Z-c3aaef` — the desk was asked for two workers on this 5.2 GiB RAM machine and automatically used one, preserving both queued searches. DEL–BOM and DEL–BLR for 8 October ran sequentially and both passed evidence verification: 26 and 20 exact-airport fares respectively. The lowest displayed fares were INR 6,423 for BOM and INR 8,722 for BLR. The verifier passed for the entire batch; no out-of-memory event was logged during it. The two-agent request was a memory-scheduling test, not a claim that two simultaneous Chrome instances are safe on this machine.

This establishes a successful live two-route batch with memory-aware scheduling. It does not prove continuous success against changing access checks, or a fresh installation on another machine.

After that batch, the three collectors gained a shared browser-capacity lease. A desk can now accept a queued batch with 1–2 GiB available; it will wait for safe browser capacity rather than launching Chrome immediately. Under 1 GiB available it rejects the batch. The cross-collector lease passed a simulated three-project contention check and the live check above.

**Five fresh Air India searches completed with 119 exact-airport fares and matching airline-response/page evidence.** This proves live collection for those runs, not continuous reliability or automatic success on every CAPTCHA.

## Verified live searches

- `runs/2026-09-28T16-44-30-750Z-a2e377` — `current Wi-Fi connection`, headed external Chrome, DEL–BLR for 4 October 2026. The booking check cleared, 20 flight cards matched the offer response, and `node src/verify.mjs` returned `ok: true`. Collected at `2026-09-28T16:45:30.067Z`. Lowest displayed fare: AI 2757 at INR 9,746 (base 7,852 + taxes and fees 1,894); the response total was INR 10,145, including an unitemized INR 399 beyond the displayed fare.
- `web-runs/2026-09-28T16-50-37-215Z-0e304f` — `current Wi-Fi connection`, local desk, DEL–BOM for 3 October 2026. The desk reused the tested headed profile, saved 26 exact BOM flights, and both desk and collector verifiers returned `ok: true`. Collected at `2026-09-28T16:51:35.369Z`. Lowest displayed fare: AI 1745 at INR 6,310 (base 4,836 + taxes and fees 1,474); the response total was INR 6,709, including an unitemized INR 399. One additional flight to nearby NMI appeared on the page and was excluded from the exact BOM count.
- `runs/2026-09-28T16-58-03-472Z-72b080` — `current Wi-Fi connection`, headed external Chrome, DEL–BOM for 7 October 2026. The free local helper opened Google's audio puzzle, submitted one transcribed answer, and Air India then returned 28 exact BOM fares. `node src/verify.mjs` returned `ok: true`. One example is AI 2963 at INR 6,581 displayed (base 5,094 + taxes and fees 1,487); the response total is INR 6,980, including an unitemized INR 399. This is one observed audio-puzzle success, not a guarantee for future challenges.
- `web-runs/2026-09-28T17-04-12-827Z-d98bcf` — two-agent desk batch. Worker 1 completed DEL–BOM for 13 October with 25 verified fares; lowest displayed was AI 2425 at INR 6,423 (base 4,943 + taxes and fees 1,480; response total INR 6,822). Worker 2 reached a blank booking shell and saved no fare response, so the batch remained partial.
- `web-runs/2026-09-28T18-48-44-297Z-9533ab` — two-agent desk batch. Worker 2 completed DEL–BLR for 14 October with 20 verified fares; lowest displayed was AI 2653 at INR 8,722 (base 6,877 + taxes and fees 1,845; response total INR 9,121). Worker 1 captured 28 DEL–BOM offers and matching page cards, but its independent verifier crashed while the other Chrome worker was active; the batch remains partial. Its saved attempt later passed offline verification, but the original failed status is preserved.
- `web-runs/2026-09-28T18-53-22-913Z-0eeb69` — two-agent DEL–BOM/DEL–BLR batch for 8 October. Both Chrome contexts closed before either search saved a final result. The kernel logged a global out-of-memory event during this batch on the 5.2 GiB machine; it killed a desktop-app process. The run remains failed, with zero verified fares. The desk now lowers a requested worker count when total or currently available memory is insufficient and shows that decision in the run.
- The desk UI displayed all 26 saved BOM rows with the separate unitemized amount and links to the screenshot, saved page, and airline response. Desktop and 390px mobile smoke checks found 26 rows, no page errors, and no document overflow.

## Earlier controlled searches and failures

- `runs/2026-09-28T07-38-48-977Z-bfe0ac` — headed Playwright Chrome on `current Wi-Fi connection`; DEL–BOM, 3 October 2026. The route and date were confirmed, the form submitted, then `POST /in/en/refx-booking.html` returned HTTP 403 Access Denied. The batch stopped.
- The user reported that an ordinary manual browser search showed fares on that same Wi-Fi. This establishes that the connection was not universally denied; it does not reveal the precise difference in browser/session flow.
- The connected network later changed to `CMF BY NOTHING Phone 1_5281`. The collector did not change it. Searches on this network are a separate comparison.
- `runs/2026-09-28T07-47-50-695Z-8a2727` — normally launched headed Chrome, attached through local CDP, separate persistent profile. The booking POST returned HTTP 200 but Air India displayed Google reCAPTCHA. The collector stopped.
- `runs/2026-09-28T07-51-05-105Z-00d81c` — same browser path and route/date. A single checkbox click opened an image-selection puzzle. The collector recorded `captcha_puzzle_required`, saved the page and screenshot, and stopped without making another flight search. No fare response arrived.
- `runs/2026-09-28T08-23-56-952Z-f9c237` — on `current Wi-Fi connection`, externally launched Chrome with a separate persistent profile submitted DEL–BOM, 3 October. The booking POST returned HTTP 200 and the next page displayed Google reCAPTCHA. No fare response arrived.
- `runs/2026-09-28T08-26-49-765Z-0d134c` — on the same Wi-Fi, headed Playwright Firefox with a separate persistent profile submitted the same search. The booking POST returned HTTP 200 and the next page displayed Google reCAPTCHA. No fare response arrived. This shows that switching the automation engine to Firefox alone did not reproduce the user's successful ordinary Firefox session.
- `runs/2026-09-28T09-04-32-859Z-c367e6` — an optional local image solver attached to external Chrome after the booking POST returned HTTP 200. Its saved result records `Invisible reCaptcha Timed Out.`; no fare response arrived. The collector's event log incorrectly reported that no solver result existed. The collector now preserves the actual solver error or names the file-read failure, so the next diagnostic does not hide this cause.

Those earlier attempts remain failed searches, not sold-out flights. The three Air India HAR files briefly present in Downloads were zero bytes; they provided no comparable request or response. The older nonempty HAR in Downloads is for IndiGo, not Air India. A fresh desk worker profile also received HTTP 403 at the homepage in `web-runs/2026-09-28T16-49-10-933Z-22cce7`; the desk now uses the tested persistent profile for its first headed worker.

## Remaining acceptance work

The response schema and matching logic passed on DEL–BOM and DEL–BLR, including two connecting DEL–BLR itineraries. The free audio path cleared several observed audio challenges and failed on the three-desk run when speech recognition could not understand a clip. A blank booking shell, verifier crash, and system memory exhaustion made older two-agent batches partial or failed. The collector waits for page cards and fare JSON before labeling results rendered. Saved-page verification parses captured HTML directly instead of launching another Chrome. The memory check schedules one browser at a time on this 5.2 GiB machine and queues below 2 GiB available; below 1 GiB it refuses a new batch. Larger machines may run more workers when memory permits. Worker 3, macOS and Windows startup, and a separate fresh Ubuntu machine remain unverified. These limits keep a universal reliability claim unverified.

The package currently passes 17 focused local tests and source syntax checks. A fresh public-source clone passed `npm ci`, `npm test`, and `./start.sh` on this Ubuntu machine. The system-package portion of `setup-ubuntu.sh` was inspected and syntax-checked, but was not rerun on this already configured computer. No Wi-Fi or WARP settings were changed by the collector.
