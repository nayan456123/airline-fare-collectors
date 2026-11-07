# Air India native headless validation — 28 October 2026

On this Linux machine the CLI completed all twelve searches on their first
attempt, with 265 fares verified against the saved Air India response and
rendered results. No retry, access denial or challenge was recorded. The
requested campaign entry `https://www.airindia.com/?ai_pc=MYFLIGHTAIR` was
configured explicitly; the effect of its campaign parameter on inventory was
not separately tested. The run used one browser, a direct connection and no
CAPTCHA helper.

| Travel date | DEL–BOM fares | DEL–BLR fares |
| --- | ---: | ---: |
| 29 Oct | 26 | 20 |
| 2 Nov | 24 | 20 |
| 6 Nov | 23 | 20 |
| 12 Nov | 26 | 20 |
| 27 Nov | 23 | 20 |
| 12 Dec | 24 | 19 |

An independent audit matched each result to its requested route and date,
checked all attempt and evidence hashes, response timing and origin, and
matched fare prices to the rendered cards. Of the 265 fares, 237 were operated
by AI and 28 by IX; the operator is retained in each result. The saved CLI
run is `runs/2026-10-28T05-00-11-817Z-d9edfb`, with collector source
fingerprint `423af0c14e2b9cf82dac0bff0fde8fd355541287531aa4a7461bbe17083927db`.

A separate dashboard job using its default headless setting completed DEL–BOM
for 2 November on its first attempt with 24 verified fares. Its saved run is
`web-runs/2026-10-28T05-06-17-832Z-dd0b4b`. In both runs the live Chrome
process was independently observed with `--headless` and
`--ozone-platform=headless`, without DISPLAY or WAYLAND_DISPLAY. Chrome was
version 153.0.8010.12, using the installed Playwright Chromium executable and
the compatible Chrome user agent derived from that version.

These observations establish success for this sample and configuration. They
do not guarantee future access, fares, other routes, operating systems, proxy
connections or an unconfigured entry URL. Earlier headless attempts saved in
`runs/2026-10-27T10-47-37-187Z-1a3d80` and
`runs/2026-10-27T10-54-04-876Z-eac240` failed at the homepage with an HTTP/2
protocol error; they are retained as failures. A previous controlled trial
`runs/2026-10-27T10-58-01-854Z-2202e4` succeeded with 24 verified fares.
