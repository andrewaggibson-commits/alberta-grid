# alberta-grid

A small static website showing Alberta's current electricity generation mix,
built from AESO's [Current Supply Demand report](http://ets.aeso.ca/ets_web/ip/Market/Reports/CSDReportServlet).
It is hosted for free on GitHub Pages and updated by GitHub Actions.

## How it works

```
GitHub Actions (cron, every 5 min)
  └─ scripts/scrape.py ── fetches the CSD HTML page from ets.aeso.ca
       ├─ data/latest.json    current snapshot (summary, fuel groups, interties)
       └─ data/history.json   rolling 7 days of 5-minute snapshots
  ├─ force-pushes the JSON as a single commit to the `data` branch
  └─ deploys site/ + data/ to GitHub Pages (upload-pages-artifact + deploy-pages)

Browser: site/index.html + app.js re-fetch data/latest.json every 2 minutes.
```

- **Scraper** (`scripts/scrape.py`, standard library only, plus `tzdata`) finds
  the SUMMARY, GENERATION and INTERCHANGE tables by their heading text and
  checks that the totals agree. If the page isn't recognised it exits non-zero
  and writes nothing, so a bad run never overwrites good data.
- **`data` branch** holds only the latest JSON. It's replaced on every run
  (one commit, force-pushed) so the repository doesn't grow by hundreds of
  commits a day; `main` stays code-only.
- **Times** are Alberta wall-clock times as published by AESO (America/Edmonton).
  The pinned `tzdata` package keeps the UTC offset correct even if a runner's
  system time-zone data is out of date.

### Sign conventions

AESO reports interchange as positive for exports, so
`Alberta Internal Load = Total Net Generation − Net Actual Interchange`.
The site shows **transfers with imports positive**, so
demand = generation + transfers.

### Carbon intensity

This is an estimate: each fuel group's output multiplied by a typical direct
emissions factor (gCO₂/kWh; listed in `site/app.js` and on the page), divided by
total generation. Imports aren't counted.

## Local development

Needs Python 3.10+.

```sh
pip install -r requirements.txt
python -m unittest discover -s tests       # parser tests against a saved real page
python scripts/scrape.py --out data        # fetch live data into ./data (git-ignored)
python scripts/serve.py                    # preview at http://localhost:8000/
```

`scrape.py --html FILE` parses a saved page instead of fetching.

## Credits

The visual design, stylesheet (`site/grid.css`) and the pie-chart and equation
logic are adapted from Kate Morley's [grid](https://github.com/KateMorley/grid),
which is released under CC0. The typeface is
[Proza Libre](https://fonts.google.com/specimen/Proza+Libre) (SIL Open Font License).
This project is not affiliated with AESO.
