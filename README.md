# Airline Fare Collectors

Five independent, local browser collectors for current fare searches on the
public booking sites of IndiGo, Akasa Air, Air India, Air India Express, and SpiceJet.
They use rendered airline pages and save per-search route, travel date,
collection time, flight and fare breakdown, page/network evidence, and failure
cause. A failed or blocked search stays a failure; no fare is invented and an
empty result is not labeled “sold out.” No paid scraping API or airline login
is required.

These are independent research prototypes, not airline products or booking
services. Airline sites can change and can deny automated access. The collectors
stop on CAPTCHA/access denial and do not bypass those checks. A successful
installation does not guarantee that an airline will return a fare.

## Choose a collector

| Collector | Local page | Source and operating-system setup |
| --- | --- | --- |
| IndiGo | http://127.0.0.1:8787/ | [indigo-collector/README.md](indigo-collector/README.md) |
| Akasa Air | http://127.0.0.1:8788/ | [akasa-collector/README.md](akasa-collector/README.md) |
| Air India | http://127.0.0.1:8789/ | [airindia-collector/README.md](airindia-collector/README.md) |
| Air India Express | http://127.0.0.1:8791/ | [airindia-express-collector/README.md](airindia-express-collector/README.md) |
| SpiceJet | http://127.0.0.1:8790/ | [spicejet-collector/README.md](spicejet-collector/README.md) |

## Troubleshooting

See [Troubleshooting and recorded failure history](TROUBLESHOOTING.md) for plain-language meanings of common failures, known dated issues, and guidance on logs and credentials.

## Requirements

Ubuntu 22.04/24.04, macOS, or Windows 10/11; Git; Node.js 20 or newer; Google
Chrome; and an internet connection. Some Air India setup options also install
Python and FFmpeg for an optional helper described in that collector's guide.
The setup instructions are specific to each collector; read them before
starting. Cross-platform setup instructions are provided, but the collectors
were developed on Ubuntu and not every operating system path has been live-
tested.

## Get the source

This repository is public, so cloning it does not require GitHub credentials.
Install Git for your operating system, then run:

```sh
git clone https://github.com/nayan456123/airline-fare-collectors.git
```

Each collector has its own dependencies, local data folders, and server. Open
its README and follow the matching Ubuntu, macOS, or Windows instructions. In
general, each page runs from that collector's directory in a terminal, and the
terminal must stay open. Use one collector at a time on lower-memory computers;
Chrome instances consume significant memory.

## Data and privacy

Browser profiles, cookies, local run history, screenshots, captured airline
responses, and proxy settings stay on the computer and are excluded from this
repository. Do not share a run folder or browser profile without checking it
first; it may contain session or travel-search information. Configure only a
proxy you are authorized to use. The collectors do not rotate proxies to evade
an airline's denial.
