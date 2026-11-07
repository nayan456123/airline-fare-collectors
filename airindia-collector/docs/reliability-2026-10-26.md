# Air India collector reliability review — 26 October 2026

## Current diagnosis after the first 12-query matrix

The frozen-source matrix `diagnostics/reliability-matrix-2026-10-26/2026-10-26T17-50-09-950Z-92699f` finished with 10 successful queries out of 12 (83.3%) and 241 verified fares. Two queries failed: DEL–BLR on 27 October had a cabin-summary parsing mismatch, and DEL–BLR on 10 December timed out selecting the origin option. This historical batch remains partial.

Offline inspection of the first failure found 20 airline offers and 20 exact-route page cards. Nineteen matched; AI 2409 alone differed because the extractor read the unavailable Economy summary's INR 0. The page explicitly offered Premium Economy for INR 34,432 and Business for INR 56,386; the response's cheapest bound was likewise Premium Economy (`availabilityDetails.cabin: ecoPremium`) at INR 34,432. The corrected extractor compares the lowest available selectable cabin with the response's lowest bound and retains an explicit cabin label. Unknown or mixed cabin metadata remains unverified. The saved failed query now reconciles offline without changing its recorded failed status.

The other failure's saved screenshot shows DEL/Delhi already committed while destination autocomplete is open; it does not establish exactly why the original origin option vanished before its click. Selection now clears and refills the input, and a bounded recovery accepts only the exact committed code/city with closed origin autocomplete, or retries selection once. No typed code alone is accepted.

New successful records include `fareEvidenceVersion: 2` and cabin metadata when supplied by the airline. The verifier retains exact comparisons of all core fields. Only an absent cabin on an older record can omit the newly parsed cabin from its fare comparison; recorded cabin values are still checked, and version 2 cannot use that compatibility exception. The earlier 24-fare successful run still verifies offline. The dashboard displays cabin under the flight number.

CLI and dashboard now share validated `AIRINDIA_ENTRY_URL` configuration. The generic default is the plain root homepage; the verified campaign entry remains an explicit setting, saved per dashboard job and preserved for retries. Further live verification of these corrections is pending.

### Earlier 17:48 checkpoint

The first complete run using the corrected homepage adapter succeeded for DEL–BOM on 31 October 2026: `diagnostics/homepage-adapter-2026-10-26/2026-10-26T17-47-48-183Z-4f7136`. The result reached `fare_verified` and saved 24 fares matching the requested route/date with both rendered-page and airline-response evidence; 25 cards were rendered. This is one successful query, not a completeness or high-success-rate claim. The manifest records the user's exact `https://www.airindia.com/?ai_pc=MYFLIGHTAIR` entry, headed Chrome 153.0.8010.12 via external Chrome/CDP, the dedicated `.session/headed` profile, and no proxy or CAPTCHA helper. Source fingerprint: `54e58b6f6423c5899be3d03d2546c00d3c6134b3642926eff79bb4edf65b40ff`.

The configured local suite passed 56/56 before this successful run. A broader 12-query matrix is pending on the same frozen source. Earlier failed attempts below remain part of the history and are not included in a claim of repeated successful collection.

### Earlier 16:08 checkpoint

The fifth collector attempt reached the exact requested combined homepage state: its saved failure screenshot shows One Way, DEL–BOM, `31 Oct 2026`, Add Return, and an enabled Search button. The calendar was closed at failure capture. The adapter nevertheless timed out looking for a visible calendar Confirm button after clicking the date. The homepage adapter now supports both automatic closure and an explicit Confirm button, and still requires the existing strict one-way/date/no-return guard after closure. This correction awaits local regression results and a new live run; the fifth attempt yielded no verified fares.

There was no explicit Search UI click in that attempt. Two aborted POST requests to `api.airindia.com/airline-fares/v1/search` occurred during the calendar interaction. Their purpose is unknown without payload or usable response evidence; they are not counted as successful flight searches or collected offers. Evidence is retained at `diagnostics/homepage-adapter-2026-10-26/2026-10-26T16-08-16-627Z-e49384`.

### Earlier 16:03 checkpoint

The user reports that normal searches work in all browsers and supplied the successful entry URL `https://www.airindia.com/?ai_pc=MYFLIGHTAIR`. That user-reported success was not independently observed in their browser. Two collector visits to this exact root entry returned HTTPS 200 and exposed an Angular booking widget with controls different from the legacy deep-link page. This is an observed entrypoint/layout difference; it does not establish that the campaign parameter bypasses an access rule.

At this checkpoint there have been **four collector run attempts, zero completed fare runs, and one actual flight Search submission**. The first legacy Playwright run submitted Search and received a booking-handoff 403. The second legacy-entry/CDP run stopped on homepage 403. The third, exact-root/CDP run loaded HTTP 200 but failed while waiting for a deliberately hidden native radio. The fourth, using the new homepage adapter, also loaded HTTP 200 but failed its origin-selection guard before TO/date/Search. A separate ordinary UI probe inspected controls and submitted no Search. Calendar option prices are not verified flight offers and are not counted as collected fares.

The new adapter uses the visible One Way label, exact airport-code option descendants in scoped comboboxes, and the visible Depart child of the combined date button. The parent date button's center was observed to open Add Return/return-date selection instead. The adapter now checks departure-calendar mode and confirms the complete one-way route/date before Search. Booking popup descendants are tracked, and matching results are polled on the current page. Legacy submission behavior remains available; the production default entry URL has not been switched merely because the root page returned 200.

The fourth run's saved HTML shows a Delhi bottom label, while its screenshot shows DEL; the Angular input's runtime value is not serialized into saved HTML. The original guard read the value immediately after the option disappeared. An asynchronous commit is a hypothesis, not an established cause. A strict follow-up now polls for the exact clicked option's airport code and city with the combobox closed, retains those selections for the final form guard, and reports the actual observed code/city/expanded state on failure. It does not accept typed code alone or city text alone. The independent configured suite passed 55/55 after this correction, including delayed-commit and permanently wrong-commit regressions plus final-guard negatives. The asynchronous race is reproduced in a local fixture; a combined-form live result is still required to establish the real-site outcome.

Evidence for the two new pre-submit failures is retained at `diagnostics/homepage-comparison-2026-10-26/2026-10-26T15-42-00-233Z-d8d14f` and `diagnostics/homepage-adapter-2026-10-26/2026-10-26T16-03-13-823Z-f6234a`. The UI probe's sanitized control captures are in `diagnostics/homepage-ui-2026-10-26`. The probe browser was closed before the adapter run; no personal profile, copied cookies, proxy, or CAPTCHA helper was used.

## Initial legacy-entry checks

The fresh live search was blocked by an HTTP 403 at Air India's booking handoff. The booking form had confirmed DEL–BOM for 31 October 2026 and submitted successfully. `POST /in/en/refx-booking.html` then returned an explicit Access Denied page. No flight-offer response arrived, and the collector saved zero fares with `status: blocked` and `cause.code: ACCESS_DENIED`.

This identifies the immediate failure as an airline-side access rejection before fare parsing. The evidence does not establish which browser, session, network, or access-rule characteristic caused that rejection. A parser correction cannot repair this particular response. The user subsequently reported that normal searches work on the same connection; this was not independently observed. That rules out a universal connection-wide denial; it does not establish which browser/session difference caused the collector rejection.

The initial run used headed Chrome for Testing 153 through Playwright launch, a persistent local profile, no proxy, and no CAPTCHA helper. Its planned twelve-search matrix stopped after the first denial; the other eleven matrix searches were not submitted. After the user confirmed ordinary searches work, one separately authorized external Chrome/CDP comparison was attempted with the same dedicated profile and binary. It was also blocked, this time at the redirected homepage before form entry. The observed outcome across those first two bounded runs was **0 completed collector runs out of 2 attempted**, with only the first run reaching a flight Search submission, not a general success-rate estimate. No access challenge was bypassed; each run stopped on denial. Headless operation, other routes/dates, and other operating systems remain untested in this check.

Local evidence, retained outside version control:

- `diagnostics/live-matrix-2026-10-26/2026-10-26T14-00-41-387Z-67c84c/manifest.json`
- The same directory's `events.ndjson` and `01-DEL-BOM-2026-10-31/result.json`, booking response, form capture, and failure capture.
- `diagnostics/reliability-2026-10-26/independent-validation.json` records independent local validation.

The event log records form confirmation at 14:00:58 UTC, search submission at 14:01:01 UTC, and the booking POST's 403 at 14:01:02 UTC. The versioned report omits browser profile contents, raw response bodies, and access-reference identifiers.

## Additional defects corrected

These defects were established through source analysis and controlled regression tests. They are separate from the live 403:

- Segment parsing accepted disconnected airports and connections departing before the previous segment arrived. It now validates segment timestamps, positive flight duration, airport continuity, and connection time order. Canonical minute/second timestamps and explicit offsets are accepted. Offset-free timestamps use IST deterministically for this domestic desk; international itineraries without explicit timezone offsets remain an unvalidated limitation.
- Response selection accepted the first recognizable flight response. It now considers completed responses, newest first, and requires full agreement with rendered cards. Stale, unrelated, empty, or invalid candidates cannot hide a separate matching response; an unmatched response cannot produce verified fares.
- Result readiness previously needed only any captured JSON and a card wrapper. It now requires two consecutive identical, fully matched response/card snapshots within a bounded wait. Pending unrelated response bodies no longer hold an unbounded `Promise.all` wait. The saved HTML itself is matched before success, and the independent verifier repeats that check. This improves rendering synchronization; it does not prove that the airline will never update a previously stable page later.
- Empty displayed price text was coerced to zero, and decimal text lost its decimal separator. Such malformed prices now fail matching. Each page card can satisfy only one fare.
- Saved-fare verification could reuse one response offer for duplicate saved rows when the total row count stayed unchanged. Offers are now consumed once. An empty agent manifest also fails verification.
- Search-specific homepage and fare-response 401/403/429 statuses now become explicit access failures. Visible Access Denied text takes precedence over generic CAPTCHA wording. Unrelated static asset failures do not become access denials. Airline hostname matching now requires the actual domain or a subdomain boundary.

No optional CAPTCHA helper behavior, browser admission policy, dashboard design, or unrelated collector was changed for these fixes.

## Validation

Initial independent validation with `AIRINDIA_TEST_CHROME_PATH` configured passed **38 of 38 tests**, with zero failures, skips, or cancellations. The default suite passed **37 tests with 1 optional browser test skipped** and zero failures. Exact outputs are retained in `diagnostics/reliability-2026-10-26/test-configured.tap` and `test-default.tap`. Coverage includes connected/direct/overnight itineraries, explicit timezone offsets, malformed fare data, candidate fallback, partial-to-complete rendering, stable-match and timeout behavior, access classification, same-count duplicate saved-fare substitution, tampered evidence, and empty manifests. Rendering-loop unit tests use a controlled page fixture. The versioned optional test `test/browser-results.test.mjs` also exercises the helper in actual Chromium 153: it begins with an incomplete card, inserts a matching card after 500 ms, and checks stable matching within a 5-second timeout. It blocks nonlocal requests and asserts none occur. These checks do not claim successful live airline rendering.

The local API smoke check returned HTTP 200 for configuration and all three dashboard assets. An invalid same-airport route returned HTTP 400 before any run or browser launch. Server shutdown was clean. Syntax checks passed for 16 source/test files, and `git diff --check` passed. Synthetic screenshot bytes in verifier fixtures test file hashes only, not screenshot image content.

## Reproduction on this workspace

Run local checks without contacting Air India:

```bash
cd /home/nishant/Coding/sih1/airindia-collector
AIRINDIA_NODE=/home/nishant/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
"$AIRINDIA_NODE" --test
AIRINDIA_TEST_CHROME_PATH="$PWD/.session/browser/chromium-153/chrome-linux64/chrome" \
  "$AIRINDIA_NODE" --test
"$AIRINDIA_NODE" src/verify.mjs diagnostics/live-matrix-2026-10-26/2026-10-26T14-00-41-387Z-67c84c
```

The saved live run is expected to fail fare verification with `Search status is blocked: ACCESS_DENIED` and exit code 2; this is the correct outcome for a blocked, zero-fare search. The independent saved-run check reported `evidenceIntegrityOk: true` and intact attempt evidence; only the blocked search status prevented fare verification. The sanitized live summary is `diagnostics/reliability-2026-10-26/live-summary.json`.

The following reproduces the live mode and query after access permits a new ordinary search. It is recorded for review and was not rerun after the denial. The retained browser executable is local and ignored by version control:

```bash
cd /home/nishant/Coding/sih1/airindia-collector
AIRINDIA_NODE=/home/nishant/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
AIRINDIA_CHROME_PATH="$PWD/.session/browser/chromium-153/chrome-linux64/chrome" \
  "$AIRINDIA_NODE" src/collect.mjs --headed --search DEL:BOM:2026-10-31 \
  --retries 0 --output diagnostics/live-matrix-2026-10-26
```

The date must still be a future travel date when using this command. This uses Playwright launch, not `--external-chrome`, and selects no CAPTCHA option.

## Follow-up audit of the blocked submission

An offline inspection of the saved booking widget confirms `From DEL Delhi`, `To BOM Mumbai`, `Depart 31 OCT 2026`, one adult, and Economy. The saved page has no HTML form action or base URL. The collector selects the airline's UI controls, rechecks the displayed route/date, and clicks the site's Search button; it does not construct a booking payload or rewrite a handoff URL. No concrete malformed destination, route/date mismatch, insecure form action, or collector-induced handoff bug was found in this evidence.

The denial body prints an entity-encoded `http://www.airindia.com/in/en/refx-booking.html` URL. That server-generated text alone does not establish an HTTP downgrade. Stored network records retain hostname, path, method, and status, but omit protocol and the redirect chain. The manifest's HTTPS source identifies the starting page, not the handoff's transport. The available capture cannot settle that transport question.

Before the later external-CDP comparison, the follow-up audit found one retained live run and no active collector process. Repeating only the offline verifier still reported intact evidence (`evidenceIntegrityOk: true`) and correctly rejected fare verification because the search was blocked. No additional live requests were made. At that point the ordinary-browser outcome was still pending and external Chrome/CDP was untested; the later user confirmation and separate comparison are recorded below. This earlier Playwright-launch denial alone did not establish that every mode was denied.


## Ordinary-browser confirmation and external Chrome/CDP comparison

The user reported that normal searches work on the same connection; this was not independently observed. A single documented `--headed --external-chrome --retries 0` comparison then used the same retained Chrome 153.0.8010.12 binary and dedicated `.session/headed` profile, with no personal browser profile, copied cookies, proxy, or CAPTCHA option. Evidence is retained in `diagnostics/external-comparison-2026-10-26/2026-10-26T15-05-30-314Z-c2daa8`.

Sanitized diagnostics captured HTTPS GET `/in/en/book/search-flights.html` returning 301 to HTTPS `/en-in/book-flights/`, followed by HTTP 403 at that HTTPS destination. The run stopped at `homepage_loaded`, before form entry, with zero fares. Independent offline verification reported intact evidence and correctly rejected fare verification for `ACCESS_DENIED`. This captured navigation did not downgrade to HTTP. The original run's booking POST transport remains unresolved because its older metadata omitted the protocol.

The diagnostics now preserve protocol, same-AirIndia redirect paths/statuses, browser version, and transport. They omit URL credentials, ports, query strings, fragments, request payloads, cookies, and response headers. Five additional offline metadata regressions cover sanitization, hostname boundaries, and redirect handling; the final configured local suite passed **43/43 tests**. A separate local persistent-browser smoke confirmed browser version reporting without loading any page.

Both tested collector launch modes were blocked, at different stages and times. This comparison does not isolate a single launch flag or session characteristic as the cause; session evolution and access-rule timing remain possible differences. There was no further matrix expansion after the second denial. The remaining blocker is the collector browser/session's access rejection, not an observed fare parser failure. Further authorized comparisons would require new evidence about the working ordinary-browser flow rather than repeated denied submissions.


The user's working browser was not available in the connected browser inventory, which contained only empty in-app/MCP Apps surfaces. The user later reported that all browsers work and supplied the exact root entry URL recorded above; their browser itself remained unavailable to inspect. Live collection and the broader reliability goal remain unfinished; local regression success is not completion of that goal.
