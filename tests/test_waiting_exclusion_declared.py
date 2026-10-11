#!/usr/bin/env python3
"""The /waiting "already answered" exclusion asks the DECLARED-answer predicate (kanban t_8b100717).

THE DEFECT THESE ARMS CLOSE. `GET /waiting` dropped a park from the owner's inbox as "already
answered" on `lib/owner_ask_filter.ruling_evidence` -- the ASK QUEUE's question ("has a ruling
been RECORDED?"), which is deliberately WIDE: a lane RELAYING the owner's words counts, and an
owner-handle comment counts whatever its provenance. The page's own question is narrower -- "may I
stop SHOWING him this ask?" -- and on the cards where the two disagree the ask VANISHED from the
only surface that can answer it, while `protected-write-unblock-guard` (which asks
`lib/owner_answer.is_declared_owner_answer`) refused to lift the park. The excluded row's only
affordance is "open card", and `CardDetail` has no answer control -- the answer form lives on the
inbox row alone.

MEASURED live 2026-09-29, every board, every `block_kind='needs_input'` park in
`status IN ('blocked','triage')` (40 cards): `ruling_evidence` dropped 9 as "already answered" and
THREE carried no declared answer and no selection record -- `hermes-smith/t_adeae457` (a lane's own
measurement note, marker `answered from Mission Control`), `protection-suite/t_f86079f3` (marker
`owner decision recorded`) and `protection-suite/t_c22d1d65` (a lane's REFUSAL note, which QUOTES
the forged declaration). The first of those is the card that REPORTS this defect.

WHAT IS ASSERTED, AND HOW IT CAN GO RED. The fixture carries one card per shape, and the arms read
the REAL `_awaiting_for_board` -- not the predicate -- so a page that stopped calling the narrow
predicate goes red here. BOTH halves of the pair are nameable, so the arms can be run against the
PRE-CHANGE page and the PRE-CHANGE store together -- the only combination that shows the DEFECT:

    # green: this page, against the store that carries `declared_ruling_evidence`
    MC_LIB_DIR=/mnt/ohscratch/git/hermes-self/.worktrees/<card>/lib \
      /home/hermes/.hermes/hermes-agent/venv/bin/python -m unittest \
      tests.test_waiting_exclusion_declared -v

    # RED (the defect): the pre-change page AND the pre-change store. Fails with
    #   "Items in the first set but not the second: 't_lane_marker', 't_owner_no_provenance'"
    MC_API_PATH=<pre-change plugin_api.py> MC_LIB_DIR=<pre-change scripts/lib> \
      /home/hermes/.hermes/hermes-agent/venv/bin/python -m unittest \
      tests.test_waiting_exclusion_declared

⛔ THE PAIR IS THE POINT: the fixed PAGE against a STALE store shows too much (the declared card
reappears) rather than too little -- `_already_answered`'s declared degradation -- so a RED run
needs both halves pre-change.
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
# ⛔ BOTH HALVES OF THE PAIR ARE NAMEABLE, so the arms can be run against the PRE-CHANGE page and
# the PRE-CHANGE store together -- that is the only combination that shows the DEFECT rather than
# the degradation. `MC_API_PATH` defaults to this repo's page, `MC_LIB_DIR` to the live store.
API_PATH = Path(os.environ.get("MC_API_PATH", REPO / "dashboard" / "plugin_api.py"))
LIVE_LIB = Path(os.environ.get("MC_LIB_DIR", "/home/hermes/.hermes/scripts/lib"))
NOW = int(time.time())

SCHEMA = """
CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT, assignee TEXT, status TEXT, block_kind TEXT,
    created_at INTEGER, completed_at INTEGER, priority INTEGER, project_id TEXT,
    consecutive_failures INTEGER, last_failure_error TEXT, created_by TEXT, labels TEXT,
    current_run_id INTEGER, started_at INTEGER, workspace_kind INTEGER, workspace_path TEXT,
    branch_name TEXT, result TEXT, last_heartbeat_at INTEGER);
CREATE TABLE task_events (id INTEGER PRIMARY KEY, task_id TEXT, kind TEXT, payload TEXT,
                          created_at INTEGER, run_id INTEGER);
CREATE TABLE task_comments (id INTEGER PRIMARY KEY, task_id TEXT, author TEXT, body TEXT,
                            created_at INTEGER);
CREATE TABLE task_runs (id INTEGER PRIMARY KEY, task_id TEXT, profile TEXT, status TEXT,
                        outcome TEXT, started_at INTEGER, ended_at INTEGER, summary TEXT,
                        error TEXT);
"""

# ── THE FIXTURE HOME ────────────────────────────────────────────────────────────────────────────
# ⛔ THE LIB UNDER TEST IS NAMED, NOT INHERITED. `_ask_filter` resolves `owner_ask_filter` from
# `<HERMES_HOME>/scripts/lib` first, so pointing HERMES_HOME at a throwaway home whose `scripts/lib`
# is `MC_LIB_DIR` makes the arms independent of whatever the live store holds -- which is what lets
# the same file go red against the pre-change lib and green against the fixed one.
_TMP_HOME = tempfile.mkdtemp(prefix="mc-declared-lib-")
os.makedirs(os.path.join(_TMP_HOME, "scripts"), exist_ok=True)
_LIB_LINK = os.path.join(_TMP_HOME, "scripts", "lib")
if not os.path.exists(_LIB_LINK):
    os.symlink(str(LIVE_LIB), _LIB_LINK)
os.environ["HERMES_HOME"] = _TMP_HOME


def load_api():
    """Import the plugin's route module from its file -- the same way the dashboard does."""
    name = "mc_waiting_exclusion_under_test"
    spec = importlib.util.spec_from_file_location(name, API_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# ⛔ AND THE MODULE CACHE IS CLEARED FIRST: another test module in this package may already have
# imported `owner_ask_filter` from the LIVE store, and `import owner_ask_filter` would hand this
# one that object whatever `MC_LIB_DIR` says.
sys.modules.pop("owner_ask_filter", None)
api = load_api()
api._ASK_FILTER = None          # re-resolve against the fixture home


def lib():
    """The store module the PAGE resolved -- asserted, never assumed."""
    mod = api._ask_filter()
    assert mod is not None, "the page could not import owner_ask_filter at all"
    return mod


# ── THE LIVE SHAPES ────────────────────────────────────────────────────────────────────────────
# Each body is the live BYTES of the shape it names, so no arm can pass against a fixture no writer
# produces. MEASURED on the card the census names for each.
LANE_MARKER = ("hermes-smith",
               "## OWNER DECIDED — 2026-09-29, relayed verbatim by `hermes-smith`\n\nHe typed "
               "this to me in conversation, in answer to exactly this card.")
OWNER_NO_PROVENANCE = ("owner",
                       "MEASURED 2026-09-29 from the card that asked whether his browser can "
                       "reach the dashboard at all. It can.")
DECLARED = ("owner",
            "**OWNER'S ANSWER, recorded verbatim.**\n\n> do it — option 1\n\nMatched to this card "
            "because he TYPED these words as the answer to a `clarify` prompt (session "
            "`20260929_000000_0000`, message 1), and `hermes-decision-answers` quoted them "
            "verbatim in a comment on this card at or after that answer. The reply reached the "
            "board as a RELAY; the card had already been moved on, so this job recorded the "
            "comment ONLY and did not change its status.")
SELECTION = ("hermes-decision-answers",
             "## OWNER SELECTED — option 3 of 3 offered on this card\n\n**The owner SELECTED this "
             "option. The sentence quoted below is the LANE's, not his** — it is the option text "
             "he was OFFERED, and he picked it.\n\n> Have me fix the relay instead\n\n**What he "
             "did:** selected option 3 of 3 on a `clarify` prompt (session "
             "`20260927_043500_4698c0`, message 2372539, response 0).")
APPEAL = ("eng-worker", "## OWNER HAS NOT RULED\nthe ruling does not cover this card")

CARDS = [
    # id, comments (newest FIRST, as the page reads them)
    ("t_lane_marker", [LANE_MARKER]),
    ("t_owner_no_provenance", [OWNER_NO_PROVENANCE]),
    ("t_declared", [DECLARED]),
    ("t_selection", [SELECTION]),
    ("t_appealed", [DECLARED, APPEAL]),
    ("t_no_ruling", [("eng-worker", "a status note")]),
]
SHOWN = {"t_lane_marker", "t_owner_no_provenance", "t_appealed", "t_no_ruling"}
HIDDEN = {"t_declared", "t_selection"}


def build_board():
    """A one-board home holding every shape, `needs_input` and parked."""
    tmp = tempfile.mkdtemp(prefix="mc-declared-board-")
    path = os.path.join(tmp, "kanban.db")
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    cid = 0
    for tid, comments in CARDS:
        conn.execute("INSERT INTO tasks (id, title, assignee, status, block_kind, created_at, "
                     "priority, consecutive_failures) VALUES (?, ?, 'eng-worker', 'blocked', "
                     "'needs_input', ?, 0, 0)", (tid, "ask " + tid, NOW - 3600))
        conn.execute("INSERT INTO task_events (task_id, kind, payload, created_at) VALUES "
                     "(?, 'blocked', ?, ?)",
                     (tid, '{"reason": "OWNER DECISION required"}', NOW - 3600))
        # NEWEST FIRST is how `_comments_by_task` reads, so insert oldest first and let the ids
        # order them: the page's `ORDER BY id DESC` then matches `comments`.
        for author, body in reversed(comments):
            cid += 1
            conn.execute("INSERT INTO task_comments (id, task_id, author, body, created_at) "
                         "VALUES (?, ?, ?, ?, ?)", (cid, tid, author, body, NOW - 3600))
    conn.commit()
    conn.close()
    return tmp, path


class WaitingExclusionDeclaredTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp, cls.path = build_board()
        cls.payload = api._awaiting_for_board("t_synth", cls.path, 50)
        cls.excluded = {row.split(" ", 1)[0]: row.split(" ", 1)[1]
                        for row in cls.payload["excluded"]["named"]}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_the_page_resolved_the_lib_under_test(self):
        """A positive control on the harness: if this fails, every arm below measures nothing.

        Compared through `realpath`: `_ask_filter` reaches the module through the fixture home's
        `scripts/lib` SYMLINK, so `__file__` is the link's path, not the lib's.
        """
        got = os.path.realpath(str(lib().__file__))
        self.assertEqual(os.path.dirname(got), os.path.realpath(str(LIVE_LIB)),
                         "the page resolved %s, not %s" % (got, LIVE_LIB))
        self.assertTrue(hasattr(lib(), "declared_ruling_evidence"),
                        "the lib under test has no `declared_ruling_evidence` -- point MC_LIB_DIR "
                        "at the fixed store")

    def test_a_lane_marker_no_longer_hides_the_ask(self):
        """⛔ THE DEFECT, ARM 1. A lane's relay is a ruling to the QUEUE and not to the inbox."""
        self.assertTrue(lib().ruling_evidence([LANE_MARKER]),
                        "NEGATIVE CONTROL: the old predicate must read this as a ruling, or this "
                        "arm would pass against the pre-fix revision too")
        self.assertNotIn("t_synth/t_lane_marker", self.excluded)
        self.assertIn("t_lane_marker", {i["id"] for i in self.payload["framed"]
                                        + self.payload["parked"]})

    def test_an_owner_handle_comment_with_no_provenance_no_longer_hides_the_ask(self):
        """⛔ THE DEFECT, ARM 2 -- the hand-written `--author owner` carrier shape."""
        self.assertTrue(lib().ruling_evidence([OWNER_NO_PROVENANCE]))
        self.assertNotIn("t_synth/t_owner_no_provenance", self.excluded)

    def test_a_declared_owner_answer_still_hides_the_ask(self):
        """CONTROL: the narrowing is a narrowing, not a removal -- the page's own answer route."""
        self.assertEqual(self.excluded.get("t_synth/t_declared"), "already answered")

    def test_the_estates_own_selection_record_still_hides_the_ask(self):
        """CONTROL: `## OWNER SELECTED` is the applier's record of his pick, and it counts."""
        self.assertEqual(self.excluded.get("t_synth/t_selection"), "already answered")

    def test_an_appeal_still_defeats_the_exclusion(self):
        """CONTROL: a lane that MEASURES the ruling as not covering the card re-opens it."""
        self.assertNotIn("t_synth/t_appealed", self.excluded)

    def test_a_card_with_no_ruling_is_untouched(self):
        """CONTROL: nothing changed for the ordinary park."""
        self.assertNotIn("t_synth/t_no_ruling", self.excluded)

    def test_the_page_and_the_guard_ask_the_same_question(self):
        """⛔ THE AGREEMENT ARM: for EVERY card, "hidden" is exactly "the guard would act on it".

        The guard's predicate is `is_declared_owner_answer`; the estate's own selection record is
        the other form the page admits. Asserted per card, over the page's own payload, so a page
        that re-spells either half goes red here.
        """
        for tid, comments in CARDS:
            key = "t_synth/" + tid
            declared = any(lib().owner_answer.is_declared_owner_answer({"author": a, "body": b})
                           for a, b in comments)
            selection = lib()._selection_evidence(lib()._as_pairs(comments)) is not None
            appealed = lib().appeal_in(comments) or lib().owner_act_unperformed(comments)
            should_hide = (declared or selection) and not appealed
            self.assertEqual(key in self.excluded, should_hide,
                             "%s: hidden=%s, guard-actionable=%s"
                             % (key, key in self.excluded, should_hide))

    def test_the_shown_cards_are_exactly_the_ones_the_fix_names(self):
        """The population claim, asserted as a SET so a new silent drop cannot hide in it."""
        self.assertEqual({k.split("/", 1)[1] for k in self.excluded}, HIDDEN)
        self.assertEqual({i["id"] for i in self.payload["framed"] + self.payload["parked"]}, SHOWN)


if __name__ == "__main__":
    unittest.main()
