# Headless dashboard recovery — 28 October 2026

The reported DEL–BLR search for 27 November failed at the Air India homepage
with `ERR_HTTP2_PROTOCOL_ERROR`. The saved evidence shows a network failure
before flight search submission; it does not establish whether Chrome, the
network path, or Air India caused the protocol error. A reused dashboard
profile also restored dozens of old tabs. Suppressing startup windows alone
did not reliably prevent restoration in that profile, so direct headless
dashboard searches now use separate collector-owned profiles and disable
HTTP/2. Prior profiles are preserved. CLI users can select Chrome's
`--disable-http2` option explicitly.

A first dashboard batch after the transport change still failed two searches:
one had matching cards and response only after the 20-second stability window;
the other remained in the booking loading shell without a fare response. The
rest of that batch was cancelled. The result wait is now bounded at 45 seconds,
still requires two matching snapshots, and uses at most the configured bounded
retry for missing or unstable results. Access denials and challenges stop the
batch. Diagnostic events distinguish missing cards, missing candidates and
unstable or mismatched results without logging URL queries or request payloads.

After these changes, a dashboard retest of both failed dates passed 2/2 on the
first attempt. A broader dashboard batch then passed **12/12 on the first
attempt**, with **265 verified fares**, no failures or retries, and no access
denials or challenges. Each saved result passed the strict evidence verifier.
Chrome's `--headless` and `--disable-http2` arguments were observed on Linux;
no DISPLAY or WAYLAND display was present. Searches used one worker, a direct
connection, fresh task profiles and the explicitly configured campaign URL
`https://www.airindia.com/?ai_pc=MYFLIGHTAIR`.

| Date in 2026 | DEL–BLR | DEL–BOM |
| --- | ---: | ---: |
| 29 Oct | 20 | 26 |
| 2 Nov | 20 | 24 |
| 6 Nov | 20 | 23 |
| 12 Nov | 20 | 26 |
| 27 Nov | 20 | 23 |
| 12 Dec | 19 | 24 |

The final batch is `web-runs/2026-10-28T06-22-18-294Z-4020b6`, with source
fingerprint `b3730c915eba8570027bbb84e33da2903ee2a5eb0a38d76e0013f60899aac250`.
The two-date retest is `web-runs/2026-10-28T06-20-48-605Z-e14e8b`; the
failed and cancelled batch is `web-runs/2026-10-28T06-09-10-974Z-3fbf43`.
The local browser-enabled suite passed 94 tests with no failures or skips.

These observations cover this sample and setup; they do not guarantee future
results or prove the underlying cause of the HTTP/2 error. Generated profiles
are retained under `.session/dashboard-headless/` and consume disk space; see
the README for cleanup guidance.
