#!/usr/bin/env python3
"""The frame reader: the mark is a HEADING, and the newest PARSEABLE block wins (t_c8674e51).

The defect these arms close: `_frame_bodies` selected the NEWEST COMMENT CONTAINING the phrase
`OPTIONS FOR THE OWNER` (last-wins over `LIKE '%OPTIONS FOR THE OWNER%'`) and the card detail did
the same (`next(c for c in comments if _FRAME_MARKER in c["body"])`), while `lib/owner_options.py`
-- the parser `hermes-decision-nag.py`, `decision-framer-facts.py` and `engwatch-card-hygiene.py`
share -- anchors the mark as a HEADING on a line of its own and takes the newest PARSEABLE block.
So a status note that merely MENTIONED the heading in prose un-framed a live owner ask: the block
was still on the card and the owner's list showed him an ask with zero options.

MEASURED 2026-09-22 against the live boards, with the reader before and after this fix over the
same sweep of parked owner asks: `transport` (a real block exists, the page renders NOTHING
pickable) 12 -> 0, `superseded` (the page renders an older block than the nag) 1 -> 0.

Run it with the dashboard's own interpreter (the module imports `hermes_cli`):

    /home/hermes/.hermes/hermes-agent/venv/bin/python -m unittest discover -s tests -v

The last arm runs against the LIVE board, read-only, and asserts the INVARIANT rather than a
literal body (a literal would rot the moment the owner answers a card): for every parked owner ask,
the body this page picks IS the body `lib/owner_options.newest()` would render.
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
API_PATH = REPO / "dashboard" / "plugin_api.py"
LIVE_DB = Path(os.environ.get("MC_LIVE_BOARD_DB",
                              "/home/hermes/.hermes/kanban/boards/tos/kanban.db"))
SCRIPTS_LIB = Path(os.environ.get("MC_SCRIPTS_LIB", "/home/hermes/.hermes/scripts/lib"))
sys.path.insert(0, str(SCRIPTS_LIB))
import owner_options  # noqa: E402


def load_api():
    """Import the plugin's route module from its file — the same way the dashboard does."""
    name = "mc_plugin_api_frame_under_test"
    spec = importlib.util.spec_from_file_location(name, API_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


api = load_api()

BLOCK = """The ask, in the card's own words.

## OPTIONS FOR THE OWNER

Summary: ratify the narrowed predicate now?

1. Ratify the narrowed predicate now — it ships on the next merge.
2. Hold until the recall ratchet is on main and a TP floor is measured.
3. Do not narrow the class; quiet it instead.

**RECOMMENDATION: 2** — the recall ratchet is unmeasured.
"""

# The live shape: a status note that QUOTES the heading and happens to carry a numbered list.
MENTION = ("Status: the `## OPTIONS FOR THE OWNER` block stands, and nothing here changed it.\n"
           "1. not an option — just prose\n2. also not an option\n")

MENTION_NO_LIST = "Status note: the `## OPTIONS FOR THE OWNER` block above still stands.\n"


def make_db(comments):
    """An in-memory `task_comments` shaped like the real table. comments = (id, task_id, body)."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE task_comments (id INTEGER PRIMARY KEY, task_id TEXT, author TEXT, "
                 "body TEXT, created_at INTEGER)")
    for cid, tid, body in comments:
        conn.execute("INSERT INTO task_comments (id, task_id, author, body, created_at) "
                     "VALUES (?, ?, 'lane', ?, ?)", (cid, tid, body, 1_700_000_000 + cid))
    conn.commit()
    return conn


class FrameReaderTest(unittest.TestCase):
    def test_the_reader_is_the_one_parser(self):
        """The page must read `lib/owner_options.py` — a fourth copy is how this drifted."""
        mod = api._owner_options()
        self.assertIsNotNone(mod, "lib/owner_options.py must be importable on this box")
        self.assertEqual(Path(mod.__file__).resolve(), (SCRIPTS_LIB / "owner_options.py").resolve())

    def test_a_prose_mention_does_not_shadow_an_older_block(self):
        """THE DEFECT: the mention is NEWER, so the old rule picked it and framed nothing."""
        bodies = [MENTION, BLOCK]                      # newest first
        self.assertEqual(api._newest_framed_body(bodies), BLOCK)
        frame = api.parse_frame(api._newest_framed_body(bodies))
        self.assertTrue(frame["framed"])
        self.assertEqual(len(frame["options"]), 3)
        self.assertEqual(frame["recommendation"], 2)

    def test_a_mention_is_never_a_candidate_on_its_own(self):
        for mention in (MENTION, MENTION_NO_LIST):
            self.assertIsNone(api._newest_framed_body([mention]))
            self.assertFalse(api.parse_frame(mention)["framed"])

    def test_empty_output_is_not_framed_positive_control(self):
        """Empty is not framed; a genuine block still is — the two halves of the same arm."""
        for empty in (None, "", "   \n"):
            frame = api.parse_frame(empty)
            self.assertFalse(frame["framed"], "parse_frame(%r) must not be framed" % (empty,))
            self.assertEqual(frame["options"], [])
        frame = api.parse_frame(BLOCK)
        self.assertTrue(frame["framed"])
        self.assertEqual([o.split(" ")[0] for o in frame["options"]], ["Ratify", "Hold", "Do"])

    def test_a_quoted_block_is_not_the_card_s_block(self):
        """A fenced example is a quotation: the shared parser refuses it, so this page must too."""
        quoted = "```\n## OPTIONS FOR THE OWNER\n1. a — b\n2. c — d\n```\n"
        self.assertIsNone(api._newest_framed_body([quoted, quoted]))

    def test_frame_bodies_takes_the_newest_parseable_not_the_newest_mention(self):
        conn = make_db([(1, "t_x", BLOCK), (2, "t_x", MENTION),
                        (3, "t_y", MENTION_NO_LIST)])
        got = api._frame_bodies(conn, ["t_x", "t_y"])
        self.assertEqual(got.get("t_x"), BLOCK, "the older real block must win over the mention")
        self.assertNotIn("t_y", got, "a mention-only card is not framed")

    def test_the_list_and_the_detail_page_read_the_same_rule(self):
        """SOURCE-SHAPE arm: both consumers go through `_frame_bodies`, not through a substring.

        The detail route used to pick its own body (`next(c for c in comments if _FRAME_MARKER in
        c["body"])`) over a 25-comment window, so the page and the list could pick different
        blocks — and a block older than 25 comments was invisible on the detail page alone.
        """
        src = API_PATH.read_text(encoding="utf-8")
        self.assertNotIn('_FRAME_MARKER in c["body"]', src)
        self.assertIn("_frame_bodies(conn, [task_id])", src)

    def test_the_page_and_the_nag_pick_the_same_body_over_a_corpus(self):
        """THE CONTRACT, over a fixed corpus of the shapes that occur on the live board."""
        corpus = [
            [MENTION, BLOCK],                 # mention newer than a block
            [MENTION_NO_LIST, BLOCK],         # mention with no list at all
            [BLOCK],                          # block only
            [BLOCK, BLOCK],                   # two blocks: the newest wins
            [MENTION],                        # mention only
            [MENTION_NO_LIST, MENTION],       # mentions only, newest first
            [],                               # no comments
        ]
        for bodies in corpus:
            mine = api._newest_framed_body(list(bodies))
            theirs = owner_options.newest(list(bodies))
            self.assertEqual(bool(mine), theirs is not None,
                             "readers disagree on %r" % (bodies,))
            if mine:
                self.assertEqual(owner_options.parse(mine) is not None, True)
                self.assertEqual(len(api.parse_frame(mine)["options"]),
                                 len(theirs["options"]))


@unittest.skipUnless(LIVE_DB.is_file(), "live board not present")
class LiveBoardTest(unittest.TestCase):
    def test_every_parked_owner_ask_is_read_the_same_way_by_both_readers(self):
        conn = sqlite3.connect("file:%s?mode=ro" % LIVE_DB, uri=True)
        conn.row_factory = sqlite3.Row
        try:
            parked = [r["id"] for r in conn.execute(
                "SELECT id FROM tasks WHERE status IN ('blocked','triage') "
                "AND block_kind='needs_input'")]
            self.assertTrue(parked, "the live board has no parked owner asks to check")
            transport, superseded = [], []
            for tid in parked:
                bodies = [r["body"] or "" for r in conn.execute(
                    "SELECT body FROM task_comments WHERE task_id=? ORDER BY id DESC", (tid,))]
                mine = api._newest_framed_body(list(bodies))
                theirs = next((b for b in bodies if owner_options.parse(b)), None)
                if theirs is None:
                    continue                       # nothing framed anywhere: a framing job
                if not api.parse_frame(mine)["framed"]:
                    transport.append(tid)
                elif mine != theirs:
                    superseded.append(tid)
            self.assertEqual(transport, [],
                             "these parked asks carry a real block the page renders as NO OPTIONS")
            self.assertEqual(superseded, [],
                             "these parked asks render an OLDER block than the nag would send")
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
