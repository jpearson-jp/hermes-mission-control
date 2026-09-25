#!/usr/bin/env python3
"""The owner's bulk answer: EVERY item, and never a park that is not his (kanban t_8723e030).

Three behaviours, three arms:

  * BULK -- one call answers >= 2 `needs_input` cards, each left UNBLOCKED with the chosen
    option's own text recorded as a comment on THAT card.
  * REFUSAL -- a card parked for a reason that is not the owner's (`capability`) is refused and
    stays parked, while the owner's own card in the SAME call is answered. This arm is RED ON
    BASE (5c735b3): `/answer` there re-opened any card in blocked/scheduled, so the capability
    card came back `ready` carrying an owner comment. MEASURED on this box 2026-09-25 by
    `status, block_kind`: 563 cards are parked `capability`, 66 `transient`, 2
    `awaiting_publication`, 3 `capability` triage, 15 `scheduled`.
  * FRAMED LIST -- N cards, each carrying its OWN `RECOMMENDATION:` line, answered in ONE act
    through the flat `board`+`ids`+`accept_recommended` form, each card's OWN recommendation
    recorded on its own card. Not the first one and not a guess.

Run it with the dashboard's own interpreter (the route module imports `hermes_cli`):

    /home/hermes/.hermes/hermes-agent/venv/bin/python -m unittest discover -s tests -v

Set `MC_API_PATH` to grade a DIFFERENT revision of the route module -- that is how the
red-on-base proof is taken:

    git show 5c735b3:dashboard/plugin_api.py > /tmp/base_plugin_api.py
    MC_API_PATH=/tmp/base_plugin_api.py ... -m unittest discover -s tests -v

⛔ WHY THIS FILE IS HERMETIC, AND WHY IT MUST STAY THAT WAY.

An earlier revision of this harness resolved its scratch board with

    Path(kanban_db.kanban_db_path(board=SLUG)).parent        # then shutil.rmtree()

and `kanban_db_path` is SHADOWED BY THE `HERMES_KANBAN_DB` PIN every worker lane carries
(`_board_path`: "the pin WINS over board"). Under that pin the "scratch" path resolved to the
lane's own board, and the cleanup DELETED IT. MEASURED 2026-09-25 10:00Z: the live `tos` board
-- 19,188 cards -- was removed that way and restored from the board warden's 09:52:49Z snapshot.
The pin is invisible at the call site, so no reviewer can catch this by reading the rmtree.

So the harness owns a PRIVATE kanban home, clears the pin, and REFUSES TO RUN unless the
resolved board path is inside that home. `test_the_scratch_board_is_inside_the_tests_own_home`
is the arm that holds the guard open: if the guard is ever weakened, that test fails before any
rmtree can run. Do not replace the guard with a comment.
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
API_PATH = Path(os.environ.get("MC_API_PATH", REPO / "dashboard" / "plugin_api.py"))
SLUG = "mc-answertest"

OPTIONS = ["Ratify the narrowed predicate now.",
           "Hold until the recall ratchet is on main.",
           "Do not narrow the class; quiet it instead."]


def load_api():
    """Import the plugin's route module from its file -- the same way the dashboard does."""
    name = "mc_plugin_api_answer_under_test"
    spec = importlib.util.spec_from_file_location(name, API_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


api = load_api()


def frame(rec, options=None):
    """A real framed ask, in the shape `lib/owner_options.parse` accepts (2-4 numbered options).

    `rec=None` omits the RECOMMENDATION line -- the shape a card reaches this verb in when a lane
    framed options without picking one, which the bulk accept must REFUSE rather than guess.
    """
    opts = options or OPTIONS
    body = ["The ask, in the card's own words.", "", "## OPTIONS FOR THE OWNER", "",
            "Summary: which way?", ""]
    for i, o in enumerate(opts):
        body.append("%d. %s" % (i + 1, o))
    body.append("")
    if rec is not None:
        body.append("**RECOMMENDATION: %d** -- it is the reversible one." % rec)
        body.append("")
    return "\n".join(body)


class OwnerBulkAnswer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = Path(tempfile.mkdtemp(prefix="mc-answertest-kanban-"))
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
        self.assertNotIn("hermes-controlplane", str(resolved))
        self.assertNotIn(".hermes/kanban", str(resolved))

    def mkcard(self, title, block_kind, rec=None, framed=True, status="blocked"):
        """A card parked the way a board parks one; UNASSIGNED so no dispatcher can claim it."""
        tid = api.kanban_db.create_task(
            self.conn, title=title, body="the card body", initial_status=status, board=SLUG,
            block_kind=block_kind, block_reason="parked for %s" % block_kind)
        if framed:
            api.kanban_db.add_comment(self.conn, tid, "eng-worker", frame(rec))
        return tid

    def task(self, tid):
        return api.kanban_db.get_task(self.conn, tid)

    def comments(self, tid):
        return [r["body"] for r in self.conn.execute(
            "SELECT body FROM task_comments WHERE task_id = ? ORDER BY id", (tid,))]

    def assert_answered(self, tid, n):
        """OUT of its park, block_kind cleared, and the chosen option's TEXT on the card."""
        task = self.task(tid)
        self.assertNotEqual(task.status, "blocked", "card %s is still parked" % tid)
        self.assertIsNone(task.block_kind, "a re-opened card is not parked any more")
        text = "\n".join(self.comments(tid))
        self.assertIn("**OWNER DECISION**", text)
        self.assertIn("Option %d chosen: %s" % (n, OPTIONS[n - 1]), text)

    # ---------------------------------------------------------------- the three arms

    def test_bulk_answer_answers_every_item(self):
        a = self.mkcard("bulk A", "needs_input", rec=2)
        b = self.mkcard("bulk B", "needs_input", rec=1)
        res = api.answer_many(api.AnswerManyBody(items=[
            api.AnswerManyItem(board=SLUG, task_id=a, choice=2),
            api.AnswerManyItem(board=SLUG, task_id=b, choice=1)]))
        self.assertEqual(res["answered"], 2, res)
        self.assertEqual(res["failed"], 0, res)
        self.assert_answered(a, 2)
        self.assert_answered(b, 1)

    def test_a_park_that_is_not_the_owners_is_refused(self):
        cap = self.mkcard("capability park", "capability", framed=False)
        own = self.mkcard("owner ask", "needs_input", rec=1)
        res = api.answer_many(api.AnswerManyBody(items=[
            api.AnswerManyItem(board=SLUG, task_id=cap, choice=1),
            api.AnswerManyItem(board=SLUG, task_id=own, choice=1)]))
        by = {r["task_id"]: r for r in res["results"]}
        self.assertFalse(by[cap]["ok"], by[cap])
        self.assertIn("not an owner ask", by[cap]["error"])
        self.assertEqual(self.task(cap).status, "blocked", "a refused card must stay parked")
        self.assertEqual(self.comments(cap), [], "a refused answer must write NOTHING")
        self.assertTrue(by[own]["ok"], by[own])
        self.assert_answered(own, 1)

    def test_the_single_card_verb_refuses_a_park_that_is_not_the_owners(self):
        """RED ON BASE BY ASSERTION, not by a missing verb -- this is the refusal's own proof.

        At 5c735b3 `/answer` re-opened ANY card in blocked/scheduled, so on base this arm does
        not error: it unblocks the capability card and writes an owner comment on it, and the
        assertions below fail. That is the difference between "the feature is absent" (the bulk
        arms' AttributeError on base) and "the rule is absent".
        """
        cap = self.mkcard("capability park, single", "capability", framed=False)
        with self.assertRaises(api.HTTPException) as ctx:
            api.answer(api.AnswerBody(board=SLUG, task_id=cap, choice=1))
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("not an owner ask", ctx.exception.detail)
        task = self.task(cap)
        self.assertEqual(task.status, "blocked", "a refused card must stay parked")
        self.assertEqual(task.block_kind, "capability", "and keep the park it came in with")
        self.assertEqual(self.comments(cap), [], "a refused answer must write NOTHING")

    def test_a_framed_list_answers_all_n_in_one_act(self):
        recs = (3, 1, 2)
        cards = [self.mkcard("framed %d" % n, "needs_input", rec=n) for n in recs]
        res = api.answer_many(api.AnswerManyBody(board=SLUG, ids=cards, accept_recommended=True))
        self.assertEqual(res["answered"], len(cards), res)
        for i, (tid, n) in enumerate(zip(cards, recs)):
            self.assertEqual(res["results"][i]["choice"], n, res["results"][i])
            self.assert_answered(tid, n)

    def test_accept_recommended_refuses_a_frame_without_one(self):
        tid = self.mkcard("framed, no recommendation", "needs_input", rec=None)
        res = api.answer_many(api.AnswerManyBody(board=SLUG, ids=[tid], accept_recommended=True))
        self.assertEqual(res["answered"], 0, res)
        self.assertIn("no RECOMMENDATION", res["results"][0]["error"], res)
        self.assertEqual(self.task(tid).status, "blocked")
        stored = self.comments(tid)
        self.assertEqual(len(stored), 1, "the frame is untouched: nothing was appended")
        self.assertIn("OPTIONS FOR THE OWNER", stored[0])
        self.assertNotIn("RECOMMENDATION", stored[0], "a refused accept must not invent one")

    # ---------------------------------------------------------------- the flat form's guards

    def test_the_flat_form_refuses_a_request_it_cannot_carry_out(self):
        tid = self.mkcard("flat form guard", "needs_input", rec=1)
        for body, needle in (
                (api.AnswerManyBody(ids=[tid], accept_recommended=True), "needs `board`"),
                (api.AnswerManyBody(board=SLUG, ids=[tid]), "`option` or accept_recommended"),
                (api.AnswerManyBody(), "nothing to answer")):
            with self.assertRaises(api.HTTPException) as ctx:
                api.answer_many(body)
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn(needle, ctx.exception.detail)
        self.assertEqual(self.task(tid).status, "blocked")


if __name__ == "__main__":
    unittest.main()
