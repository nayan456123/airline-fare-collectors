# Air India Express Fare Collector interaction contract

- The collector targets the official Air India Express booking page. Routes
  accept `AAA-BBB`, `AAA:BBB`, or `AAA→BBB`; dates use the offered offsets
  T+1, +5, +9, +15, +30, and +45 in Asia/Kolkata. A batch is limited to 54
  route/date searches.
- Only one batch may run at a time. The web scheduler admits one worker, and
  starts successive searches at least 20 seconds apart. Native headless Chrome
  is the default; visible Chrome requires explicit selection. There is no
  automatic visible fallback. Headless mode and Firefox are selectable. Non-proxied headless Chrome
  uses ordinary Chrome with its actual native `--headless` flag, loopback CDP,
  and the same installed browser's compatible Chrome user agent. Authentication
  remains browser native. Its profile is separate from native-UA defaults; no
  visible-session copy or virtual display is used. Chrome's HTTP/2 disabling
  switch applies per job and is unavailable for Firefox.
- Each browser uses a persistent profile. The UI reports progress and each
  search's status. Stop interrupts active work and preserves attempted
  evidence. CAPTCHA, access denial, rate limiting, and expired sessions block
  the batch and prevent queued searches from starting. A verification-service
  connection/load error is reported separately as
  `VERIFICATION_SERVICE_UNAVAILABLE`; it also stops queued work without an
  automatic retry. Real interactive challenges remain `CAPTCHA`.
- After submission, readiness is bounded at 120 seconds for the official FSA
  response and rendered rows; incomplete loading is eligible for one transient
  retry unless a terminal denial or verification failure is present. A worker
  has a ten-minute outer limit for both attempts and artifact cleanup.
- A fare may appear only after a supported AIX response schema is parsed and
  independently checked against the submitted route/date and rendered result
  evidence. The parser supports the observed AIX flight-search response schema;
  unknown or inconsistent responses fail verification. A submitted search
  without verified rows is not a successful fare search and must not be
  represented as sold out.
- Evidence controls expose saved local pages, screenshots, and captured
  response/network evidence. Saved page HTML is evidence only; the local app
  must not execute it.
- Keep status and failure information readable, announce updates to assistive
  technology, preserve keyboard focus during refreshes, and keep actions usable
  on narrow screens.
