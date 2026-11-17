"""Tests for scripts/scrape.py against a saved copy of the real CSD page.

Run: python -m unittest discover -s tests
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import scrape  # noqa: E402

FIXTURE = os.path.join(HERE, "fixtures", "csd-2026-11-17.html")


def load_fixture() -> str:
    with open(FIXTURE, encoding="utf-8", errors="replace") as fh:
        return fh.read()


class ParseRealPage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = scrape.parse(load_fixture())

    def test_timestamp_is_edmonton_local(self):
        self.assertEqual(self.data["updated"], "2026-11-17T14:03:00-06:00")  # Alberta is UTC-6 year-round from 2026

    def test_summary(self):
        s = self.data["summary"]
        self.assertEqual(s["total_net_generation"], 11392)
        self.assertEqual(s["net_actual_interchange"], 236)
        self.assertEqual(s["internal_load"], 11156)

    def test_generation_by_fuel(self):
        gen = {f["key"]: f for f in self.data["generation"]}
        self.assertEqual(gen["cogeneration"]["tng"], 5210)
        self.assertEqual(gen["combined_cycle"]["mc"], 3974)
        self.assertEqual(gen["gas_fired_steam"]["tng"], 842)
        self.assertEqual(gen["simple_cycle"]["tng"], 244)
        self.assertEqual(gen["wind"]["tng"], 1333)
        self.assertEqual(gen["energy_storage"]["tng"], 0)
        self.assertEqual(gen["cogeneration"]["category"], "gas")
        self.assertEqual(self.data["generation_total"], {"mc": 23418, "tng": 11392})

    def test_interchange(self):
        ic = {p["key"]: p["flow"] for p in self.data["interchange"]}
        self.assertEqual(ic, {"bc": 388, "montana": -2, "saskatchewan": -150})
        self.assertEqual(self.data["interchange_total"], 236)


class RejectBadLayouts(unittest.TestCase):
    def setUp(self):
        self.page = load_fixture()

    def assertRejected(self, page, fragment):
        with self.assertRaises(scrape.LayoutError) as ctx:
            scrape.parse(page)
        self.assertIn(fragment, str(ctx.exception))

    def test_missing_generation_table(self):
        self.assertRejected(self.page.replace("<B>GENERATION</B>", "<B>GEN</B>"), "GENERATION")

    def test_missing_timestamp(self):
        self.assertRejected(self.page.replace("Last Update", "Updated"), "Last Update")

    def test_totals_do_not_add_up(self):
        bad = self.page.replace("<TD>WIND</TD><TD>5684</TD><TD>1333</TD>",
                                "<TD>WIND</TD><TD>5684</TD><TD>9999</TD>")
        self.assertRejected(bad, "sums to")

    def test_non_numeric_value(self):
        bad = self.page.replace("<TD>Montana</TD><TD>-2</TD>", "<TD>Montana</TD><TD>n/a</TD>")
        self.assertRejected(bad, "whole number")

    def test_empty_page(self):
        self.assertRejected("<html><body>Service unavailable</body></html>", "Last Update")

    def test_tables_found_by_heading_not_position(self):
        # Swap the order of the SUMMARY and INTERCHANGE headings' tables: still parses.
        start = self.page.index("<TD VALIGN=\"TOP\" WIDTH=\"30%\">")
        data = scrape.parse(self.page[:start] + "<TABLE></TABLE>" + self.page[start:])
        self.assertEqual(data["summary"]["internal_load"], 11156)


class History(unittest.TestCase):
    def test_dedupes_and_prunes(self):
        latest = scrape.parse(load_fixture())
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "history.json")
            old = {"t": "2026-11-09T14:00:00-06:00", "ail": 1, "ni": 0, "gen": {}}
            recent = {"t": "2026-11-17T13:58:00-06:00", "ail": 2, "ni": 0, "gen": {}}
            same = {"t": latest["updated"], "ail": 3, "ni": 0, "gen": {}}
            with open(path, "w") as fh:
                json.dump({"snapshots": [old, recent, same]}, fh)
            hist = scrape.update_history(path, latest)
            times = [s["t"] for s in hist["snapshots"]]
            self.assertEqual(times, [recent["t"], latest["updated"]])
            self.assertEqual(hist["snapshots"][-1]["ail"], 11156)


class CommandLine(unittest.TestCase):
    def run_cli(self, html_path, out):
        return subprocess.run(
            [sys.executable, os.path.join(ROOT, "scripts", "scrape.py"), "--html", html_path, "--out", out],
            capture_output=True, text=True,
        )

    def test_writes_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self.run_cli(FIXTURE, tmp)
            self.assertEqual(result.returncode, 0, result.stderr)
            with open(os.path.join(tmp, "latest.json")) as fh:
                self.assertEqual(json.load(fh)["summary"]["internal_load"], 11156)
            with open(os.path.join(tmp, "history.json")) as fh:
                self.assertEqual(len(json.load(fh)["snapshots"]), 1)

    def test_bad_page_exits_nonzero_and_keeps_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            good = os.path.join(tmp, "latest.json")
            with open(good, "w") as fh:
                fh.write('{"keep": true}')
            bad = os.path.join(tmp, "bad.html")
            with open(bad, "w") as fh:
                fh.write("<html>maintenance</html>")
            result = self.run_cli(bad, tmp)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("layout not recognised", result.stderr)
            with open(good) as fh:
                self.assertEqual(fh.read(), '{"keep": true}')
            self.assertFalse(os.path.exists(os.path.join(tmp, "history.json")))


if __name__ == "__main__":
    unittest.main()
