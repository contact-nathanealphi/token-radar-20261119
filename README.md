# token-radar-20261119

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/contact-nathanealphi/token-radar-20261119/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/contact-nathanealphi/token-radar-20261119/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a sealed snapshot of every protocol DefiLlama tracks, prices each protocol that records no token at the peer multiple its own category's live tokens carry, and writes a web dashboard ranking them by implied launch value — each with a detail view, a valuation breakdown, and the steps to farm it. The board covers all 40 watchlist protocols plus every other rankable pre-token protocol in the snapshot (198 rows), and the same code scores a future snapshot with protocols that do not exist yet.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <unpacked-kit>/input/snapshot.json
```

Node.js 22.18 or later, standard library only — nothing to install. The program writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/` and `out/dossier.json`. Open `out/dashboard/index.html` in a browser to use the radar.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9ncgmbd6&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
