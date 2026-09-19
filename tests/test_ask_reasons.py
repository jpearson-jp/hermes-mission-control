#!/usr/bin/env python3
"""`_ask_reasons` — the ASK the owner reads must be the card's NEWEST PARK EVENT (t_68504b12).

The defect these arms close: `_ask_reasons` read the newest ``kind='blocked'`` event only, so a
card whose newest park was a ``block_retyped`` or a ``block_loop_detected`` rendered a SUPERSEDED
reason — and it failed silently. Measured live on 2026-09-19, board `tos`, card `t_72e36f3f`: the
page showed the owner the literal test string "short kinded reason" (19 chars, an `eng-worker`
test park) as THE ASK on a live production-secret decision, while the card's real park — 9 seconds
later, `block_loop_detected` — carried 858 chars starting "OWNER DECISION before shipping".

Run it with the dashboard's own interpreter (the module imports `hermes_cli`):

    /home/hermes/.hermes/hermes-agent/venv/bin/python -m unittest discover -s tests -v

The last arm runs against the LIVE `tos` board, read-only, and asserts the invariant the fix
establishes rather than a literal string (which would rot the moment the owner answers the card):
for every owner ask, the rendered ask EQUALS the newest park over all three kinds.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
API_PATH = REPO / "dashboard" / "plugin_api.py"
LIVE_DB = Path(os.environ.get("MC_LIVE_BOARD_DB",
                              "/home/hermes/.hermes/kanban/boards/tos/kanban.db"))

PARK_KINDS = ("blocked", "block_retyped", "block_loop_detected")


def load_api():
    """Import the plugin's route module from its file — the same way the dashboard does."""
    name = "mc_plugin_api_under_test"
    spec = importlib.util.spec_from_file_location(name, API_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


api = load_api()


def make_db(events):
    """An in-memory `task_events` shaped like the real table. events = (task_id, kind, reason)."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE task_events (id INTEGER PRIMARY KEY, task_id TEXT, kind TEXT, "
                 "payload TEXT, created_at INTEGER)")
    for i, (tid, kind, reason) in enumerate(events, 1):
        payload = json.dumps({"reason": reason}) if reason is not None else json.dumps({"other": 1})
        conn.execute("INSERT INTO task_events (id, task_id, kind, payload, created_at) "
                     "VALUES (?, ?, ?, ?, ?)", (i, tid, kind, payload, 1_700_000_000 + i))
    conn.commit()
    return conn


def blocked_only_reason(conn, tid):
    """The SUPERSEDED read this card removed — kept here as the negative control."""
    row = conn.execute("SELECT payload FROM task_events WHERE task_id=? AND kind='blocked' "
                       "ORDER BY id DESC LIMIT 1", (tid,)).fetchone()
    return api._reason_from_payload(row["payload"]) if row else None


class AskReasonsTest(unittest.TestCase):
    def test_live_defect_shape_loop_detected_wins(self):
        """The exact live shape: a test `blocked` park 9 s before the real `block_loop_detected`."""
        conn = make_db([
            ("t_x", "blocked", "short kinded reason"),
            ("t_x", "block_loop_detected", "OWNER DECISION before shipping - the real 858-char ask"),
        ])
        got = api._ask_reasons(conn, ["t_x"])
        self.assertEqual(got["t_x"], "OWNER DECISION before shipping - the real 858-char ask")
        # NEGATIVE CONTROL: the old read really did return the test string here, so this arm
        # cannot pass against the pre-fix code.
        self.assertEqual(blocked_only_reason(conn, "t_x"), "short kinded reason")

    def test_block_retyped_wins_over_the_pre_retype_blocked(self):
        """A re-type in place appends `block_retyped` carrying the caller's reason byte for byte."""
        conn = make_db([
            ("t_y", "blocked", "waiting on a peer's output"),
            ("t_y", "block_retyped", "retyped: the peer shipped, now waiting on the owner"),
        ])
        got = api._ask_reasons(conn, ["t_y"])
        self.assertEqual(got["t_y"], "retyped: the peer shipped, now waiting on the owner")
        self.assertEqual(blocked_only_reason(conn, "t_y"), "waiting on a peer's output")

    def test_control_newest_park_is_a_blocked_event_is_unchanged(self):
        """CONTROL: the cards that already agreed must not move (106 of them on the live board)."""
        conn = make_db([
            ("t_c", "blocked", "only park on the card"),
        ])
        self.assertEqual(api._ask_reasons(conn, ["t_c"]), {"t_c": "only park on the card"})
        # and a card whose newest `blocked` follows older ones still reads the newest
        conn2 = make_db([
            ("t_c2", "blocked", "old"),
            ("t_c2", "blocked", "new"),
        ])
        self.assertEqual(api._ask_reasons(conn2, ["t_c2"]), {"t_c2": "new"})

    def test_a_card_parked_only_by_a_retype_still_has_an_ask(self):
        """The old reader returned NOTHING for this card: no `blocked` event exists at all."""
        conn = make_db([("t_z", "block_retyped", "parked by the unblock-loop breaker")])
        self.assertEqual(api._ask_reasons(conn, ["t_z"]),
                         {"t_z": "parked by the unblock-loop breaker"})
        self.assertIsNone(blocked_only_reason(conn, "t_z"))

    def test_the_two_consumers_cannot_disagree(self):
        """`_ask_reasons` and the exclusion predicates read the SAME payload, per task.

        This is the structural arm: the page decides WHETHER to show a card from `_park_payloads`
        and renders it from `_ask_reasons`. If those two ever read different events, the page can
        show a card for one reason and quote another.
        """
        conn = make_db([
            ("t_a", "blocked", "old"),
            ("t_a", "block_loop_detected", "newest park"),
            ("t_b", "blocked", "untouched"),
            ("t_c", "block_retyped", "retype only"),
            ("t_d", "blocked", None),  # payload with no readable reason
        ])
        ids = ["t_a", "t_b", "t_c", "t_d"]
        payloads = api._park_payloads(conn, ids)
        reasons = api._ask_reasons(conn, ids)
        for tid in ids:
            expected = api._reason_from_payload(payloads.get(tid))
            if expected:
                self.assertEqual(reasons.get(tid), expected, tid)
            else:
                self.assertNotIn(tid, reasons, tid)
        self.assertNotIn("t_d", reasons)  # absent, never a superseded fallback

    def test_precomputed_payloads_are_used_so_the_read_is_shared(self):
        """The call site passes the payloads it already read: one query, two consumers."""
        conn = make_db([])  # an EMPTY connection: a second read would find nothing
        supplied = {"t_p": json.dumps({"reason": "from the shared read"})}
        self.assertEqual(api._ask_reasons(conn, ["t_p"], payloads=supplied),
                         {"t_p": "from the shared read"})

    def test_the_kind_list_is_the_scripts_stores(self):
        """One definition of the park kinds, imported — not a copy of the literal."""
        kinds = api._park_kinds()
        for k in PARK_KINDS:
            self.assertIn(k, kinds)
        try:
            sys.path.insert(0, "/home/hermes/.hermes/scripts/lib")
            import owner_ask_filter  # noqa: PLC0415
        except Exception as exc:  # the module is absent in some checkouts; the fallback covers it
            self.skipTest("owner_ask_filter not importable here (%s); fallback triple asserted"
                          % type(exc).__name__)
        self.assertEqual(tuple(kinds), tuple(owner_ask_filter.PARK_EVENT_KINDS))


@unittest.skipUnless(LIVE_DB.exists(), "live board db not present")
class LiveBoardTest(unittest.TestCase):
    """READ-ONLY against the live board — the acceptance this card was filed on."""

    def _owner_asks(self, conn):
        return [r["id"] for r in conn.execute(
            "SELECT id FROM tasks WHERE block_kind='needs_input' "
            "AND status IN ('blocked','triage')")]

    def test_every_owner_ask_renders_its_newest_park(self):
        conn = sqlite3.connect("file:%s?mode=ro" % LIVE_DB, uri=True)
        conn.row_factory = sqlite3.Row
        ids = self._owner_asks(conn)
        self.assertGreater(len(ids), 0, "no owner asks read — the board read is not a positive one")

        reasons = api._ask_reasons(conn, ids)
        kinds = ",".join("?" * len(PARK_KINDS))
        mismatched = []
        for tid in ids:
            row = conn.execute(
                "SELECT payload FROM task_events WHERE task_id=? AND kind IN (%s) "
                "ORDER BY id DESC LIMIT 1" % kinds, (tid,) + PARK_KINDS).fetchone()
            expected = api._reason_from_payload(row["payload"]) if row else None
            if expected != reasons.get(tid):
                mismatched.append((tid, (expected or "")[:40], (reasons.get(tid) or "")[:40]))
        conn.close()
        self.assertEqual(mismatched, [], "rendered ask != newest park event: %r" % (mismatched[:5],))

    def test_t_72e36f3f_reads_the_real_owner_decision(self):
        """The card this defect was filed on: it must NOT render the leftover test park."""
        conn = sqlite3.connect("file:%s?mode=ro" % LIVE_DB, uri=True)
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT status, block_kind FROM tasks WHERE id='t_72e36f3f'").fetchone()
        if row is None or row["block_kind"] != "needs_input" or row["status"] not in (
                "blocked", "triage"):
            conn.close()
            self.skipTest("t_72e36f3f is no longer an owner ask — the shape arm above still holds")
        got = api._ask_reasons(conn, ["t_72e36f3f"]).get("t_72e36f3f") or ""
        conn.close()
        print("\n  live t_72e36f3f ask: %d chars, starts %r" % (len(got), got[:60]))
        self.assertNotEqual(got.strip(), "short kinded reason")
        self.assertTrue(got.startswith("OWNER DECISION before shipping"), got[:80])


if __name__ == "__main__":
    unittest.main(verbosity=2)
