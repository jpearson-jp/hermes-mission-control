#!/usr/bin/env python3
"""AN OWNER ACTION IS NOT A DECISION: the apply path records it and MOVES NOTHING (kanban t_d4fc2d80).

THE DEFECT THIS PINS, MEASURED 2026-09-26 on `protection-suite:t_01242e2d`, three times round the
same triangle. The card's frame offered, as option 1, *"do the short read yourself"* — an act only
the OWNER can perform (no lane can hold a platform-owner session; every machine mint comes back
`is_platform_owner:false`). He selected it. This route read *"the owner selected option N"* as a
machine-applicable DECISION:

    03:15:32Z  commented (jesse) + unblocked          <- the park lifted on his SELECTION
    03:16:19Z  claimed run 796 -> eng-reviewer        <- re-dispatched to a lane that cannot act
    03:19:45Z  block_loop_detected rec=2 -> triage    <- same question back in his queue
    14:56:57Z  commented (jesse) + specified + promoted {"status":"ready"}
    14:57:53Z  claimed run 864 -> eng-reviewer
    15:03:30Z  block_loop_detected rec=3

Three full lane runs, zero artifacts, and the milestone's closing artifact (a pasted live read)
could only ever be produced by his hands.

THE CONTROL PAIR, AND WHY BOTH ARMS ARE HERE:

  * POSITIVE -- a fixture ask whose block classifies its option as an OWNER ACTION
    (`**OWNER ACTION: 1**`). Applying that selection must leave the card parked in the owner's
    queue and must emit NO `promoted` / `unblocked` event. The control is the CARD'S OWN EVENT LOG,
    not the arm's intent: a route that merely means to park looks identical to one that does.
  * NEGATIVE -- the same fixture SHAPE with a genuine LANE DECISION (no marker). The selection must
    still re-open the card exactly as today, with the `promoted`/`unblocked` event and status
    `ready`. This arm exists so the fix cannot be "never promote": it has to DISCRIMINATE.
  * TRIAGE -- the second measured cycle: the card was in `triage`, where the route's one exit is
    `specify_triage_task`. An owner-action selection there must not lift it either.
  * WORDED ONLY -- the same option PROSE with no trailer. Not an owner action. This is the
    id-polarity arm: the classification is the frame's own marker, never a guess at English.
  * RED ON BASE -- the pre-change bytes, driven over the SAME fixture, DO move the card. An arm that
    cannot fail is not a control.

Run it with the dashboard's own interpreter (the route module imports `hermes_cli`):

    /home/hermes/.hermes/hermes-agent/venv/bin/python -m unittest discover -s tests -v

Set `MC_API_PATH` to grade a DIFFERENT revision of the route module -- that is how the red-on-base
proof below is taken.

⛔ WHY THIS FILE IS HERMETIC, AND WHY IT MUST STAY THAT WAY. This test resolves its scratch board
with `kanban_db.kanban_db_path(board=SLUG)` and CLEARS the `HERMES_KANBAN_DB` pin first, because the
pin SHADOWS that call. An earlier harness on this box resolved the pin's own board and `rmtree`d it,
deleting the live `tos` board (19,188 cards, restored from a snapshot). So: a PRIVATE kanban home,
the pin cleared, and a REFUSAL to run unless the resolved board path is inside that home.
`test_the_scratch_board_is_inside_the_tests_own_home` holds the guard open. Never delete it.
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
API_PATH = Path(os.environ.get("MC_API_PATH", REPO / "dashboard" / "plugin_api.py"))
SLUG = "mc-owneractiontest"

#: The measured shape: option 1 is the owner's own act, option 2 is a lane's.
OPTIONS = ["Do the short read yourself and paste it — only your session holds the "
           "platform-owner view.",
           "Widen the machine read path to reach the owner's view."]

OWNER_ACTION_WHY = ("pasting the live read is an act only the owner's hands can perform; "
                    "no lane can hold his session.")

ACT_EVENTS = ("promoted", "unblocked", "specified", "scheduled", "reopened")


def load_api(path=None):
    """Import the plugin's route module from its file -- the same way the dashboard does."""
    name = "mc_plugin_api_owneraction_under_test"
    spec = importlib.util.spec_from_file_location(name, path or API_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


api = load_api()


def frame(owner_action: bool, rec: int = 1, options=None):
    """A real framed ask, in the shape `lib/owner_options.parse` accepts (2-4 numbered options).

    `owner_action=True` adds the block's OWN `**OWNER ACTION: N**` trailer -- the classification
    the frame is AUTHORED with. `owner_action=False` is the same block and the same prose, with
    no classification at all.
    """
    opts = options or OPTIONS
    body = ["The ask, in the card's own words.", "", "## OPTIONS FOR THE OWNER", "",
            "Summary: who produces the live read the milestone closes on.", ""]
    for i, o in enumerate(opts):
        body.append("%d. %s" % (i + 1, o))
    body.append("")
    body.append("**RECOMMENDATION: %d** -- it is the only path that produces the artifact." % rec)
    body.append("")
    if owner_action:
        body.append("**OWNER ACTION: 1** -- %s" % OWNER_ACTION_WHY)
        body.append("")
    return "\n".join(body)


class OwnerActionIsNotADecision(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = Path(tempfile.mkdtemp(prefix="mc-owneractiontest-kanban-"))
        os.environ["HERMES_KANBAN_HOME"] = str(cls.home)
        os.environ.pop("HERMES_KANBAN_DB", None)
        resolved = Path(api.kanban_db.kanban_db_path(board=SLUG)).resolve()
        inside = str(resolved).startswith(str(cls.home.resolve()) + os.sep)
        if not inside:
            raise RuntimeError(
                "REFUSING TO RUN: board %r resolved to %s, which is OUTSIDE this test's own "
                "kanban home %s. A test that writes to a shared board store is how the live "
                "`tos` board was deleted on 2026-09-25 -- see this module's docstring."
                % (SLUG, resolved, cls.home))
        cls.board_dir = resolved.parent
        api.kanban_db.init_db(board=SLUG)
        cls.conn = api.kbc.connect(board=SLUG)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.conn.close()
        except Exception:
            pass
        shutil.rmtree(cls.home, ignore_errors=True)

    # ---------------------------------------------------------------- the guard itself

    def test_the_scratch_board_is_inside_the_tests_own_home(self):
        """The arm that makes every rmtree below safe. Never delete this test."""
        resolved = Path(api.kanban_db.kanban_db_path(board=SLUG)).resolve()
        self.assertTrue(str(resolved).startswith(str(self.home.resolve()) + os.sep), resolved)
        self.assertEqual(resolved, self.board_dir / "kanban.db")
        self.assertNotIn(".hermes/kanban", str(resolved))

    # ---------------------------------------------------------------- fixtures and readers

    def mkcard(self, title, block_kind, owner_action=False, status="blocked", framed=True):
        """A card parked the way a board parks one; UNASSIGNED so no dispatcher can claim it.

        `create_task` admits only `blocked`/`running` as an initial status, so a card that must sit
        in `triage` is created parked and then moved by the same raw UPDATE the block-loop breaker's
        effect has on the row (`triage` is reached by core's own `block_loop_detected` re-type, and
        nothing in this fixture pretends to re-run that machinery).
        """
        tid = api.kanban_db.create_task(
            self.conn, title=title, body="the card body", initial_status="blocked", board=SLUG,
            block_kind=block_kind, block_reason="parked for %s" % block_kind)
        if status != "blocked":
            self.conn.execute("UPDATE tasks SET status = ? WHERE id = ?", (status, tid))
            self.conn.commit()
        if framed:
            api.kanban_db.add_comment(self.conn, tid, "decision-framer", frame(owner_action))
        return tid

    def task(self, tid):
        return api.kanban_db.get_task(self.conn, tid)

    def comments(self, tid):
        return [r["body"] for r in self.conn.execute(
            "SELECT body FROM task_comments WHERE task_id = ? ORDER BY id", (tid,))]

    def events(self, tid):
        """The card's own event kinds, in order -- THE control, not the arm's intent."""
        return [r["kind"] for r in self.conn.execute(
            "SELECT kind FROM task_events WHERE task_id = ? ORDER BY id", (tid,))]

    def new_events(self, tid, before):
        return [k for k in self.events(tid)[len(before):]]

    def report(self, label, tid, before, res):
        """Print the control's own evidence, so the handoff quotes MEASUREMENT not intent."""
        task = self.task(tid)
        delta = self.new_events(tid, before)
        print("\n[%s] %s" % (label, tid))
        print("   status_before=%r status_after=%r block_kind=%r"
              % (res.get("status_before"), res.get("status_after"), task.block_kind))
        print("   events BEFORE : %s" % (before,))
        print("   events AFTER  : %s" % (self.events(tid),))
        print("   events EMITTED BY THE APPLY: %s" % (delta or "[] (none)",))
        print("   route returned owner_action=%r promoted=%r"
              % (res.get("owner_action"), res.get("promoted")))
        return delta

    # ---------------------------------------------------------------- POSITIVE

    def test_an_owner_action_selection_leaves_the_card_parked(self):
        """POSITIVE: recorded, and the card does not move. The event log IS the control."""
        tid = self.mkcard("owner action ask", "needs_input", owner_action=True)
        before = self.events(tid)
        res = api.answer(api.AnswerBody(board=SLUG, task_id=tid, choice=1))
        delta = self.report("POSITIVE", tid, before, res)

        task = self.task(tid)
        self.assertEqual(task.status, "blocked", "an owner action must NOT re-open the card")
        self.assertEqual(task.block_kind, "needs_input", "and must keep it in the owner's queue")
        self.assertEqual([k for k in delta if k in ACT_EVENTS], [],
                         "NO promoted/unblocked/specified event may be emitted: %r" % (delta,))
        self.assertFalse(res["promoted"], res)
        self.assertTrue(res["owner_action"], res)
        # the selection IS recorded -- his act is real, and a silent skip would read as a failure
        text = "\n".join(self.comments(tid))
        self.assertIn("**OWNER DECISION**", text)
        self.assertIn("Option 1 chosen", text)
        self.assertIn("OWNER ACTION", text,
                      "the card must say WHY it did not move, or the no-move reads as a refusal")

    # ---------------------------------------------------------------- NEGATIVE

    def test_a_lane_decision_still_re_opens_the_card(self):
        """NEGATIVE: the same fixture SHAPE, no marker -- exactly today's behaviour."""
        tid = self.mkcard("lane decision ask", "needs_input", owner_action=False)
        before = self.events(tid)
        res = api.answer(api.AnswerBody(board=SLUG, task_id=tid, choice=1))
        delta = self.report("NEGATIVE", tid, before, res)

        task = self.task(tid)
        self.assertNotEqual(task.status, "blocked", "a lane decision must still re-open the card")
        self.assertEqual(task.status, "ready", res)
        self.assertIsNone(task.block_kind, "a re-opened card is not parked any more")
        self.assertTrue([k for k in delta if k in ACT_EVENTS],
                        "the promoted/unblocked event is the NEGATIVE arm's proof: %r" % (delta,))
        self.assertFalse(res["owner_action"], res)
        self.assertTrue(res["promoted"], res)

    # ---------------------------------------------------------------- the second measured cycle

    def test_an_owner_action_does_not_lift_a_triage_park(self):
        """The 14:56:57Z cycle: the card sat in `triage`, where `specify_triage_task` is the exit."""
        tid = self.mkcard("owner action ask, triage", "needs_input", owner_action=True,
                          status="triage")
        before = self.events(tid)
        res = api.answer(api.AnswerBody(board=SLUG, task_id=tid, choice=1))
        delta = self.report("TRIAGE", tid, before, res)

        self.assertEqual(self.task(tid).status, "triage",
                         "an owner action must not lift a triage park either")
        self.assertEqual([k for k in delta if k in ACT_EVENTS], [], repr(delta))
        self.assertFalse(res["promoted"], res)

    def test_a_lane_decision_still_lifts_a_triage_park(self):
        """CONTROL for the arm above: without the marker the triage exit still runs."""
        tid = self.mkcard("lane decision ask, triage", "needs_input", owner_action=False,
                          status="triage")
        before = self.events(tid)
        res = api.answer(api.AnswerBody(board=SLUG, task_id=tid, choice=1))
        delta = self.report("TRIAGE-NEGATIVE", tid, before, res)

        self.assertNotEqual(self.task(tid).status, "triage", "the triage exit must still run")
        self.assertTrue([k for k in delta if k in ACT_EVENTS], repr(delta))

    # ---------------------------------------------------------------- the id-polarity arm

    def test_the_same_prose_without_the_marker_is_a_decision(self):
        """⛔ THE MARKER IS THE CLASSIFICATION, NEVER THE ENGLISH IN THE OPTION."""
        tid = self.mkcard("do it yourself, unclassified", "needs_input", owner_action=False)
        parsed = api.parse_frame(frame(False))
        self.assertTrue(parsed["framed"], parsed)
        self.assertIsNone(parsed["owner_action"],
                          "the option SAYS the owner does it, and is still a lane decision: "
                          "an applier must not classify prose")
        with_marker = api.parse_frame(frame(True))
        self.assertEqual(with_marker["owner_action"], 1, with_marker)

    def test_the_marker_binds_to_the_recommendation_and_a_bulk_accept_honours_it(self):
        """A bulk accept of a recommendation that IS an owner action must not move either."""
        tid = self.mkcard("owner action, recommended", "needs_input", owner_action=True)
        before = self.events(tid)
        res = api.answer_many(api.AnswerManyBody(board=SLUG, ids=[tid], accept_recommended=True))
        self.assertEqual(res["answered"], 1, res)
        row = res["results"][0]
        print("\n[BULK] %s -> %r" % (tid, row))
        self.assertTrue(row["owner_action"], row)
        self.assertFalse(row["promoted"], row)
        self.assertEqual(self.task(tid).status, "blocked", "still parked")
        self.assertEqual([k for k in self.new_events(tid, before) if k in ACT_EVENTS], [])

    def test_the_local_fallback_agrees_with_the_shared_parser(self):
        """The page's fallback trailer read and `lib/owner_options` must not drift.

        The plugin reads the parser's field and falls back to `_owner_action_local` only for a
        parser revision that predates the vocabulary. A drift in the marker's spelling would
        silently stop classifying, so the two are bound on one fixture here.
        """
        body = frame(True)
        self.assertEqual(api._owner_action_local(body), 1)
        self.assertIsNone(api._owner_action_local(frame(False)))
        mod = api._owner_options()
        if mod is None:
            print("\n[note] lib/owner_options.py is not importable here; the binding arm reports "
                  "the plugin's own read only")
            return
        if "owner_action" not in (mod.parse(body) or {}):
            print("\n[note] the installed lib/owner_options.py predates the OWNER ACTION "
                  "vocabulary; the plugin is running on its documented fallback, and the shared "
                  "parser's binding arm SKIPS (not a pass)")
            return
        self.assertEqual((mod.parse(body) or {}).get("owner_action"), "1")
        self.assertIsNone((mod.parse(frame(False)) or {}).get("owner_action"))
        # the SPELLING is shared too -- a drift in the pattern would classify nothing, silently
        self.assertEqual(api._OWNER_ACTION_RE.pattern, mod.OWNER_ACTION_RE.pattern)

    # ---------------------------------------------------------------- red on base

    def test_the_pre_change_bytes_did_move_the_card(self):
        """RED ON BASE: an arm that cannot fail is not a control."""
        try:
            blob = subprocess.run(["git", "show", "origin/main:dashboard/plugin_api.py"],
                                  cwd=str(REPO), capture_output=True, text=True, check=False)
        except OSError as exc:
            print("\n[SKIP] red-on-base: git unavailable (%s)" % exc)
            return
        if blob.returncode != 0 or "def answer(" not in blob.stdout:
            print("\n[SKIP] red-on-base: no pre-change revision reachable from origin/main")
            return
        tmp = Path(self.home) / "base_plugin_api.py"
        tmp.write_text(blob.stdout, encoding="utf-8")
        base = load_api(tmp)
        tid = api.kanban_db.create_task(
            self.conn, title="owner action ask, base bytes",
            body="the card body", initial_status="blocked", board=SLUG,
            block_kind="needs_input", block_reason="parked for needs_input")
        api.kanban_db.add_comment(self.conn, tid, "decision-framer", frame(True))
        before = self.events(tid)
        res = base.answer(base.AnswerBody(board=SLUG, task_id=tid, choice=1))
        delta = [k for k in self.events(tid)[len(before):]]
        print("\n[RED-ON-BASE] %s" % tid)
        print("   status_before=%r status_after=%r" % (res.get("status_before"),
                                                       res.get("status_after")))
        print("   events EMITTED: %s" % (delta,))
        self.assertNotEqual(self.task(tid).status, "blocked",
                            "THE DEFECT, on the pre-change bytes: the owner's selection of an "
                            "owner-action option re-opened the card")
        self.assertTrue([k for k in delta if k in ACT_EVENTS],
                        "and the pre-change bytes emitted the act event: %r" % (delta,))


if __name__ == "__main__":
    unittest.main()
