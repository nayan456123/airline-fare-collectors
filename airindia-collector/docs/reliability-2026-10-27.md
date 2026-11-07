# Air India reliability audit — 27 October 2026 (IST)

## Latest measured result

The final normal-dashboard matrix completed **12/12 planned queries in 12
collector attempts**, all on the first attempt, with **275 independently
verified fares**. Observed query coverage and successful-attempt rate are both
**100% for this twelve-query sample**. There were **zero site-error detections
and zero UI Retry clicks**. This meets the observed sample target; it does not
guarantee future or universal success.

Run: `web-runs/2026-10-26T19-27-41-768Z-c96e78`, completed 19:33:50 UTC on
26 October (01:03:50 IST on 27 October). The exact predeclared two-route,
six-date query set was retained. Every worker used source fingerprint
`b5dc0297523365fa7391d3484299351d5397ab417bf817af8d2250518bf9c04b`.

The [independent final audit](../diagnostics/reliability-2026-10-27/final-cohort-c96e78-independent-audit.json)
confirms all twelve saved-evidence verifiers pass, all evidence hashes are
valid, every route/date matches the requested query, all cabins are known,
and all INR arithmetic reconciles: displayed fare = base + taxes/fees;
API total = displayed fare + separately retained additional amount.

| Route | Travel date | Collector attempts | Outcome | Verified fares |
|---|---|---:|---|---:|
| DEL–BOM | 2026-10-28 | 1 | Verified | 27 |
| DEL–BOM | 2026-11-01 | 1 | Verified | 25 |
| DEL–BOM | 2026-11-05 | 1 | Verified | 26 |
| DEL–BOM | 2026-11-11 | 1 | Verified | 27 |
| DEL–BOM | 2026-11-26 | 1 | Verified | 26 |
| DEL–BOM | 2026-12-11 | 1 | Verified | 24 |
| DEL–BLR | 2026-10-28 | 1 | Verified | 20 |
| DEL–BLR | 2026-11-01 | 1 | Verified | 20 |
| DEL–BLR | 2026-11-05 | 1 | Verified | 20 |
| DEL–BLR | 2026-11-11 | 1 | Verified | 20 |
| DEL–BLR | 2026-11-26 | 1 | Verified | 20 |
| DEL–BLR | 2026-12-11 | 1 | Verified | 20 |

The [full configured suite](../diagnostics/reliability-2026-10-27/full-configured-suite-after-navigation-retry.json)
passed **75/75 with no skips**, using actual local Chrome. The
[targeted navigation/site-error tests](../diagnostics/reliability-2026-10-27/navigation-and-site-retry-tests.json)
passed **25/25**. Because the final live matrix triggered no site error,
the single ordinary Retry path is verified by local fixtures, not by a live
recovery event. No unobserved recovery success is claimed.

## Corrections supported by the evidence

- **Calendar commit:** the homepage one-way picker can close immediately after choosing a date. Both automatic commit and explicit Confirm are supported; exact one-way/date/no-return guards still run afterward.
- **Airport selection:** a saved timeout showed DEL/Delhi already committed while destination autocomplete had focus. Selection clears/refills the input and accepts a disappearing option only if exact code, clicked city, and closed autocomplete confirm the commit; otherwise one fresh selection is attempted. Typed code alone never passes.
- **Cabin and price:** AI 2409's unavailable Economy summary showed INR 0, while selectable Premium Economy and the response both showed INR 34,432. The parser retains the cheapest available cabin using actual response availability metadata and selectable page prices. It explicitly labels cabin and strictly matches flight, exact airports, date, times, currency, and amount. Unknown/mixed cabins remain unverified; premium fares are never labelled Economy.
- **Rendering readiness:** a CAPTCHA-classified handoff saved an explicit verification template but a blank screenshot with body opacity zero and a loader. The detector now waits within the existing bounded results deadline for actual visible content and explicit visible challenge UI. Initial checks, polling, and catch use the same rule. Hidden template text cannot turn a render timeout into CAPTCHA; actual HTTP denials and visible challenges still stop immediately.
- **Ordinary navigation:** saved failures showed the fixed Where We Fly mega-menu intercepting the One Way label. The collector now sends Escape, moves the pointer off the header, and centers the target before a bounded ordinary click. It does not force clicks or remove overlays.
- **Airline system errors:** the actual localized “Something went wrong”/unexpected-issue page is classified `SITE_ERROR`. At most one ordinary flight-specific Retry click is allowed per collector attempt, within the original deadline, logged separately as `site_error_detected` and `site_retry`. Persistent errors remain failures. HTTP denials and visible challenges cannot trigger this action. SITE_ERROR itself is not eligible for a native retry; other retryable failures can still use the dashboard's maximum two collector attempts per query.

New saved successes use `fareEvidenceVersion: 2` and explicit cabin metadata
when the airline supplies it. Legacy saved records may omit only that newly
parsed cabin field during exact fare comparison; recorded cabin tampering or
version 2 cabin removal fails verification. All core fields remain strict.
The earlier 24-fare success still verifies.

## Normal startup and tested scope

The dashboard and CLI share validated `AIRINDIA_ENTRY_URL`. The generic default
is the plain root homepage; the verified campaign entry is an explicit
setting, saved with dashboard jobs, passed to normal workers, and retained on
retries. The live matrix used normal local API/dashboard workers, Visible
Chrome 153.0.8010.12 via external Chrome/CDP, one worker, the dedicated
`.session/headed` profile, Linux, and the direct connection. No CAPTCHA helper,
proxy, personal profile, or forced security interaction was used.

The bundled Node runtime is available here; npm is not installed in this
workspace. Start this workspace's dashboard with:

```bash
cd /home/nishant/Coding/sih1/airindia-collector
AIRINDIA_ENTRY_URL='https://www.airindia.com/?ai_pc=MYFLIGHTAIR' \
AIRINDIA_CHROME_PATH="$PWD/.session/browser/chromium-153/chrome-linux64/chrome" \
/home/nishant/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node src/server.mjs
```

Open `http://127.0.0.1:8789/` and choose Visible Chrome and one worker. Generic
npm instructions remain suitable for environments where npm is installed.
Headless mode, other operating systems, proxy mode, and the access/fare effect
of removing or changing the campaign parameter remain unverified. Cheapest
available all-cabin fares must not be described as Economy-only fares.

The [dashboard UI review](../diagnostics/reliability-2026-10-27/dashboard-qa-report.json)
checks displayed cabin/price against saved data, desktop and 390-pixel mobile
layout, and absence of page/console errors. It is separate from live reliability.

## Preserved history and failed cohorts

Earlier outcomes remain saved with their original status. They are not merged
into the latest source's rate or rewritten after corrections.

| Cohort | Saved outcome | Verified fares | Key limitation |
|---|---|---:|---|
| CLI `2026-10-26T17-50-09-950Z-92699f` | Partial, 10/12 queries | 241 | Cabin-summary mismatch and disappearing airport option |
| Dashboard `2026-10-26T18-55-01-279Z-9a5918` | Cancelled, 7 successes in 8 launched attempts | 174 | Server interruption; cause unknown |
| Native recovery `2026-10-26T19-03-46-156Z-902fff` | Blocked, 3 successes in 4 launched attempts | 60 | Verification template classified before visible readiness; final query skipped |
| Readiness diagnostic `2026-10-26T19-12-17-046Z-968b6e` | Complete, one query/attempt | 20 | Narrow diagnostic, not a matrix |
| Dashboard `2026-10-26T19-13-42-216Z-559145` | Partial, 8/12 queries in 15 attempts | 189 | Actual airline error UI and three menu-interception failures |

The original dashboard plus recovery covered 10/12 unique planned queries in
12 launched attempts (83.3% for both denominators), including one interruption
and one classified CAPTCHA. The interruption's cause is not established. The
blank prehidden challenge-template capture proves neither a visibly presented
challenge nor the eventual outcome had rendering continued.

That original pair used fingerprint
`145725c700f67e0847e0649f747890e0516e7cd713f15e6c9e18b9ca78d9bd8e`;
the readiness diagnostic and subsequent partial matrix used
`5e09c73741c91d35fa7b92965f0072d5504314f13042b4d78a94145f2e4f8b9c`.
The final cohort is a distinct source version, not a repeated attempt silently
substituted for those failures.

The [recovery audit](../diagnostics/reliability-2026-10-27/recovery-artifact-review.json)
and [partial-matrix audit](../diagnostics/reliability-2026-10-27/final12-artifact-audit.json)
retain those earlier results. The latest independent audit confirms the old
AI 2409 failed record is unchanged, with SHA-256
`a8660006ea3c20402543d86edc48440f44a6ed511aa4182f312bab68ec0e92ef`,
and confirms the prior audit was not overwritten. The
[26 October review](reliability-2026-10-26.md) retains legacy-entry denials and
the earlier form-adapter investigation.
