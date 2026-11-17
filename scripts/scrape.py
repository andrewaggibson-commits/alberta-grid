#!/usr/bin/env python3
"""Scrape AESO's Current Supply Demand (CSD) report into JSON.

Writes <out>/latest.json and appends to a rolling <out>/history.json
(last 7 days of snapshots). Standard library only.

Exits non-zero, without writing anything, if the page layout is not
recognised or the numbers don't add up - so a bad run never overwrites
good data.

Usage:
    python scripts/scrape.py [--out DIR] [--html FILE]
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

CSD_URL = "http://ets.aeso.ca/ets_web/ip/Market/Reports/CSDReportServlet"
EDMONTON = ZoneInfo("America/Edmonton")
HISTORY_DAYS = 7
USER_AGENT = "alberta-grid/1.0 (static generation-mix website; polls every 5 minutes)"

# AESO fuel group name -> (key, display label, category)
FUEL_GROUPS = {
    "COGENERATION": ("cogeneration", "Cogeneration", "gas"),
    "COMBINED CYCLE": ("combined_cycle", "Combined cycle", "gas"),
    "SIMPLE CYCLE": ("simple_cycle", "Simple cycle", "gas"),
    "GAS FIRED STEAM": ("gas_fired_steam", "Gas-fired steam", "gas"),
    "DUAL FUEL": ("dual_fuel", "Dual fuel", "fossil"),
    "COAL": ("coal", "Coal", "fossil"),
    "WIND": ("wind", "Wind", "renewable"),
    "SOLAR": ("solar", "Solar", "renewable"),
    "HYDRO": ("hydro", "Hydro", "renewable"),
    "ENERGY STORAGE": ("energy_storage", "Energy storage", "other"),
    "OTHER": ("other", "Other", "other"),
}

INTERTIES = {
    "BRITISH COLUMBIA": ("bc", "British Columbia"),
    "MONTANA": ("montana", "Montana"),
    "SASKATCHEWAN": ("saskatchewan", "Saskatchewan"),
}

SUMMARY_KEYS = {
    "ALBERTA TOTAL NET GENERATION": "total_net_generation",
    "NET ACTUAL INTERCHANGE": "net_actual_interchange",
    "ALBERTA INTERNAL LOAD (AIL)": "internal_load",
    "NET-TO-GRID GENERATION": "net_to_grid_generation",
    "CONTINGENCY RESERVE REQUIRED": "contingency_reserve_required",
    "DISPATCHED CONTINGENCY RESERVE (DCR)": "dispatched_contingency_reserve",
}
REQUIRED_SUMMARY = ("total_net_generation", "net_actual_interchange", "internal_load")

# Totals that don't match within this many MW mean something is wrong.
TOLERANCE_MW = 5


class LayoutError(Exception):
    """The CSD page did not look the way we expect."""


# --------------------------------------------------------------------------
# Fetching


def fetch(url: str = CSD_URL, attempts: int = 3) -> str:
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as resp:
                charset = resp.headers.get_content_charset() or "latin-1"
                return resp.read().decode(charset, errors="replace")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
            print(f"fetch attempt {attempt}/{attempts} failed: {exc}", file=sys.stderr)
            if attempt < attempts:
                time.sleep(5 * attempt)
    raise RuntimeError(f"could not fetch {url}: {last}")


# --------------------------------------------------------------------------
# Parsing


def text_of(fragment: str) -> str:
    """Strip tags, decode entities, collapse whitespace."""
    no_tags = re.sub(r"<[^>]*>", " ", fragment)
    return re.sub(r"\s+", " ", html.unescape(no_tags)).strip()


def table_rows(page: str, heading: str) -> list[list[str]]:
    """Return the cell texts of the table whose <TH> heading is `heading`.

    The CSD markup is old and loosely nested, so rather than build a DOM we
    find the heading cell and read <TR> rows up to the next </TABLE>.
    """
    for th in re.finditer(r"<th\b[^>]*>(.*?)</th>", page, re.I | re.S):
        if text_of(th.group(1)).upper() != heading:
            continue
        end = re.search(r"</table\s*>", page[th.end():], re.I)
        if not end:
            raise LayoutError(f"table '{heading}' has no closing </TABLE>")
        body = page[th.end(): th.end() + end.start()]
        rows = []
        for tr in re.split(r"<tr\b[^>]*>", body, flags=re.I)[1:]:
            cells = [text_of(c) for c in re.split(r"<td\b[^>]*>", tr, flags=re.I)[1:]]
            if cells:
                rows.append(cells)
        if not rows:
            raise LayoutError(f"table '{heading}' has no rows")
        return rows
    raise LayoutError(f"no table with heading '{heading}' found")


def to_int(value: str, context: str) -> int:
    cleaned = value.replace(",", "").strip()
    if not re.fullmatch(r"-?\d+", cleaned):
        raise LayoutError(f"expected a whole number of MW for {context}, got {value!r}")
    return int(cleaned)


def parse_timestamp(page: str) -> datetime:
    m = re.search(r"Last Update\s*:\s*([A-Za-z]{3} \d{1,2}, \d{4} \d{1,2}:\d{2})", text_of(page))
    if not m:
        raise LayoutError("'Last Update' timestamp not found")
    naive = datetime.strptime(m.group(1), "%b %d, %Y %H:%M")
    return naive.replace(tzinfo=EDMONTON)


def parse_summary(page: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for cells in table_rows(page, "SUMMARY"):
        if len(cells) < 2:
            continue
        key = SUMMARY_KEYS.get(cells[0].upper())
        if key:
            out[key] = to_int(cells[1], cells[0])
    missing = [k for k in REQUIRED_SUMMARY if k not in out]
    if missing:
        raise LayoutError(f"SUMMARY table is missing: {', '.join(missing)}")
    return out


def parse_generation(page: str) -> tuple[list[dict], dict[str, int]]:
    rows = table_rows(page, "GENERATION")
    header = [c.upper() for c in rows[0]]
    if header[:3] != ["GROUP", "MC", "TNG"]:
        raise LayoutError(f"GENERATION header not recognised: {rows[0]}")
    col = {name: i for i, name in enumerate(header)}

    fuels, total = [], None
    for cells in rows[1:]:
        if len(cells) < len(header):
            raise LayoutError(f"GENERATION row too short: {cells}")
        name = cells[0].upper()
        mc = to_int(cells[col["MC"]], f"{name} MC")
        tng = to_int(cells[col["TNG"]], f"{name} TNG")
        if name == "TOTAL":
            total = {"mc": mc, "tng": tng}
            continue
        if name in FUEL_GROUPS:
            key, label, category = FUEL_GROUPS[name]
        else:
            # A new fuel group: keep it rather than failing, but say so.
            print(f"warning: unknown fuel group {cells[0]!r}", file=sys.stderr)
            key = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
            label, category = cells[0].capitalize(), "other"
        fuels.append({"key": key, "label": label, "category": category, "mc": mc, "tng": tng})

    if total is None:
        raise LayoutError("GENERATION table has no TOTAL row")
    if not any(f["category"] == "gas" for f in fuels) or not any(f["key"] == "wind" for f in fuels):
        raise LayoutError("GENERATION table lacks the expected gas and wind groups")
    summed = sum(f["tng"] for f in fuels)
    if abs(summed - total["tng"]) > TOLERANCE_MW:
        raise LayoutError(f"fuel TNG sums to {summed} but TOTAL says {total['tng']}")
    return fuels, total


def parse_interchange(page: str) -> tuple[list[dict], int]:
    rows = table_rows(page, "INTERCHANGE")
    paths, total = [], None
    for cells in rows:
        if len(cells) < 2:
            continue
        name = cells[0].upper()
        if name == "TOTAL":
            total = to_int(cells[1], "interchange TOTAL")
        elif name in INTERTIES:
            key, label = INTERTIES[name]
            paths.append({"key": key, "label": label, "flow": to_int(cells[1], name)})
    found = {p["key"] for p in paths}
    missing = [label for key, label in INTERTIES.values() if key not in found]
    if missing:
        raise LayoutError(f"INTERCHANGE table is missing: {', '.join(missing)}")
    if total is None:
        raise LayoutError("INTERCHANGE table has no TOTAL row")
    return paths, total


def parse(page: str) -> dict:
    updated = parse_timestamp(page)
    summary = parse_summary(page)
    fuels, gen_total = parse_generation(page)
    paths, ic_total = parse_interchange(page)

    tng, nai, ail = (summary[k] for k in REQUIRED_SUMMARY)
    if abs(gen_total["tng"] - tng) > TOLERANCE_MW:
        raise LayoutError(f"GENERATION TOTAL {gen_total['tng']} != SUMMARY TNG {tng}")
    if abs(ic_total - nai) > TOLERANCE_MW:
        raise LayoutError(f"INTERCHANGE TOTAL {ic_total} != SUMMARY interchange {nai}")
    # AESO convention: positive interchange = export, so AIL = TNG - NAI.
    if abs(tng - nai - ail) > TOLERANCE_MW:
        raise LayoutError(f"TNG {tng} - interchange {nai} != AIL {ail}")

    return {
        "source": CSD_URL,
        "updated": updated.isoformat(),
        "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "summary": summary,
        "generation": fuels,
        "generation_total": gen_total,
        "interchange": paths,
        "interchange_total": ic_total,
        "notes": "MW. Interchange flow > 0 means export from Alberta, < 0 import.",
    }


# --------------------------------------------------------------------------
# Output


def snapshot(latest: dict) -> dict:
    """The compact per-interval record kept in history.json."""
    return {
        "t": latest["updated"],
        "ail": latest["summary"]["internal_load"],
        "ni": latest["summary"]["net_actual_interchange"],
        "gen": {f["key"]: f["tng"] for f in latest["generation"]},
        "ic": {p["key"]: p["flow"] for p in latest["interchange"]},
    }


def update_history(path: str, latest: dict) -> dict:
    snaps: list[dict] = []
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh:
                snaps = json.load(fh).get("snapshots", [])
        except (json.JSONDecodeError, OSError) as exc:
            print(f"warning: ignoring unreadable {path}: {exc}", file=sys.stderr)

    new = snapshot(latest)
    by_time = {s["t"]: s for s in snaps}
    by_time[new["t"]] = new  # replaces a duplicate of the same AESO interval

    cutoff = datetime.fromisoformat(new["t"]) - timedelta(days=HISTORY_DAYS)
    kept = sorted(
        (s for s in by_time.values() if datetime.fromisoformat(s["t"]) >= cutoff),
        key=lambda s: datetime.fromisoformat(s["t"]),
    )
    return {"updated": new["t"], "snapshots": kept}


def write_json(path: str, data: dict, compact: bool = False) -> None:
    """Write atomically so a crash never leaves a half-written file."""
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
        if compact:
            json.dump(data, fh, separators=(",", ":"))
        else:
            json.dump(data, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="data", help="output directory (default: data)")
    ap.add_argument("--html", help="parse this saved HTML file instead of fetching")
    args = ap.parse_args()

    try:
        if args.html:
            with open(args.html, encoding="utf-8", errors="replace") as fh:
                page = fh.read()
        else:
            page = fetch()
        latest = parse(page)
    except LayoutError as exc:
        print(f"ERROR: CSD page layout not recognised: {exc}", file=sys.stderr)
        print("Nothing was written; existing data is unchanged.", file=sys.stderr)
        return 2
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        print("Nothing was written; existing data is unchanged.", file=sys.stderr)
        return 3

    os.makedirs(args.out, exist_ok=True)
    history = update_history(os.path.join(args.out, "history.json"), latest)
    write_json(os.path.join(args.out, "latest.json"), latest)
    write_json(os.path.join(args.out, "history.json"), history, compact=True)

    s = latest["summary"]
    print(
        f"{latest['updated']}: generation {s['total_net_generation']} MW, "
        f"interchange {s['net_actual_interchange']} MW, load {s['internal_load']} MW; "
        f"{len(history['snapshots'])} snapshots in history"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
