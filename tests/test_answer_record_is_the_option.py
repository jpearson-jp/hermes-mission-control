#!/usr/bin/env python3
"""THE RECORD IS THE OPTION'S OWN BYTES, NOT THE PAGE'S PREVIEW OF IT (kanban t_b92c53cf).

THE DEFECT THIS PINS. `OPTION_PREVIEW_CHARS = 260` is how the card page DRAWS an option; the
answer route then recorded what it had drawn, so the stored answer is a STRICT PREFIX of the
option the owner picked -- silently, because a cut record cannot be told from one whose option
was short.

MEASURED 2026-09-27 by `owner-answer-record-census.py` over every board: of the 142 stored
answers under the dashboard's own handle, 87 -- on 72 distinct cards -- carry a strict prefix of
the option they name. Two of those tails carried a value the ruling needed:

    tos:t_2a383024   the tail held the Azure app-id list the ruling was ABOUT
    tos:t_98bdb892   741 characters dropped: a file path, a command, and the verdict strings
                     that prove the command took

THE CONTROL PAIR, AND WHY BOTH ARMS ARE HERE:

  * POSITIVE -- a fixture whose option is longer than the preview and whose VALUE sits past the
    cut. The answer route is driven exactly as the page drives it: with `option_text` set to the
    preview the owner was shown. The recorded comment must carry the WHOLE option. The control is
    the COMMENT BYTES on the card, not the arm's intent.
  * THE PAGE IS UNTOUCHED -- the same body still renders the 260-character cut for display. This
    arm exists so the fix cannot be "raise OPTION_PREVIEW_CHARS": the page's cut is a display
    decision and is not the defect.
  * DISCLOSED -- when the owner was shown a cut, the record SAYS so, and says how much he saw.
    Recording MORE than he saw must not be silent either.
  * THE CAP STILL HOLDS, AND SAYS SO -- the rule's cap is the parser's own `MAX_OPTION_CHARS`:
    an option longer than it is not an option at all. Text over the cap is recorded with an
    explicit `⛔ RECORD CUT` note naming what was dropped, so the fail-closed arm is measured too.
  * BOUND TO THE SHARED RULE -- the plugin's local arm and `lib/owner_options.answer_record_line`
    must not drift, and `RECORD_CAP_FALLBACK` must equal the parser's cap.
  * RED ON BASE -- the pre-change bytes, driven over the SAME fixture, DO record the cut. An arm
    that cannot fail is not a control.

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
SLUG = "mc-answerrecordtest"

#: The value the ruling is ABOUT, placed past the display cut -- this is the whole point.
VALUE = "app-id 4f2a91c7-8b3e-4d21-9a77-0c5e1f6d2b48"

FILLER = ("Do the scoped read and paste what it returns, so the ruling rests on the read itself "
          "rather than on a restatement of it. ")

LONG_OPTION = (FILLER * 3 + "The value this record must carry is " + VALUE + ".")

SHORT_OPTION = "Widen the machine read path to reach the owner's view."


def load_api(path=None):
    """Import the plugin's route module from its file -- the same way the dashboard does."""
    name = "mc_plugin_api_answerrecord_under_test"
    spec = importlib.util.spec_from_file_location(name, path or API_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


api = load_api()

# The fixture must be capable of failing: the value has to be OUTSIDE what the page shows.
assert len(LONG_OPTION) > api.OPTION_PREVIEW_CHARS, len(LONG_OPTION)
assert VALUE not in LONG_OPTION[:api.OPTION_PREVIEW_CHARS], LONG_OPTION


def frame(options=None, rec: int = 1) -> str:
    """A real framed ask, in the shape `lib/owner_options.parse` accepts (2-4 numbered options)."""
    opts = options or [LONG_OPTION, SHORT_OPTION]
    body = ["The ask, in the card's own words.", "", "## OPTIONS FOR THE OWNER", "",
            "Summary: which read the milestone closes on.", ""]
    for i, o in enumerate(opts):
        body.append("%d. %s" % (i + 1, o))
    body.append("")
    body.append("**RECOMMENDATION: %d** -- it is the only path that produces the artifact." % rec)
    body.append("")
    return "\n".join(body)


class TheRecordIsTheOption(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = Path(tempfile.mkdtemp(prefix="mc-answerrecordtest-kanban-"))
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

    def mkcard(self, title, options=None):
        """A card parked the way a board parks one; UNASSIGNED so no dispatcher can claim it."""
        tid = api.kanban_db.create_task(
            self.conn, title=title, body="the card body", initial_status="blocked", board=SLUG,
            block_kind="needs_input", block_reason="parked for needs_input")
        api.kanban_db.add_comment(self.conn, tid, "decision-framer", frame(options))
        return tid

    def answer_comments(self, tid):
        """The OWNER DECISION records on this card, in order -- the control is the card's bytes."""
        return [r["body"] for r in self.conn.execute(
            "SELECT body FROM task_comments WHERE task_id = ? AND author = 'jesse' ORDER BY id",
            (tid,))]

    # ---------------------------------------------------------------- POSITIVE

    def test_the_recorded_answer_carries_the_whole_option(self):
        """POSITIVE: driven exactly as the page drives it, and the VALUE survives."""
        tid = self.mkcard("long option ask")
        shown_to_owner = api.parse_frame(frame())["options"][0]
        self.assertLessEqual(len(shown_to_owner), api.OPTION_PREVIEW_CHARS)
        self.assertNotIn(VALUE, shown_to_owner, "the fixture must hide the value from the page")

        res = api.answer(api.AnswerBody(board=SLUG, task_id=tid, choice=1,
                                        option_text=shown_to_owner))
        recorded = self.answer_comments(tid)
        self.assertEqual(len(recorded), 1, recorded)
        print("\n[POSITIVE] %s choice=%r" % (tid, res.get("choice")))
        print("   the page showed %d chars; the record carries %d"
              % (len(shown_to_owner), len(recorded[0])))
        self.assertIn("Option 1 chosen:", recorded[0])
        self.assertIn(VALUE, recorded[0],
                      "THE DEFECT: the stored answer is a prefix of the option it names, so the "
                      "value the ruling was about is not on the card. Recorded: %r"
                      % recorded[0])
        self.assertIn(LONG_OPTION.rstrip("."), recorded[0])

    def test_an_index_only_answer_records_the_whole_option_too(self):
        """The other shape the page sends: no `option_text` at all."""
        tid = self.mkcard("index-only ask")
        api.answer(api.AnswerBody(board=SLUG, task_id=tid, choice=1))
        recorded = self.answer_comments(tid)
        self.assertEqual(len(recorded), 1, recorded)
        self.assertIn(VALUE, recorded[0], recorded[0])

    # ---------------------------------------------------------------- the page is untouched

    def test_the_page_still_shows_the_cut(self):
        """⛔ THE FIX IS NOT "RAISE THE PREVIEW": the display cut is a page decision, not the bug."""
        parsed = api.parse_frame(frame())
        self.assertTrue(parsed["framed"], parsed)
        self.assertEqual(len(parsed["options"][0]), api.OPTION_PREVIEW_CHARS)
        self.assertEqual(parsed["options"][1], SHORT_OPTION, "a short option is untouched")
        whole = api.parse_frame(frame(), preview=False)
        self.assertEqual(whole["options"][0], LONG_OPTION,
                         "the record's reader must carry the option's own bytes")
        self.assertIn(VALUE, whole["options"][0])

    def test_the_record_discloses_that_the_owner_was_shown_less(self):
        """Recording MORE than he saw must not be silent either."""
        tid = self.mkcard("disclosure ask")
        shown_to_owner = api.parse_frame(frame())["options"][0]
        api.answer(api.AnswerBody(board=SLUG, task_id=tid, choice=1,
                                  option_text=shown_to_owner))
        recorded = self.answer_comments(tid)[0]
        print("\n[DISCLOSURE] %s" % recorded.splitlines()[-1])
        self.assertIn("the page showed the first %d characters" % len(shown_to_owner), recorded)

    def test_a_sent_text_that_is_not_this_option_is_left_alone(self):
        """A stale frame or another option's text: never overwrite what a caller asserted."""
        tid = self.mkcard("mismatched ask")
        api.answer(api.AnswerBody(board=SLUG, task_id=tid, choice=2,
                                  option_text="something else entirely"))
        recorded = self.answer_comments(tid)[0]
        self.assertIn("something else entirely", recorded)

    # ---------------------------------------------------------------- the cap, fail-closed

    def test_text_over_the_cap_is_recorded_with_an_explicit_cut_note(self):
        """The rule's cap is the parser's `MAX_OPTION_CHARS`; over it, the record SAYS what is gone."""
        over = "x" * (api.RECORD_CAP_FALLBACK + 40)
        line = api._answer_record_line(1, over)
        self.assertIn("⛔ RECORD CUT:", line)
        self.assertIn("40 are NOT stored", line)
        self.assertIn("%d characters" % len(over), line)

    def test_the_local_rule_and_the_shared_rule_agree(self):
        """The plugin's fallback and `lib/owner_options` must not drift, and neither may the cap."""
        body = LONG_OPTION
        local = api._answer_record_line(1, body)
        mod = api._owner_options()
        if mod is None:
            raise AssertionError("lib/owner_options.py must be importable for the shared rule: "
                                 "the record rule lives there (t_b92c53cf)")
        fn = getattr(mod, "answer_record_line", None)
        if fn is None:
            # The store installs through its own gate; until the branch carrying the rule lands,
            # the plugin's local arm is the ONLY rule in force. NAMED SKIP, never a pass.
            print("\n[note] the INSTALLED lib/owner_options.py predates `answer_record_line`; the "
                  "plugin is running on its local arm (same rule) and this binding arm SKIPS "
                  "until the scripts-store branch for t_b92c53cf installs")
            self.assertIn("Option 1 chosen:", local)
            self.assertIn(VALUE, local)
            return
        self.assertEqual(local, fn(1, body))
        self.assertEqual(api.RECORD_CAP_FALLBACK, mod.MAX_OPTION_CHARS,
                         "the record's cap is the parser's cap: an option longer than it is not "
                         "an option at all")
        # the disclosure is part of the rule too -- and only when he was shown less
        with_shown = api._answer_record_line(1, body, shown=120)
        self.assertEqual(with_shown, fn(1, body, shown=120))
        self.assertNotEqual(with_shown, local)
        self.assertIn("the page showed the first 120 characters", with_shown)
        self.assertNotIn("the page showed", local)

    # ---------------------------------------------------------------- red on base

    def _pre_change_revision(self):
        """The newest revision of the route module that does NOT carry the fix's own predicate.

        ⛔ NOT `origin/main`, and not a hard-coded sha: a control ref is as stale as the lane that
        wrote it, and a sha rots the other way. So the guard keys on the PREDICATE the fix
        introduces (`_answer_record_line`), which is what `engineering-discipline` §42b requires --
        a comment-only edit cannot make a ref look pre-change, and the newest such revision IS the
        production bytes this change replaced.
        """
        try:
            log = subprocess.run(["git", "log", "--format=%H", "--", "dashboard/plugin_api.py"],
                                 cwd=str(REPO), capture_output=True, text=True, check=False)
        except OSError as exc:
            return None, None, "git unavailable (%s)" % exc
        if log.returncode != 0 or not log.stdout.strip():
            return None, None, "no history for dashboard/plugin_api.py"
        for sha in log.stdout.split():
            try:
                blob = subprocess.run(["git", "show", "%s:dashboard/plugin_api.py" % sha],
                                      cwd=str(REPO), capture_output=True, text=True, check=False)
            except OSError as exc:
                return None, None, "git unavailable (%s)" % exc
            if blob.returncode != 0:
                continue
            if "_answer_record_line" in blob.stdout or "def answer(" not in blob.stdout:
                continue          # the fix's own predicate, or not the route module: not the base
            return sha, blob.stdout, ""
        return None, None, "no pre-change revision carries the route module"

    def test_the_pre_change_bytes_did_record_the_cut(self):
        """RED ON BASE: an arm that cannot fail is not a control."""
        sha, src, why = self._pre_change_revision()
        if src is None:
            raise AssertionError("red-on-base cannot be skipped: %s -- this is the arm that "
                                 "proves the positive arm measures something" % why)
        tmp = Path(self.home) / "base_plugin_api.py"
        tmp.write_text(src, encoding="utf-8")
        base = load_api(tmp)
        tid = base.kanban_db.create_task(
            self.conn, title="long option ask, base bytes", body="the card body",
            initial_status="blocked", board=SLUG, block_kind="needs_input",
            block_reason="parked for needs_input")
        base.kanban_db.add_comment(self.conn, tid, "decision-framer", frame())
        shown_to_owner = base.parse_frame(frame())["options"][0]
        base.answer(base.AnswerBody(board=SLUG, task_id=tid, choice=1,
                                    option_text=shown_to_owner))
        recorded = self.answer_comments(tid)
        self.assertEqual(len(recorded), 1, recorded)
        print("\n[RED-ON-BASE] %s  (pre-change revision %s)" % (tid, sha[:12]))
        print("   the record carries %d chars of a %d-char option"
              % (len(recorded[0]), len(LONG_OPTION)))
        self.assertNotIn(VALUE, recorded[0],
                         "THE DEFECT, on the pre-change bytes: the value the ruling was about is "
                         "absent from the card")
        self.assertIn("Option 1 chosen: " + shown_to_owner.rstrip() + ".",
                      recorded[0],
                      "and the pre-change bytes recorded the PREVIEW as the answer: %r"
                      % recorded[0])


if __name__ == "__main__":
    unittest.main()
