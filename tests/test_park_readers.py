#!/usr/bin/env python3
"""The PARK-READER CLASS — the `/since` parked list and the `/insights` stuck age + park
histogram (kanban t_3d9a7034).

The defect these arms close: three readers on the Mission Control page were keyed on
``kind='blocked'`` alone. A card's park is recorded by one of THREE kinds — ``blocked``,
``block_retyped`` (a re-type in place) and ``block_loop_detected`` (the unblock-loop
breaker) — so all three readers read a SUPERSEDED park whenever the newest one was a
re-type or a loop-break:

  * ``/since``'s "newly parked on the owner" list silently DROPPED the card (its only
    ``blocked`` event predated the window);
  * ``/insights``' stuck ``age_seconds`` was measured from the superseded park — or, for a
    card with no ``blocked`` event at all, from the row's ``created_at``, which is the
    FILING date and not an age of anything (measured on the tos snapshot, clock
    1790208969: 738 of 1 397 stuck cards had no ``blocked`` event, 726 of them with a real
    park over the triple);
  * the ``/insights`` park histogram counted ``blocked`` events only — 11 098 of 13 787
    parks in the 168 h window (20 % of them) were invisible.

The predicates are asserted by OUTCOME (the reader returns the card / the count / the
age), never by SQL text. Every arm that matters carries the OLD predicate as a NEGATIVE
CONTROL, so no arm can pass against the pre-fix code.

Run it with the dashboard's own interpreter (the module imports `hermes_cli`):

    /home/hermes/.hermes/hermes-agent/venv/bin/python -m unittest discover -s tests -v

The last class runs against the LIVE ``tos`` board, read-only: it asserts the INVARIANT
each reader now holds (the value the reader shows EQUALS the newest park over the triple)
rather than a literal card id or count, which would rot the moment the board moves.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
API_PATH = REPO / "dashboard" / "plugin_api.py"
LIVE_DB = Path(os.environ.get("MC_LIVE_BOARD_DB",
                              "/home/hermes/.hermes/kanban/boards/tos/kanban.db"))

PARK_KINDS = ("blocked", "block_retyped", "block_loop_detected")
NOW = int(time.time())

SCHEMA = """
CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT, assignee TEXT, status TEXT, block_kind TEXT,
    created_at INTEGER, completed_at INTEGER, priority INTEGER, project_id TEXT,
    consecutive_failures INTEGER, last_failure_error TEXT, created_by TEXT, labels TEXT,
    current_run_id INTEGER, started_at INTEGER, workspace_kind TEXT, workspace_path TEXT,
    branch_name TEXT, result TEXT, last_heartbeat_at INTEGER);
CREATE TABLE task_events (id INTEGER PRIMARY KEY, task_id TEXT, kind TEXT, payload TEXT,
                          created_at INTEGER, run_id INTEGER);
CREATE TABLE task_comments (id INTEGER PRIMARY KEY, task_id TEXT, author TEXT, body TEXT,
                            created_at INTEGER);
CREATE TABLE task_runs (id INTEGER PRIMARY KEY, task_id TEXT, profile TEXT, status TEXT,
                        outcome TEXT, started_at INTEGER, ended_at INTEGER, summary TEXT,
                        error TEXT);
"""


def load_api():
    """Import the plugin's route module from its file — the same way the dashboard does."""
    name = "mc_park_readers_under_test"
    spec = importlib.util.spec_from_file_location(name, API_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


api = load_api()


class Board:
    """A synthetic one-board environment the REAL route functions can be driven against."""

    def __init__(self, cards, events):
        self.dir = tempfile.TemporaryDirectory(prefix="mc-park-readers-")
        self.path = os.path.join(self.dir.name, "kanban.db")
        conn = sqlite3.connect(self.path)
        conn.executescript(SCHEMA)
        for card in cards:
            cols = ", ".join(card)
            marks = ", ".join("?" * len(card))
            conn.execute("INSERT INTO tasks (%s) VALUES (%s)" % (cols, marks), tuple(card.values()))
        for ev in events:
            conn.execute("INSERT INTO task_events (task_id, kind, payload, created_at) "
                         "VALUES (?, ?, ?, ?)",
                         (ev["task_id"], ev["kind"],
                          json.dumps(ev["payload"]) if ev.get("payload") is not None else None,
                          ev["created_at"]))
        conn.commit()
        conn.close()
        self._saved = api._boards
        api._boards = lambda: [{"slug": "t_synth", "title": "synthetic", "path": self.path}]

    def close(self):
        api._boards = self._saved
        self.dir.cleanup()

    def conn(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn


def blocked_only_parked(conn, ts):
    """The SUPERSEDED read the `/since` panel used — kept as the negative control."""
    return sorted(r["id"] for r in conn.execute(
        "SELECT DISTINCT t.id FROM tasks t JOIN task_events e ON e.task_id = t.id "
        "WHERE e.kind = 'blocked' AND e.created_at >= ? "
        "AND t.status IN ('blocked','triage') AND t.block_kind = 'needs_input'", (ts,)))


def blocked_only_age(conn, tid):
    """The SUPERSEDED age the `/insights` stuck list showed — negative control."""
    row = conn.execute(
        "SELECT COALESCE((SELECT MAX(e.created_at) FROM task_events e "
        "                 WHERE e.task_id = t.id AND e.kind = 'blocked'), t.created_at) AS since "
        "  FROM tasks t WHERE t.id = ?", (tid,)).fetchone()
    return NOW - (row["since"] or NOW)


def blocked_only_park_events(conn, lo):
    """The SUPERSEDED park histogram — negative control."""
    return conn.execute("SELECT COUNT(*) c FROM task_events WHERE kind='blocked' "
                        "AND created_at >= ?", (lo,)).fetchone()["c"]


def fixture():
    """One board holding the two shapes the old readers missed, plus controls.

    t_retype  parked `capability` 5 d ago, then RE-TYPED into `needs_input` 10 min ago.
              Its only `blocked` event is 5 d old, so a `blocked`-only window read loses it
              and a `blocked`-only age read measures the park it left.
    t_loop    parked `needs_input` 3 d ago, then LOOP-BROKEN 5 min ago.
    t_loop_nk the same, with the live shape of a loop-breaker payload — `reason` only, NO
              `kind` field (measured on the tos board) — so the arm also pins that the
              readers take the park KIND from the row, not from the payload.
    t_ctl     parked `needs_input` once, 4 d ago: the cards that already agreed.
    """
    cards = [
        {"id": "t_retype", "title": "re-typed into the owner's queue", "assignee": "eng-worker",
         "status": "blocked", "block_kind": "needs_input", "created_at": NOW - 5 * 86400,
         "priority": 0, "consecutive_failures": 0},
        {"id": "t_loop", "title": "loop-broken into the owner's queue", "assignee": "eng-worker",
         "status": "blocked", "block_kind": "needs_input", "created_at": NOW - 3 * 86400,
         "priority": 0, "consecutive_failures": 0},
        {"id": "t_loop_nk", "title": "loop-broken, payload carries no kind", "assignee": "eng-worker",
         "status": "blocked", "block_kind": "needs_input", "created_at": NOW - 3 * 86400,
         "priority": 0, "consecutive_failures": 0},
        {"id": "t_ctl", "title": "parked once, long ago", "assignee": "eng-worker",
         "status": "blocked", "block_kind": "needs_input", "created_at": NOW - 4 * 86400,
         "priority": 0, "consecutive_failures": 0},
    ]
    events = [
        {"task_id": "t_retype", "kind": "blocked", "created_at": NOW - 5 * 86400,
         "payload": {"kind": "capability", "reason": "waiting on a peer's output"}},
        {"task_id": "t_retype", "kind": "block_retyped", "created_at": NOW - 600,
         "payload": {"from": "capability", "to": "needs_input",
                     "reason": "the peer shipped; this is now the owner's call"}},
        {"task_id": "t_loop", "kind": "blocked", "created_at": NOW - 3 * 86400,
         "payload": {"kind": "needs_input", "reason": "old ask"}},
        {"task_id": "t_loop", "kind": "block_loop_detected", "created_at": NOW - 300,
         "payload": {"kind": "needs_input", "reason": "OWNER DECISION before shipping"}},
        {"task_id": "t_loop_nk", "kind": "block_loop_detected", "created_at": NOW - 300,
         "payload": {"reason": "parked by the unblock-loop breaker"}},
        {"task_id": "t_ctl", "kind": "blocked", "created_at": NOW - 4 * 86400,
         "payload": {"kind": "needs_input", "reason": "the only park on the card"}},
    ]
    return Board(cards, events)


class SinceParkedTest(unittest.TestCase):
    """`/since` — "newly parked on the owner" must read the park triple."""

    def setUp(self):
        self.board = fixture()

    def tearDown(self):
        self.board.close()

    def test_a_card_retyped_into_the_queue_is_listed(self):
        got = api.since(ts=NOW - 3600)["parked"]
        ids = {r["id"] for r in got}
        self.assertIn("t_retype", ids,
                      "a card re-typed into needs_input 10 min ago is newly parked on the owner")
        self.assertIn("t_loop", ids, "a loop-broken park is a park")
        self.assertIn("t_loop_nk", ids,
                      "the live loop-breaker payload carries no `kind`; the row does")
        # NEGATIVE CONTROL: the old predicate loses all three, because none of them has a
        # `blocked` event inside the window.
        conn = self.board.conn()
        self.assertEqual(blocked_only_parked(conn, NOW - 3600), [])
        conn.close()

    def test_the_window_still_governs_which_cards_are_newly_parked(self):
        """CONTROL: the arm above is not passing because the window was ignored."""
        ids = {r["id"] for r in api.since(ts=NOW - 3600)["parked"]}
        self.assertNotIn("t_ctl", ids, "a card parked 4 d ago is not newly parked")

    def test_a_wider_window_lists_the_old_parks_too(self):
        ids = {r["id"] for r in api.since(ts=NOW - 6 * 86400)["parked"]}
        self.assertEqual(ids, {"t_retype", "t_loop", "t_loop_nk", "t_ctl"})

    def test_the_listed_time_is_the_newest_park_not_the_newest_blocked(self):
        """`at` is an ISO string; parse it, so the arm asserts the INSTANT, not its format."""
        from datetime import datetime
        got = {r["id"]: datetime.fromisoformat(r["at"]).timestamp()
               for r in api.since(ts=NOW - 3600)["parked"]}
        self.assertLess(abs(got["t_retype"] - (NOW - 600)), 60,
                        "t_retype's park is the 10-min-old RE-TYPE, not the 5-d-old blocked")
        self.assertLess(abs(got["t_loop"] - (NOW - 300)), 60)


class InsightsStuckAgeTest(unittest.TestCase):
    """`/insights` stuck list — the age is measured from the NEWEST park."""

    def setUp(self):
        self.board = fixture()

    def tearDown(self):
        self.board.close()

    def test_age_is_measured_from_the_newest_park(self):
        rows = {r["id"]: r["age_seconds"] for r in api.insights(hours=168)["stuck"]["oldest"]}
        self.assertIn("t_retype", rows)
        self.assertLess(rows["t_retype"], 3600,
                        "the age is the 10-min-old re-type, not the 5-d-old park it left")
        self.assertLess(rows["t_loop"], 3600, "the age is the 5-min-old loop-break")
        # NEGATIVE CONTROL: the old read showed the superseded park (or the filing date).
        conn = self.board.conn()
        self.assertGreater(blocked_only_age(conn, "t_retype"), 4 * 86400)
        self.assertGreater(blocked_only_age(conn, "t_loop"), 2 * 86400)
        conn.close()

    def test_a_card_with_no_blocked_event_is_not_dated_from_its_filing(self):
        """t_loop_nk has NO `blocked` event: the old read fell back to `t.created_at`."""
        rows = {r["id"]: r["age_seconds"] for r in api.insights(hours=168)["stuck"]["oldest"]}
        self.assertIn("t_loop_nk", rows)
        self.assertLess(rows["t_loop_nk"], 3600)
        conn = self.board.conn()
        self.assertGreater(blocked_only_age(conn, "t_loop_nk"), 2 * 86400)
        conn.close()

    def test_the_control_card_keeps_its_age(self):
        """CONTROL: a card whose newest park IS its `blocked` event must not move."""
        rows = {r["id"]: r["age_seconds"] for r in api.insights(hours=168)["stuck"]["oldest"]}
        self.assertAlmostEqual(rows["t_ctl"], 4 * 86400, delta=120)


class InsightsHistogramTest(unittest.TestCase):
    """`/insights` park histogram — it counts PARKS, not `blocked` events."""

    def setUp(self):
        self.board = fixture()

    def tearDown(self):
        self.board.close()

    def test_every_park_event_is_counted(self):
        ins = api.insights(hours=168)
        got = sum(p["blocked"] for p in ins["throughput"])
        # 6 park events in the window: 3 `blocked` + 1 `block_retyped` + 2 `block_loop_detected`
        self.assertEqual(got, 6)
        # NEGATIVE CONTROL: the old histogram counted 3 — 22 % of the parks were invisible
        # on the live board, and half of them here.
        conn = self.board.conn()
        self.assertEqual(blocked_only_park_events(conn, NOW - 168 * 3600), 3)
        conn.close()


class ParkReaderShapeTest(unittest.TestCase):
    """The shape the three readers share: one park triple, read through one helper."""

    def setUp(self):
        self.board = fixture()

    def tearDown(self):
        self.board.close()

    def test_the_newest_park_is_the_events_table_s_own_order(self):
        conn = self.board.conn()
        newest = api._newest_park_events(conn, ["t_retype", "t_loop", "t_loop_nk", "t_ctl"])
        conn.close()
        self.assertEqual(newest["t_retype"]["kind"], "block_retyped")
        self.assertEqual(newest["t_loop"]["kind"], "block_loop_detected")
        self.assertEqual(newest["t_ctl"]["kind"], "blocked")

    def test_the_park_kind_lives_in_the_json_field_not_in_a_substring(self):
        """`payload.to` for a re-type, `payload.kind` for the other two — never prose."""
        conn = self.board.conn()
        newest = api._newest_park_events(conn, ["t_retype", "t_loop", "t_loop_nk"])
        conn.close()
        retyped = api._flow_payload_fields(newest["t_retype"]["payload"])
        self.assertEqual(retyped.get("to"), "needs_input")
        self.assertIsNone(retyped.get("kind"),
                          "a `kind`-only read of a re-type finds nothing — that is the defect")
        looped = api._flow_payload_fields(newest["t_loop"]["payload"])
        self.assertEqual(looped.get("kind"), "needs_input")

    def test_the_loop_breaker_s_live_payload_has_no_kind_and_still_reads(self):
        """MEASURED on the tos board: `block_loop_detected` carries `reason` only."""
        conn = self.board.conn()
        newest = api._newest_park_events(conn, ["t_loop_nk"])
        conn.close()
        fields = api._flow_payload_fields(newest["t_loop_nk"]["payload"])
        self.assertIsNone(fields.get("kind"))
        self.assertIn("reason", fields)
        # the readers above still found the card: they take the park KIND from the row
        self.assertIn("t_loop_nk", {r["id"] for r in api.since(ts=NOW - 3600)["parked"]})

    def test_the_payload_read_is_a_projection_of_the_same_newest_park(self):
        """`_park_payloads` (the exclusion predicates) cannot disagree with the new read."""
        conn = self.board.conn()
        ids = ["t_retype", "t_loop", "t_loop_nk", "t_ctl"]
        payloads = api._park_payloads(conn, ids)
        newest = api._newest_park_events(conn, ids)
        conn.close()
        self.assertEqual(payloads, {tid: ev["payload"] for tid, ev in newest.items()})

    def test_the_sql_kind_list_is_the_one_definition(self):
        kinds = api._park_kinds()
        for k in PARK_KINDS:
            self.assertIn(k, kinds)
        sql = api._park_kind_sql()
        for k in kinds:
            self.assertIn("'%s'" % k, sql)
        try:
            sys.path.insert(0, "/home/hermes/.hermes/scripts/lib")
            import owner_ask_filter  # noqa: PLC0415
        except Exception as exc:  # the module is absent in some checkouts; the fallback covers it
            self.skipTest("owner_ask_filter not importable here (%s); fallback triple asserted"
                          % type(exc).__name__)
        self.assertEqual(tuple(kinds), tuple(owner_ask_filter.PARK_EVENT_KINDS))


@unittest.skipUnless(LIVE_DB.exists(), "live board db not present")
class LiveBoardTest(unittest.TestCase):
    """READ-ONLY against the live board — the invariant, not a frozen count.

    The routes read EVERY board, so the arms pin `_boards()` to this one board: the card ids
    a route returns must then be checkable against the very DB it read them from. The board
    itself is untouched (every connection is `mode=ro`).
    """

    def setUp(self):
        self._saved = api._boards
        api._boards = lambda: [{"slug": "tos", "title": "tos (live)",
                                "path": str(LIVE_DB)}]

    def tearDown(self):
        api._boards = self._saved

    def _ro(self):
        conn = sqlite3.connect("file:%s?mode=ro" % LIVE_DB, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    def _newest_park_ts(self, conn, tid):
        row = conn.execute(
            "SELECT created_at FROM task_events WHERE task_id=? AND kind IN (%s) "
            "ORDER BY id DESC LIMIT 1" % ",".join("?" * len(PARK_KINDS)),
            (tid,) + PARK_KINDS).fetchone()
        return row["created_at"] if row else None

    def test_every_listed_card_is_listed_for_its_newest_park(self):
        from datetime import datetime
        conn = self._ro()
        listed = api.since(ts=0)["parked"]
        self.assertGreater(len(listed), 0, "no parked cards read — not a positive read")
        wrong = []
        for row in listed:
            newest = self._newest_park_ts(conn, row["id"])
            shown = int(datetime.fromisoformat(row["at"]).timestamp())
            if newest is None or shown != newest:
                wrong.append((row["id"], shown, newest))
        conn.close()
        self.assertEqual(wrong, [], "listed for a superseded park: %r" % (wrong[:5],))

    def test_the_stuck_age_is_the_newest_park(self):
        conn = self._ro()
        oldest = api.insights(hours=168)["stuck"]["oldest"]
        self.assertGreater(len(oldest), 0, "no stuck cards read — not a positive read")
        wrong = []
        for row in oldest:
            newest = self._newest_park_ts(conn, row["id"])
            if newest is None:
                filed = conn.execute("SELECT created_at FROM tasks WHERE id=?",
                                     (row["id"],)).fetchone()["created_at"]
                newest = filed
            if abs(row["age_seconds"] - (NOW - newest)) > 300:
                wrong.append((row["id"], row["age_seconds"], NOW - newest))
        conn.close()
        self.assertEqual(wrong, [], "age not measured from the newest park: %r" % (wrong[:5],))

    def test_the_board_still_has_cards_the_old_read_would_have_missed(self):
        """POSITIVE CONTROL for the two arms above: this defect is not theoretical here."""
        conn = self._ro()
        rows = conn.execute(
            "SELECT t.id, "
            " (SELECT MAX(e.created_at) FROM task_events e WHERE e.task_id=t.id AND e.kind='blocked') b, "
            " (SELECT e.created_at FROM task_events e WHERE e.task_id=t.id AND e.kind IN (%s) "
            "  ORDER BY e.id DESC LIMIT 1) p "
            " FROM tasks t WHERE t.status IN ('blocked','triage')" % ",".join("?" * len(PARK_KINDS)),
            PARK_KINDS).fetchall()
        conn.close()
        missed = [r["id"] for r in rows if r["p"] and (r["b"] is None or r["p"] > r["b"])]
        if not missed:
            self.skipTest("the live board currently has no card whose newest park is a "
                          "re-type or a loop-break; the invariant arms above still hold")
        print("\n  live: %d of %d stuck cards are parked newer than their newest `blocked` "
              "(e.g. %s)" % (len(missed), len(rows), ", ".join(missed[:3])))


if __name__ == "__main__":
    unittest.main(verbosity=2)
