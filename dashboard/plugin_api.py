"""Mission Control — backend routes, mounted at ``/api/plugins/mission-control/``.

Reads (cheap, read-only SQLite over every kanban board + every profile's cron store):
what is running, what is parked on Jesse, what shipped today, what is scheduled.

Writes are exactly three owner actions, all routed through ``hermes_cli.kanban_db`` — the
same code path the CLI and the bundled kanban plugin use, so the surfaces cannot drift:

    POST /answer   comment on a card as the owner, then (by default) ``unblock_task`` it
    POST /comment  comment on a card as the owner, no state change
    POST /assign   give an ownerless card a real lane (``assign_task``, so the event is recorded)

The "waiting on you" list uses the SAME framing contract as ``hermes-decision-nag.py``: a
comment containing ``## OPTIONS FOR THE OWNER``, 2-4 contiguous numbered options, and a
``**RECOMMENDATION: N**`` line. A card is pickable here exactly when the nag can send it,
so the dashboard and the nagger never disagree about what is a real owner ask.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from hermes_cli import kanban_db
from hermes_cli import kanban_db_connect as kbc
import subprocess
import sys
import threading

log = logging.getLogger(__name__)

router = APIRouter()

_FRAME_MARKER = "OPTIONS FOR THE OWNER"
_REC_RE = re.compile(r"\*\*RECOMMENDATION:\s*(\d+)\*\*")
_OPT_RE = re.compile(r"^\s*(\d+)[.)]\s+(.*)$")
_HUMAN_HINT_RE = re.compile(r"\bjesse\b|\bowner\b|\byour call\b|\bneeds your\b", re.I)

# The ask-queue exclusion module (kanban t_3d6ec309), resolved lazily by `_ask_filter()`:
# the imported module, or False once we have looked and failed. Never a bare None check --
# False means "looked and could not", which must not be re-attempted per request.
_ASK_FILTER = None

OPTION_PREVIEW_CHARS = 260
ASK_PREVIEW_CHARS = 700

# Cheap, honest triage tags for the ask text — a label, not a classification to trust blindly.
_HINT_PATTERNS = (
    ("deadline", re.compile(r"\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|"
                            r"\b\d{4}-\d{2}-\d{2}\b|\bdeadline\b|\bdue\b", re.I)),
    ("credential", re.compile(r"\bkey\b|\btoken\b|\bcredential|\brotate\b|\bpassword\b|\bre-?auth", re.I)),
    ("money", re.compile(r"\b\$|\binvoice\b|\bpayment\b|\bpricing\b|\bcontract\b|\bbudget\b", re.I)),
    ("decision", re.compile(r"\bdecide\b|\bdecision\b|\bchoose\b|\boption\b|\bdirection\b|\bapprove", re.I)),
)


def _hints(ask: Optional[str], title: Optional[str]) -> list[str]:
    text = f"{title or ''}\n{ask or ''}"
    return [name for name, rx in _HINT_PATTERNS if rx.search(text)]


# --- locations ---------------------------------------------------------------

def _hermes_home() -> Path:
    """Machine-level Hermes home (the dashboard runs as the default profile)."""
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env)
    try:
        from hermes_constants import get_hermes_home

        return Path(_hermes_home())
    except Exception:
        return Path.home() / ".hermes"


def _boards() -> list[dict[str, Any]]:
    """Every kanban board on this box: ``kanban_db.list_boards`` order (``default`` first).

    Delegates to the library — the SAME enumeration the CLI and the bundled kanban plugin use —
    instead of hand-rolling a scan of ``kanban/boards/*``. A hand-rolled scan silently dropped the
    DEFAULT board, whose DB lives at ``<hermes home>/kanban.db`` (outside ``boards/``) and which is
    a live board: measured 2026-09-17 it holds 127 cards, 3 running and 18 blocked, because the root
    profile's cron jobs file their work there. Every page on this plugin was blind to all of it.
    The dir scan is kept as a fallback only.
    """
    out: list[dict[str, Any]] = []
    try:
        entries = kanban_db.list_boards(include_archived=False)
    except Exception:  # never take the dashboard down over an enumeration quirk
        log.warning("kanban_db.list_boards failed; falling back to the boards/ dir scan", exc_info=True)
        entries = []
    for e in entries:
        db = e.get("db_path")
        if not db or not Path(db).is_file():
            continue
        out.append({"slug": e["slug"], "title": e.get("name") or e["slug"], "path": str(db)})
    if out:
        return out
    root = _hermes_home() / "kanban" / "boards"
    if not root.is_dir():
        return out
    for d in sorted(root.iterdir()):
        db = d / "kanban.db"
        if not db.is_file():
            continue
        title = d.name
        meta_path = d / "board.json"
        if meta_path.is_file():
            try:
                meta = json.loads(meta_path.read_text())
                title = meta.get("title") or meta.get("name") or title
            except Exception:
                pass
        out.append({"slug": d.name, "title": title, "path": str(db)})
    return out


def _board_title(slug: str) -> str:
    return next((b["title"] for b in _boards() if b["slug"] == slug), slug)


def _ro(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=8)
    conn.row_factory = sqlite3.Row
    return conn


def _q(conn: sqlite3.Connection, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
    return conn.execute(sql, args).fetchall()


def _q1(conn: sqlite3.Connection, sql: str, args: tuple = ()) -> Optional[sqlite3.Row]:
    rows = conn.execute(sql, args).fetchone()
    return rows


def _now() -> int:
    return int(time.time())


def _today_start() -> int:
    n = datetime.now(timezone.utc)
    return int(datetime(n.year, n.month, n.day, tzinfo=timezone.utc).timestamp())


def _iso(ts: Any) -> Optional[str]:
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(int(ts), timezone.utc).isoformat()
    except Exception:
        return None


def _int_or_none(value: Any) -> Optional[int]:
    """Coerce a kanban timestamp to int, or None.

    ``worker_started_at`` is NOT a timestamp and never was: it holds the PID-reuse fingerprint
    ``"<boot epoch>|<proc start tick>"`` written by ``kanban_db_dispatch._set_worker_pid``
    (e.g. ``'5edae10e-...:60|20617508'``), so keep using this guard — but for elapsed/staleness
    read ``task_runs.started_at`` or ``tasks.last_heartbeat_at`` instead."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _reason_from_payload(payload: Optional[str]) -> Optional[str]:
    if not payload:
        return None
    try:
        data = json.loads(payload)
    except Exception:
        return None
    if isinstance(data, dict):
        for key in ("reason", "detail", "message", "ask"):
            val = data.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    return None


def parse_frame(text: Optional[str]) -> dict[str, Any]:
    """Mirror ``hermes-decision-nag.py``'s framing parser.

    Contiguous numbered options starting at 1 (2-4 of them) after the marker, plus an
    optional ``**RECOMMENDATION: N**``. Anything else is not a framed owner ask.
    """
    out: dict[str, Any] = {"framed": False, "options": [], "recommendation": None,
                           "summary": None, "raw": None}
    if not text or _FRAME_MARKER not in text:
        return out
    tail = text.split(_FRAME_MARKER, 1)[1]
    numbers: list[int] = []
    texts: list[str] = []
    for line in tail.splitlines():
        m = _OPT_RE.match(line)
        if m:
            numbers.append(int(m.group(1)))
            texts.append(m.group(2).strip())
    contiguous = bool(numbers) and numbers == list(range(1, len(numbers) + 1))
    if not (contiguous and 2 <= len(numbers) <= 4):
        return out
    rec = _REC_RE.search(tail)
    summary = None
    for line in tail.splitlines()[1:]:
        s = line.strip()
        if s and not _OPT_RE.match(s) and not s.startswith("#"):
            summary = s
            break
    out.update({
        "framed": True,
        "options": [t[:OPTION_PREVIEW_CHARS] for t in texts],
        "recommendation": int(rec.group(1)) if rec and 1 <= int(rec.group(1)) <= len(numbers) else None,
        "summary": (summary or "")[:ASK_PREVIEW_CHARS] or None,
        "raw": tail.strip()[:4000],
    })
    return out


# --- schedule store ----------------------------------------------------------

def _read_jobs_file(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text())
    except Exception:
        log.warning("mission-control: unreadable cron store %s", path)
        return []
    jobs = data.get("jobs", data) if isinstance(data, dict) else data
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    return jobs if isinstance(jobs, list) else []


def _schedules() -> dict[str, Any]:
    home = _hermes_home()
    sources = [("(default)", home / "cron" / "jobs.json")]
    proot = home / "profiles"
    if proot.is_dir():
        for p in sorted(proot.iterdir()):
            if p.is_dir():
                sources.append((p.name, p / "cron" / "jobs.json"))
    jobs: list[dict[str, Any]] = []
    for profile, path in sources:
        for j in _read_jobs_file(path):
            if not isinstance(j, dict):
                continue
            sched = j.get("schedule")
            expr = None
            if isinstance(sched, dict):
                expr = sched.get("display") or sched.get("expr")
            jobs.append({
                "profile": profile,
                "id": j.get("id"),
                "name": j.get("name"),
                "schedule": expr or j.get("schedule_display"),
                "enabled": bool(j.get("enabled", True)),
                "state": j.get("state"),
                "next_run_at": j.get("next_run_at"),
                "last_run_at": j.get("last_run_at"),
                "last_status": j.get("last_status"),
                "last_error": (j.get("last_error") or None),
                "failure_streak": int(j.get("failure_streak") or 0),
                "deliver": j.get("deliver"),
                "failure_deliver": j.get("failure_deliver"),
                "no_agent": bool(j.get("no_agent")),
            })
    failing = [j for j in jobs if j["failure_streak"] > 0 or (j["last_status"] and j["last_status"] not in ("ok", "silent"))]
    upcoming = sorted([j for j in jobs if j["enabled"] and j["next_run_at"]], key=lambda j: str(j["next_run_at"]))
    return {
        "jobs": jobs,
        "total": len(jobs),
        "enabled": sum(1 for j in jobs if j["enabled"]),
        "failing": failing,
        "upcoming": upcoming[:14],
    }


# --- board reads -------------------------------------------------------------

_AWAITING_SQL = """
SELECT t.id, t.title, t.assignee, t.status, t.block_kind, t.created_at, t.priority,
       t.project_id, t.consecutive_failures,
       (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) AS comments
  FROM tasks t
 WHERE t.block_kind = 'needs_input' AND t.status IN ('blocked', 'triage')
 ORDER BY t.created_at DESC
"""


def _chunks(seq: list, size: int = 400):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def _frame_bodies(conn: sqlite3.Connection, ids: list[str]) -> dict[str, str]:
    """Newest framed-ask comment per task, for EVERY parked card — not just the newest few.

    Owner asks are not recency-ordered: the nag keeps asking a card parked three days ago, and a
    windowed fetch silently reports "nothing for you" while the ask exists. Batched IN() keeps this
    to a couple of queries even with a few hundred parks.
    """
    out: dict[str, str] = {}
    for chunk in _chunks(ids):
        marks = ",".join("?" * len(chunk))
        for row in conn.execute(
            f"SELECT task_id, body FROM task_comments "
            f"WHERE task_id IN ({marks}) AND body LIKE '%OPTIONS FOR THE OWNER%' ORDER BY id", chunk):
            out[row["task_id"]] = row["body"]  # last wins == newest
    return out


def _ask_reasons(conn: sqlite3.Connection, ids: list[str],
                 payloads: Optional[dict[str, str]] = None) -> dict[str, str]:
    """The ASK text per task: the reason on the card's NEWEST PARK EVENT (kanban t_68504b12).

    ⛔ NOT ``kind='blocked'`` ALONE. A park's reason is the newest of ``blocked``,
    ``block_retyped`` and ``block_loop_detected`` — the same triple
    ``owner_ask_filter.park_sql`` and ``hermes-decision-nag.BLOCKED_REASON_SQL`` read, and
    the one `engineering-discipline` §44 states. Reading ``blocked`` alone returns a
    SUPERSEDED park and fails SILENTLY: it did, on 2026-09-19, when an ``eng-worker`` test
    park was followed 9 s later by a ``block_loop_detected`` carrying the real reason and
    this page showed the owner the literal test string "short kinded reason" as THE ASK on
    `t_72e36f3f` — a live production-secret decision.

    It reads through ``_park_payloads`` — the reader ``_awaiting_for_board`` already uses to
    decide WHETHER to show a card — so the page cannot decide from one read and render from
    another, and there is exactly ONE kind list in this file. `payloads` may be passed in
    when the caller has already read them, so the two consumers share one query.

    A task whose newest park carries no readable reason is ABSENT from the result (the page
    renders "(none recorded)") rather than falling back to a superseded older text.
    """
    if payloads is None:
        payloads = _park_payloads(conn, ids)
    out: dict[str, str] = {}
    for tid in ids:
        reason = _reason_from_payload(payloads.get(tid))
        if reason:
            out[tid] = reason
    return out


def _briefing(board: str, board_title: str, task_id: str, title: str, status: str, block_kind: str,
              age_seconds: Optional[int], asked_by: Optional[str], ask: Optional[str],
              options: Optional[list[str]] = None, recommendation: Optional[int] = None) -> str:
    """A paste-ready handoff: everything a chat agent needs to discuss this card with Jesse.

    Lives server-side so the dashboard button, any future surface, and a curl all produce the same
    text — and so it is testable without a browser.
    """
    hours = (age_seconds or 0) / 3600.0
    age = f"{hours:.1f}h" if hours < 48 else f"{hours / 24:.1f}d"
    lines = [
        f"MISSION CONTROL HANDOFF — card {task_id} on board {board} ({board_title})",
        f"Title: {title}",
        f"State: {status}" + (f"/{block_kind}" if block_kind else "") +
        f" · parked {age} ago · parked by {asked_by or 'unknown'}",
    ]
    if options:
        lines.append("")
        lines.append("Options this card already frames for me:")
        for i, opt in enumerate(options, 1):
            mark = "  <-- the card's RECOMMENDATION" if recommendation == i else ""
            lines.append(f"  {i}. {opt}{mark}")
    lines += [
        "",
        "THE ASK (verbatim — the reason on the card's NEWEST park event: blocked, "
        "block_retyped or block_loop_detected):",
        (ask or "(no park reason recorded)"),
        "",
        "My question: explain in plain language what this card is actually about, which project or "
        "system it belongs to, and whether it is genuinely mine to decide — then tell me what you "
        "would do and why.",
        "",
        "If I give you a decision, record it on this card as a comment and unblock it so the owning "
        "profile picks the work back up.",
        f"Inspect it yourself with: hermes kanban --board {board} show {task_id}",
    ]
    return "\n".join(lines)


def _ask_filter():
    """The ask queue's THREE exclusions, imported from the scripts store by IDENTITY.

    ⛔ ONE IMPLEMENTATION, FOUR CONSUMERS. `hermes-decision-nag.py`,
    `decision-framer-facts.py` and `hermes-decision-brief.py` all import
    `<hermes home>/scripts/lib/owner_ask_filter.py` (kanban t_3d6ec309); this page reads
    the SAME file rather than a fifth copy of the predicates. Before this, the module's
    docstring here claimed the dashboard and the nag "never disagree about what is a real
    owner ask" — and they did: this page had no publication exclusion at all, so the
    approved-awaiting-publication parks and any card the owner had ALREADY ANSWERED were
    still presented to him as decisions (measured 2026-09-18: `t_4870fc5f` was answered
    through this very page at 11:34Z and still listed).

    Returns None when the module cannot be imported — and then NOTHING is excluded, which
    is the safe direction (the page shows more than it should, never less): a page that
    silently hid a real ask would be the worse failure. The warning is logged once.
    """
    global _ASK_FILTER
    if _ASK_FILTER is None:
        for lib_dir in _scripts_lib_dirs():
            try:
                if str(lib_dir) not in sys.path:
                    sys.path.insert(0, str(lib_dir))
                import owner_ask_filter  # noqa: PLC0415
                _ASK_FILTER = owner_ask_filter
                log.info("owner ask-queue exclusions loaded from %s", lib_dir)
                break
            except Exception:
                continue
        if _ASK_FILTER is None:
            log.warning("owner_ask_filter could not be imported; 'Waiting on Me' will show "
                        "answered / publication-parked / duplicate cards (no exclusion)")
            _ASK_FILTER = False
    return _ASK_FILTER or None


def _scripts_lib_dirs() -> list[Path]:
    """Where `lib/owner_ask_filter.py` can live, machine-level home first.

    The dashboard can run with a PROFILE home (`--profile <p> serve`): a machine-level
    plugin would otherwise look for `<profile home>/scripts/lib`, which holds that
    profile's cron scripts and no `lib/`. Same normalisation the plugin already needs
    elsewhere: strip a trailing `/profiles/<p>`.
    """
    out: list[Path] = []

    def add(base: Path):
        p = base / "scripts" / "lib"
        if p not in out:
            out.append(p)

    env = os.environ.get("HERMES_HOME")
    if env:
        home = Path(env)
        parts = home.parts
        if "profiles" in parts:
            home = Path(*parts[:parts.index("profiles")]) or home
        add(home)
    add(Path.home() / ".hermes")
    add(_hermes_home())
    return out


_PARK_KINDS_FALLBACK = ("blocked", "block_retyped", "block_loop_detected")


def _park_kinds() -> tuple:
    """The park-event kinds, taken from the scripts store when it is importable.

    ⛔ ONE DEFINITION, MANY READERS. `owner_ask_filter.PARK_EVENT_KINDS` is what
    `hermes-decision-nag`, `decision-framer-facts`, `hermes-decision-brief` and
    `pr-promote-sweep` read. This page reads the SAME constant rather than a copy of the
    literal, so a park kind added to the queue cannot reach the queue and miss this page.
    The fallback is that same triple, so an unimportable module degrades to today's read
    and never to an empty one.
    """
    lib = _ask_filter()
    kinds = getattr(lib, "PARK_EVENT_KINDS", None) if lib is not None else None
    return tuple(kinds) if kinds else _PARK_KINDS_FALLBACK


def _park_payloads(conn: sqlite3.Connection, ids: list[str]) -> dict[str, str]:
    """Newest PARK-EVENT payload per task, over the SAME kinds the scripts read.

    A `block_retyped`/`block_loop_detected` event carries the caller's `reason` byte for
    byte (that is what a re-type in place and the unblock-loop breaker append), so a
    reader keyed on `blocked` alone reads a SUPERSEDED park — the same triple
    `owner_ask_filter.park_sql` builds for the scripts, imported via `_park_kinds()`.

    ⛔ This is the ONE park read in this file, and BOTH consumers share it: the exclusion
    predicates below (WHETHER to show a card) and `_ask_reasons` (WHAT to render as the
    ask). They read the same payload for the same task by construction.
    """
    out: dict[str, str] = {}
    kinds = ",".join("'%s'" % k for k in _park_kinds())
    for chunk in _chunks(ids):
        marks = ",".join("?" * len(chunk))
        latest = {r["task_id"]: r["mid"] for r in conn.execute(
            f"SELECT task_id, MAX(id) AS mid FROM task_events "
            f"WHERE kind IN ({kinds}) AND task_id IN ({marks}) GROUP BY task_id", chunk)}
        if not latest:
            continue
        ev = ",".join("?" * len(latest))
        by_id = {r["id"]: r["task_id"] for r in conn.execute(
            f"SELECT id, task_id FROM task_events WHERE id IN ({ev})", list(latest.values()))}
        for row in conn.execute(f"SELECT id, payload FROM task_events WHERE id IN ({ev})",
                                list(latest.values())):
            tid = by_id.get(row["id"])
            if tid:
                out[tid] = row["payload"]
    return out


def _comments_by_task(conn: sqlite3.Connection, ids: list[str],
                      per_task: int = 25) -> dict[str, list[tuple[str, str]]]:
    """The newest `per_task` comments per task, newest first — what the predicates read.

    Bounded on purpose. `hermes-decision-nag` reads 40 and this reads 25, and the
    asymmetry is in the SAFE direction only: a ruling recorded 30 comments deep is still
    caught by the nag (which then declines to ask) while this page may still list it —
    a page that shows one card too many, never one too few. Bodies are capped at 4 000
    chars for the same reason (a busy card's newest comment is routinely 40 KB).
    """
    out: dict[str, list[tuple[str, str]]] = {}
    for chunk in _chunks(ids):
        marks = ",".join("?" * len(chunk))
        for row in conn.execute(
                f"SELECT task_id, COALESCE(author,'') AS author, "
                f"substr(COALESCE(body,''),1,4000) AS body FROM task_comments "
                f"WHERE task_id IN ({marks}) ORDER BY id DESC", chunk):
            lst = out.setdefault(row["task_id"], [])
            if len(lst) < per_task:
                lst.append((row["author"], row["body"]))
    return out


def _awaiting_for_board(slug: str, db: str, limit: int) -> dict[str, Any]:
    """Every owner-facing park on this board, split into framed asks and un-framed parks.

    The whole park set is inspected for framing (cheap: two batched queries); item *detail* is
    capped so the payload stays small.
    """
    with closing(_ro(db)) as conn:
        rows = _q(conn, _AWAITING_SQL)
        all_ids = [r["id"] for r in rows]
        framed_bodies = _frame_bodies(conn, all_ids)
        payloads = _park_payloads(conn, all_ids)
        comments = _comments_by_task(conn, all_ids)

        # ⛔ THE ASK QUEUE'S THREE EXCLUSIONS, APPLIED HERE TOO (kanban t_3d6ec309).
        # This page is the surface the owner actually opens, and it was the LAST reader
        # without them: it showed every `needs_input` park whose card carried an OPTIONS
        # block, including cards he had already answered (through this very page) and
        # approved work whose only remaining act is a publication the release authority
        # owns. Same predicates as the nag, the framer and the brief -- imported, not
        # re-spelled. See `_ask_filter`.
        excluded: dict[str, str] = {}
        lib = _ask_filter()
        if lib is not None:
            for r in rows:
                if lib.publication_park(payloads.get(r["id"])):
                    excluded[r["id"]] = "publication-only"
                    continue
                if lib.ruling_evidence(comments.get(r["id"]) or ()):
                    excluded[r["id"]] = "already answered"
            # (3) DUPLICATE, over the survivors of THIS board: a twin is dropped only when
            # its carrier is still in this same list, so the question is shown once.
            linked = [{
                "key": "%s/%s" % (slug, r["id"]), "board": slug, "id": r["id"],
                "title": r["title"], "priority": r["priority"], "started_at": r["created_at"],
                "framed": r["id"] in framed_bodies,
                "declared": set(lib.declared_carriers(comments.get(r["id"]) or ())),
            } for r in rows if r["id"] not in excluded]
            folded = lib.dedupe(linked, {slug: [row["t"] or "" for row in _q(
                conn, "SELECT COALESCE(title,'') t FROM tasks")]})
            for key, carrier in folded.items():
                excluded[key.split("/", 1)[1]] = "duplicate of %s" % carrier
            rows = [r for r in rows if r["id"] not in excluded]

        by_id = {r["id"]: r for r in rows}
        framed_ids = [r["id"] for r in rows if r["id"] in framed_bodies]
        # preview budget: every framed ask (they are the point), then the newest un-framed parks
        preview_ids = framed_ids + [r["id"] for r in rows if r["id"] not in framed_bodies][:limit]
        reasons = _ask_reasons(conn, preview_ids, payloads=payloads)
        # named, never silently dropped: what this page declined to show, and why
        tally: dict[str, int] = {}
        for _tid, why in excluded.items():
            tally[why.split(" of ")[0]] = tally.get(why.split(" of ")[0], 0) + 1
        not_shown = {
            "count": len(excluded),
            "by_reason": tally,
            "named": sorted("%s/%s %s" % (slug, tid, why)
                            for tid, why in excluded.items())[:25],
        }

    def item(task_id: str) -> dict[str, Any]:
        r = by_id[task_id]
        body = framed_bodies.get(task_id)
        frame = parse_frame(body)
        ask = reasons.get(task_id)
        hinted = bool(ask and _HUMAN_HINT_RE.search(ask))
        bt = _board_title(slug)
        age = _now() - (_int_or_none(r["created_at"]) or _now())
        return {
            "board": slug,
            "board_title": bt,
            "id": r["id"],
            "title": r["title"],
            "assignee": r["assignee"],
            "status": r["status"],
            "created_at": _iso(r["created_at"]),
            "age_seconds": age,
            "ask": (ask or "")[:ASK_PREVIEW_CHARS] or None,
            "framed": frame["framed"],
            "options": frame["options"],
            "recommendation": frame["recommendation"],
            "summary": frame["summary"],
            "comments": int(r["comments"] or 0),
            "human_hint": hinted,
            "hints": _hints(ask, r["title"]),
            "priority": r["priority"],
            "briefing": _briefing(slug, bt, r["id"], r["title"], r["status"], "needs_input", age,
                                  r["assignee"], ask, frame["options"], frame["recommendation"]),
        }

    framed = [item(i) for i in framed_ids]
    parked = [item(i) for i in preview_ids if i not in set(framed_ids)]
    framed.sort(key=lambda i: -(i["age_seconds"] or 0))
    parked.sort(key=lambda i: (0 if i["human_hint"] else 1, -(i["age_seconds"] or 0)))
    return {
        "framed": framed,
        "framed_total": len(framed),
        "parked": parked,
        "parked_total": len(rows) - len(framed),
        # `total` is the board's REAL needs_input park count (what the board holds), so a
        # reader that wants "how many owner-facing parks exist" is not silently handed the
        # post-exclusion number; `excluded` names the difference.
        "total": len(rows) + len(excluded),
        "excluded": not_shown,
    }


def _board_summary(slug: str, db: str, pulse_from: int) -> dict[str, Any]:
    with closing(_ro(db)) as conn:
        counts = {r["status"]: r["c"] for r in _q(conn, "SELECT status, COUNT(*) c FROM tasks GROUP BY status")}
        running = _q(conn, """
            SELECT t.id, t.title, t.assignee, t.current_run_id,
                   t.last_heartbeat_at, t.priority, t.project_id, t.workspace_kind,
                   r.status AS run_status, r.outcome AS run_outcome, r.started_at AS run_started_at
              FROM tasks t LEFT JOIN task_runs r ON r.id = t.current_run_id
             WHERE t.status = 'running'
             ORDER BY COALESCE(r.started_at, t.last_heartbeat_at, 0)
        """)
        done_today = _q1(conn, "SELECT COUNT(*) c FROM tasks WHERE status='done' AND completed_at >= ?", (_today_start(),))
        created_today = _q1(conn, "SELECT COUNT(*) c FROM tasks WHERE created_at >= ?", (_today_start(),))
        recent_done = _q(conn, """
            SELECT id, title, assignee, completed_at, project_id,
                   (SELECT COUNT(*) FROM task_runs r WHERE r.task_id = t.id) AS runs
              FROM tasks t WHERE status='done' AND completed_at IS NOT NULL
             ORDER BY completed_at DESC LIMIT 10
        """)
        pulse = _q(conn, """
            SELECT (created_at/3600)*3600 AS bucket, COUNT(*) c FROM task_events
             WHERE created_at >= ? GROUP BY bucket ORDER BY bucket
        """, (pulse_from,))
        needs_framed = _q1(conn, """
            SELECT COUNT(DISTINCT t.id) c FROM tasks t JOIN task_comments c ON c.task_id = t.id
             WHERE t.block_kind='needs_input' AND t.status IN ('blocked','triage')
               AND c.body LIKE '%OPTIONS FOR THE OWNER%'
        """)
        boards_row = _q1(conn, "SELECT COUNT(*) c FROM tasks WHERE block_kind='capability' AND status='blocked'")
    in_flight = []
    now = _now()
    for r in running:
        # NEVER worker_started_at: that column holds the PID-reuse fingerprint
        # (kanban_db_dispatch._set_worker_pid), not a time. The CURRENT run's start is the real
        # elapsed basis; heartbeat age comes from last_heartbeat_at.
        started = _int_or_none(r["run_started_at"]) or _int_or_none(r["last_heartbeat_at"])
        hb = _int_or_none(r["last_heartbeat_at"])
        in_flight.append({
            "board": slug,
            "id": r["id"],
            "title": r["title"],
            "profile": r["assignee"],
            "run_id": r["current_run_id"],
            "run_status": r["run_status"],
            "elapsed_seconds": (now - started) if started else None,
            "heartbeat_age_seconds": (now - hb) if hb else None,
            "workspace_kind": r["workspace_kind"],
            "project_id": r["project_id"],
        })
    return {
        "slug": slug,
        "counts": counts,
        "running": in_flight,
        "done_today": int(done_today["c"] if done_today else 0),
        "created_today": int(created_today["c"] if created_today else 0),
        "recent_done": [{
            "board": slug, "id": r["id"], "title": r["title"], "assignee": r["assignee"],
            "completed_at": _iso(r["completed_at"]), "runs": int(r["runs"] or 0),
            "project_id": r["project_id"],
        } for r in recent_done],
        "pulse": [{"bucket": _iso(r["bucket"]), "count": r["c"]} for r in pulse],
        "needs_input": int((counts.get("blocked", 0) + counts.get("triage", 0))),
        "needs_input_framed": int(needs_framed["c"] if needs_framed else 0),
        "blocked_capability": int(boards_row["c"] if boards_row else 0),
    }


# --- endpoints ---------------------------------------------------------------

@router.get("/overview")
def overview(awaiting_limit: int = Query(25, ge=1, le=200)):
    """Everything the landing view needs, in one round trip."""
    awaiting_limit = _int_or_none(awaiting_limit) or 25
    now = _now()
    pulse_from = now - 12 * 3600
    boards = _boards()
    summaries = [_board_summary(b["slug"], b["path"], pulse_from) for b in boards]
    need_you: list[dict[str, Any]] = []
    parked: list[dict[str, Any]] = []
    awaiting_total = 0
    for b in boards:
        part = _awaiting_for_board(b["slug"], b["path"], awaiting_limit)
        need_you.extend(part["framed"])
        parked.extend(part["parked"])
        awaiting_total += part["total"]
    need_you.sort(key=lambda i: -(i["age_seconds"] or 0))
    parked.sort(key=lambda i: (0 if i["human_hint"] else 1, -(i["age_seconds"] or 0)))
    in_flight = [c for s in summaries for c in s["running"]]
    recent_done = [c for s in summaries for c in s["recent_done"]]
    recent_done.sort(key=lambda c: c["completed_at"] or "", reverse=True)
    pulse = []
    if summaries:
        buckets: dict[str, int] = {}
        for s in summaries:
            for p in s["pulse"]:
                if p["bucket"]:
                    buckets[p["bucket"]] = buckets.get(p["bucket"], 0) + p["count"]
        pulse = [{"bucket": k, "count": buckets[k]} for k in sorted(buckets)]
    sched = _schedules()
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "boards": summaries,
        "awaiting": {
            "framed": need_you,
            "framed_total": len(need_you),
            "parked": parked,
            "parked_total": max(0, awaiting_total - len(need_you)),
            "total": awaiting_total,
        },
        "in_flight": in_flight,
        "recent_done": recent_done[:14],
        "totals": {
            "running": len(in_flight),
            "done_today": sum(s["done_today"] for s in summaries),
            "created_today": sum(s["created_today"] for s in summaries),
            "needs_input": awaiting_total,
            "framed": len(need_you),
            "blocked_capability": sum(s["blocked_capability"] for s in summaries),
        },
        "pulse": pulse,
        "schedules": {
            "total": sched["total"],
            "enabled": sched["enabled"],
            "failing": sched["failing"],
            "upcoming": sched["upcoming"],
        },
    }


@router.get("/card")
def card(board: str, task_id: str = Query(..., alias="id")):
    """One card: body, the newest ask, parsed options, comment thread, runs, links."""
    b = next((x for x in _boards() if x["slug"] == board), None)
    if not b:
        raise HTTPException(status_code=404, detail=f"board {board!r} not found")
    with closing(_ro(b["path"])) as conn:
        t = _q1(conn, "SELECT * FROM tasks WHERE id = ?", (task_id,))
        if t is None:
            raise HTTPException(status_code=404, detail=f"task {task_id} not found")
        comments = _q(conn, """
            SELECT id, author, body, created_at FROM task_comments
             WHERE task_id = ? ORDER BY id DESC LIMIT 25
        """, (task_id,))
        runs = _q(conn, """
            SELECT id, profile, status, outcome, started_at, ended_at, summary, error
              FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT 6
        """, (task_id,))
        events = _q(conn, """
            SELECT id, kind, payload, created_at FROM task_events
             WHERE task_id = ? AND kind != 'heartbeat' ORDER BY id DESC LIMIT 25
        """, (task_id,))
        parents = _q(conn, """
            SELECT t.id, t.title, t.status FROM tasks t JOIN task_links l ON l.parent_id = t.id
             WHERE l.child_id = ?
        """, (task_id,))
        children = _q(conn, """
            SELECT t.id, t.title, t.status FROM tasks t JOIN task_links l ON l.child_id = t.id
             WHERE l.parent_id = ?
        """, (task_id,))
    ask = _reason_from_payload(next((e["payload"] for e in events if e["kind"] == "blocked"), None))
    frame_body = next((c["body"] for c in comments if c["body"] and _FRAME_MARKER in c["body"]), None)
    frame = parse_frame(frame_body)
    bt = b["title"]
    age = _now() - (_int_or_none(t["created_at"]) or _now())
    return {
        "board": board,
        "board_title": bt,
        "task": {
            "id": t["id"], "title": t["title"], "body": t["body"], "status": t["status"],
            "assignee": t["assignee"], "priority": t["priority"], "block_kind": t["block_kind"],
            "created_at": _iso(t["created_at"]), "started_at": _iso(t["started_at"]),
            "completed_at": _iso(t["completed_at"]), "result": t["result"],
            "consecutive_failures": t["consecutive_failures"],
            "last_failure_error": t["last_failure_error"],
            "workspace_kind": t["workspace_kind"], "workspace_path": t["workspace_path"],
            "branch_name": t["branch_name"], "project_id": t["project_id"],
        },
        "ask": ask,
        "frame": frame,
        "hints": _hints(ask, t["title"]),
        "briefing": _briefing(board, bt, t["id"], t["title"], t["status"], t["block_kind"], age,
                              t["assignee"], ask, frame["options"], frame["recommendation"]),
        "comments": [{"id": c["id"], "author": c["author"], "body": c["body"],
                      "created_at": _iso(c["created_at"])} for c in comments],
        "runs": [{"id": r["id"], "profile": r["profile"], "status": r["status"], "outcome": r["outcome"],
                  "started_at": _iso(r["started_at"]), "ended_at": _iso(r["ended_at"]),
                  "summary": r["summary"], "error": r["error"]} for r in runs],
        "events": [{"id": e["id"], "kind": e["kind"], "reason": _reason_from_payload(e["payload"]),
                    "created_at": _iso(e["created_at"])} for e in events],
        "parents": [dict(p) for p in parents],
        "children": [dict(c) for c in children],
    }


@router.get("/feed")
def feed(minutes: int = Query(180, ge=5, le=2880), limit: int = Query(60, ge=5, le=400)):
    """The live work feed: non-heartbeat events across every board, newest first."""
    minutes = _int_or_none(minutes) or 180
    limit = _int_or_none(limit) or 60
    since = _now() - minutes * 60
    rows: list[dict[str, Any]] = []
    for b in _boards():
        with closing(_ro(b["path"])) as conn:
            for e in _q(conn, """
                SELECT e.id, e.task_id, e.kind, e.payload, e.created_at, t.title, t.assignee
                  FROM task_events e LEFT JOIN tasks t ON t.id = e.task_id
                 WHERE e.created_at >= ? AND e.kind != 'heartbeat'
                 ORDER BY e.id DESC LIMIT ?
            """, (since, limit)):
                rows.append({
                    "board": b["slug"], "id": e["id"], "task_id": e["task_id"], "kind": e["kind"],
                    "title": e["title"], "assignee": e["assignee"],
                    "reason": (_reason_from_payload(e["payload"]) or "")[:300] or None,
                    "created_at": _iso(e["created_at"]),
                    "age_seconds": _now() - (_int_or_none(e["created_at"]) or _now()),
                })
    rows.sort(key=lambda r: r["id"], reverse=True)
    return {"minutes": minutes, "events": rows[:limit], "count": len(rows)}


# --- owner writes ------------------------------------------------------------

class AnswerBody(BaseModel):
    board: str
    task_id: str
    choice: Optional[int] = None
    text: Optional[str] = None
    option_text: Optional[str] = None
    unblock: bool = True


class CommentBody(BaseModel):
    board: str
    task_id: str
    body: str


def _write_conn(slug: str):
    if not any(b["slug"] == slug for b in _boards()):
        raise HTTPException(status_code=404, detail=f"board {slug!r} not found")
    kanban_db.init_db(board=slug)
    return kbc.connect(board=slug)


def _owner_comment(choice: Optional[int], option_text: Optional[str], text: Optional[str]) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [f"**OWNER DECISION** — answered from Mission Control ({stamp})", ""]
    if choice is not None:
        chosen = (option_text or "").strip()
        if chosen and chosen[-1] not in ".!?":
            chosen += "."
        lines.append(f"Option {choice} chosen" + (f": {chosen}" if chosen else "."))
    if text and text.strip():
        lines.append("")
        lines.append(text.strip())
    return "\n".join(lines)


@router.post("/answer")
def answer(body: AnswerBody):
    """Record the owner's answer on the card and (by default) re-open it for dispatch."""
    if body.choice is None and not (body.text and body.text.strip()):
        raise HTTPException(status_code=400, detail="provide a choice and/or text")
    with closing(_write_conn(body.board)) as conn:
        task = kanban_db.get_task(conn, body.task_id)
        if task is None:
            raise HTTPException(status_code=404, detail=f"task {body.task_id} not found")
        before = task.status
        comment_id = kanban_db.add_comment(
            conn, body.task_id, "jesse",
            _owner_comment(body.choice, body.option_text, body.text),
        )
        after = before
        if body.unblock and before in ("blocked", "scheduled"):
            ok = kanban_db.unblock_task(conn, body.task_id)
            if not ok:
                raise HTTPException(status_code=409, detail="unblock refused (state changed?)")
            reread = kanban_db.get_task(conn, body.task_id)
            after = reread.status if reread else "?"
        final = kanban_db.get_task(conn, body.task_id)
    return {"ok": True, "comment_id": comment_id, "status_before": before, "status_after": after,
            "block_kind": (final.block_kind if final else None)}


@router.post("/comment")
def comment(body: CommentBody):
    """Comment on a card as the owner, changing no state."""
    if not body.body.strip():
        raise HTTPException(status_code=400, detail="empty comment")
    with closing(_write_conn(body.board)) as conn:
        if kanban_db.get_task(conn, body.task_id) is None:
            raise HTTPException(status_code=404, detail=f"task {body.task_id} not found")
        cid = kanban_db.add_comment(conn, body.task_id, "jesse", body.body.strip())
    return {"ok": True, "comment_id": cid}


_AGING_BUCKETS = ((3600, "< 1h"), (6 * 3600, "1–6h"), (24 * 3600, "6–24h"),
                  (3 * 86400, "1–3d"), (float("inf"), "> 3d"))


def _bucketize(ages: list[int]) -> list[dict[str, Any]]:
    out = [{"label": label, "count": 0} for _, label in _AGING_BUCKETS]
    for age in ages:
        for i, (limit, _label) in enumerate(_AGING_BUCKETS):
            if age <= limit:
                out[i]["count"] += 1
                break
    return out


def _pct(values: list[int], q: float) -> Optional[int]:
    if not values:
        return None
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(len(ordered) * q))
    return ordered[idx]


@router.get("/waiting")
def waiting(parked_limit: int = Query(400, ge=0, le=2000)):
    """The owner's inbox, in full: every framed ask, then the other parks."""
    raw = _int_or_none(parked_limit)
    limit = 400 if raw is None else raw
    framed: list[dict[str, Any]] = []
    parked: list[dict[str, Any]] = []
    totals = {"framed": 0, "parked": 0, "needs_input": 0, "excluded": 0}
    not_shown: list[str] = []
    excluded_by_reason: dict[str, int] = {}
    by_board: list[dict[str, Any]] = []
    for b in _boards():
        part = _awaiting_for_board(b["slug"], b["path"], limit)
        framed.extend(part["framed"])
        parked.extend(part["parked"])
        totals["framed"] += part["framed_total"]
        totals["parked"] += part["parked_total"]
        totals["needs_input"] += part["total"]
        exc = part.get("excluded") or {}
        totals["excluded"] += int(exc.get("count") or 0)
        not_shown.extend(exc.get("named") or [])
        for reason, n in (exc.get("by_reason") or {}).items():
            excluded_by_reason[reason] = excluded_by_reason.get(reason, 0) + int(n)
        by_board.append({"slug": b["slug"], "title": b["title"],
                         "framed": part["framed_total"], "parked": part["parked_total"],
                         "excluded": int(exc.get("count") or 0)})
    framed.sort(key=lambda i: -(i["age_seconds"] or 0))
    parked.sort(key=lambda i: (0 if i["human_hint"] else 1, -(i["age_seconds"] or 0)))
    hints: dict[str, int] = {}
    for item in framed:
        for tag in item.get("hints") or []:
            hints[tag] = hints.get(tag, 0) + 1
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "framed": framed,
        "parked": parked,
        "totals": totals,
        "boards": by_board,
        "aging": _bucketize([int(i["age_seconds"] or 0) for i in framed]),
        "parked_aging": _bucketize([int(i["age_seconds"] or 0) for i in parked]),
        "tags": hints,
        # ⛔ WHAT THIS PAGE DID NOT SHOW, AND WHY. An ask removed from the owner's inbox
        # and recorded nowhere is the failure mode this estate keeps paying for ("detection
        # works; delivery does not"), so the exclusions are part of the payload: the count,
        # the reason tally, and the named cards (kanban t_3d6ec309). Same three classes the
        # nag and the brief apply: already answered, publication-only, duplicate of a
        # carrier that IS shown.
        "excluded": {"count": totals["excluded"], "by_reason": excluded_by_reason,
                     "named": sorted(not_shown)},
    }


@router.get("/insights")
def insights(hours: int = Query(48, ge=6, le=336)):
    """Aggregates for the visual page: throughput, what is stuck, who is working, what is failing."""
    hours = _int_or_none(hours) or 48
    now = _now()
    since = now - hours * 3600
    day = now - 86400
    boards = _boards()

    status_mix: dict[str, int] = {}
    blocked_kinds: dict[str, int] = {}
    per_board: list[dict[str, Any]] = []
    stuck_rows: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    created: dict[int, int] = {}
    completed: dict[int, int] = {}
    blocked_ev: dict[int, int] = {}
    runs_started = runs_done = 0
    durations: list[int] = []
    cycles: list[int] = []
    running_by_profile: dict[str, int] = {}
    done_by_profile: dict[str, int] = {}

    for b in boards:
        with closing(_ro(b["path"])) as conn:
            counts = {str(r["status"]): int(r["c"]) for r in _q(conn, "SELECT status, COUNT(*) c FROM tasks GROUP BY status")}
            for key, val in counts.items():
                status_mix[key] = status_mix.get(key, 0) + val
            for r in _q(conn, "SELECT block_kind, COUNT(*) c FROM tasks WHERE status IN ('blocked','triage') GROUP BY 1"):
                key = str(r["block_kind"] or "untyped")
                blocked_kinds[key] = blocked_kinds.get(key, 0) + int(r["c"])
            per_board.append({"slug": b["slug"], "title": b["title"], "counts": counts})

            for r in _q(conn, """
                SELECT t.id, t.title, t.assignee, COALESCE(t.block_kind,'untyped') AS kind,
                       COALESCE((SELECT MAX(e.created_at) FROM task_events e
                                  WHERE e.task_id = t.id AND e.kind = 'blocked'), t.created_at) AS since
                  FROM tasks t WHERE t.status IN ('blocked','triage')
            """):
                stuck_rows.append({
                    "board": b["slug"], "board_title": b["title"], "id": r["id"], "title": r["title"],
                    "assignee": r["assignee"], "kind": r["kind"],
                    "age_seconds": now - (_int_or_none(r["since"]) or now),
                })

            for r in _q(conn, """
                SELECT id, title, assignee, consecutive_failures, last_failure_error FROM tasks
                 WHERE consecutive_failures > 0 OR last_failure_error IS NOT NULL
                 ORDER BY consecutive_failures DESC, id DESC LIMIT 10
            """):
                failures.append({
                    "board": b["slug"], "id": r["id"], "title": r["title"], "assignee": r["assignee"],
                    "failures": int(r["consecutive_failures"] or 0),
                    "error": (r["last_failure_error"] or "")[:300] or None,
                })

            for r in _q(conn, "SELECT (created_at/3600)*3600 b, COUNT(*) c FROM tasks "
                              "WHERE created_at >= ? GROUP BY 1", (since,)):
                key = _int_or_none(r["b"])
                if key is not None:
                    created[key] = created.get(key, 0) + int(r["c"])
            for r in _q(conn, "SELECT (completed_at/3600)*3600 b, COUNT(*) c FROM tasks "
                              "WHERE completed_at >= ? GROUP BY 1", (since,)):
                key = _int_or_none(r["b"])
                if key is not None:
                    completed[key] = completed.get(key, 0) + int(r["c"])
            for r in _q(conn, "SELECT (created_at/3600)*3600 b, COUNT(*) c FROM task_events "
                              "WHERE kind='blocked' AND created_at >= ? GROUP BY 1", (since,)):
                key = _int_or_none(r["b"])
                if key is not None:
                    blocked_ev[key] = blocked_ev.get(key, 0) + int(r["c"])

            for r in _q(conn, "SELECT COUNT(*) c FROM task_runs WHERE started_at >= ?", (day,)):
                runs_started += int(r["c"] or 0)
            for r in _q(conn, "SELECT COUNT(*) c FROM task_runs WHERE ended_at >= ?", (day,)):
                runs_done += int(r["c"] or 0)
            for r in _q(conn, "SELECT started_at, ended_at FROM task_runs "
                              "WHERE ended_at IS NOT NULL AND started_at IS NOT NULL AND ended_at >= ?", (day,)):
                a, z = _int_or_none(r["started_at"]), _int_or_none(r["ended_at"])
                if a and z and z > a:
                    durations.append(z - a)
            for r in _q(conn, "SELECT created_at, completed_at FROM tasks "
                              "WHERE status='done' AND completed_at >= ? AND created_at IS NOT NULL", (day,)):
                a, z = _int_or_none(r["created_at"]), _int_or_none(r["completed_at"])
                if a and z and z > a:
                    cycles.append(z - a)
            for r in _q(conn, "SELECT assignee, COUNT(*) c FROM tasks WHERE status='running' GROUP BY 1"):
                running_by_profile[str(r["assignee"] or "unassigned")] = int(r["c"])
            for r in _q(conn, "SELECT assignee, COUNT(*) c FROM tasks WHERE status='done' AND completed_at >= ? GROUP BY 1", (day,)):
                done_by_profile[str(r["assignee"] or "unassigned")] = int(r["c"])

    spark: dict[int, int] = {}
    for b in boards:
        with closing(_ro(b["path"])) as conn:
            for r in _q(conn, "SELECT (created_at/600)*600 b, COUNT(*) c FROM task_events "
                              "WHERE created_at >= ? AND kind != 'heartbeat' GROUP BY 1", (now - 2 * 3600,)):
                key = _int_or_none(r["b"])
                if key is not None:
                    spark[key] = spark.get(key, 0) + int(r["c"])

    # what is parked on the owner — the other half of "what is going on"
    awaiting = {"framed": 0, "parked": 0, "oldest_seconds": 0}
    for b in boards:
        part = _awaiting_for_board(b["slug"], b["path"], 0)
        awaiting["framed"] += part["framed_total"]
        awaiting["parked"] += part["parked_total"]
        if part["framed"]:
            awaiting["oldest_seconds"] = max(awaiting["oldest_seconds"],
                                             max(int(i["age_seconds"] or 0) for i in part["framed"]))

    stuck_rows.sort(key=lambda r: -(r["age_seconds"] or 0))
    sched = _schedules()
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_hours": hours,
        "awaiting": awaiting,
        "status_mix": status_mix,
        "blocked_kinds": blocked_kinds,
        "boards": per_board,
        "throughput": [
            {"t": _iso(t), "created": created.get(t, 0), "completed": completed.get(t, 0),
             "blocked": blocked_ev.get(t, 0)}
            for t in sorted(set(list(created) + list(completed) + list(blocked_ev)))
        ],
        "stuck": {
            "total": len(stuck_rows),
            "aging": _bucketize([int(r["age_seconds"] or 0) for r in stuck_rows]),
            "aging_by_kind": {
                kind: _bucketize([int(r["age_seconds"] or 0) for r in stuck_rows if r["kind"] == kind])
                for kind in sorted({r["kind"] for r in stuck_rows})
            },
            "oldest": stuck_rows[:12],
        },
        "runs": {
            "started_24h": runs_started,
            "finished_24h": runs_done,
            "duration_median_s": _pct(durations, 0.5),
            "duration_p90_s": _pct(durations, 0.9),
            "measured": len(durations),
            "running_by_profile": running_by_profile,
            "done_24h_by_profile": done_by_profile,
        },
        "cycle": {"median_s": _pct(cycles, 0.5), "p90_s": _pct(cycles, 0.9), "measured": len(cycles)},
        "failures": failures,
        "spark": [{"t": _iso(t), "count": spark[t]} for t in sorted(spark)],
        "schedules": {
            "total": sched["total"],
            "enabled": sched["enabled"],
            "paused": sched["total"] - sched["enabled"],
            "failing": sched["failing"],
            "upcoming": sched["upcoming"][:10],
        },
    }


@router.get("/boards")
def boards():
    """Board list + per-board counts (cheap; used by the board filter)."""
    out = []
    for b in _boards():
        with closing(_ro(b["path"])) as conn:
            counts = {r["status"]: r["c"] for r in _q(conn, "SELECT status, COUNT(*) c FROM tasks GROUP BY status")}
        out.append({"slug": b["slug"], "title": b["title"], "counts": counts,
                    "total": sum(counts.values())})
    return {"boards": out}


@router.get("/card_any")
def card_any(card_id: str = Query(...)):
    """Find a card by id on ANY board and return exactly the /card payload.

    A bot writing the desktop's ``::card{id="…"}`` directive knows the card id but should not have to
    know (or state) which board it lives on; this resolves it by searching every board.
    """
    found = None
    for b in _boards():
        with closing(_ro(b["path"])) as conn:
            if _q1(conn, "SELECT 1 FROM tasks WHERE id = ?", (card_id,)):
                found = b
                break
    if not found:
        raise HTTPException(status_code=404, detail=f"card {card_id} not found on any board")
    return card(board=found["slug"], task_id=card_id)


@router.get("/estate")
def estate(hours: int = Query(24, ge=1, le=336)):
    """Per-bot scoreboard: is its schedule healthy, what is it running, what is parked on its plate.

    The union of every profile with a cron store, a running card, or an assigned card — so a bot with
    no schedule but a full plate is still visible, and vice versa.
    """
    hours = _int_or_none(hours) or 24
    since = _now() - hours * 3600
    jobs_by_profile: dict[str, list[dict[str, Any]]] = {}
    for job in _schedules()["jobs"]:
        jobs_by_profile.setdefault(str(job["profile"]), []).append(job)

    rows: dict[str, dict[str, Any]] = {}

    def entry(name: str) -> dict[str, Any]:
        return rows.setdefault(name, {
            "profile": name, "jobs": 0, "jobs_enabled": 0, "jobs_failing": 0,
            "last_status": None, "next_run_at": None, "last_error": None,
            "running": 0, "open": 0, "blocked": 0, "asks": 0, "done_window": 0,
        })

    for profile, jobs in jobs_by_profile.items():
        e = entry(profile)
        e["jobs"] = len(jobs)
        e["jobs_enabled"] = sum(1 for j in jobs if j["enabled"])
        failing = [j for j in jobs if j["failure_streak"] > 0
                   or (j["last_status"] and j["last_status"] not in ("ok", "silent"))]
        e["jobs_failing"] = len(failing)
        if failing:
            worst = max(failing, key=lambda j: j["failure_streak"])
            e["last_error"] = (worst.get("last_error") or "")[:240] or None
            e["last_status"] = worst.get("last_status")
        runs = [j for j in jobs if j.get("last_run_at")]
        if runs:
            newest = max(runs, key=lambda j: str(j["last_run_at"]))
            e["last_status"] = e["last_status"] or newest.get("last_status")
            e["last_run_at"] = newest.get("last_run_at")
        nxt = sorted([j for j in jobs if j["enabled"] and j["next_run_at"]], key=lambda j: str(j["next_run_at"]))
        e["next_run_at"] = nxt[0]["next_run_at"] if nxt else None

    for b in _boards():
        with closing(_ro(b["path"])) as conn:
            for r in _q(conn, """
                SELECT assignee,
                       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) running,
                       SUM(CASE WHEN status IN ('todo','ready','triage') THEN 1 ELSE 0 END) open,
                       SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) blocked,
                       SUM(CASE WHEN status IN ('blocked','triage') AND block_kind = 'needs_input' THEN 1 ELSE 0 END) asks,
                       SUM(CASE WHEN status = 'done' AND completed_at >= ? THEN 1 ELSE 0 END) done_window
                  FROM tasks WHERE assignee IS NOT NULL AND assignee != ''
                 GROUP BY assignee
            """, (since,)):
                e = entry(str(r["assignee"]))
                e["running"] += int(r["running"] or 0)
                e["open"] += int(r["open"] or 0)
                e["blocked"] += int(r["blocked"] or 0)
                e["asks"] += int(r["asks"] or 0)
                e["done_window"] += int(r["done_window"] or 0)

    # What each bot is FOR. Every profile carries a profile.yaml description whose first token is a
    # bracketed domain tag ("[TOS ENGINEERING] …") — the only machine-readable statement of purpose
    # in the estate, and without it a 63-profile scoreboard is just names and numbers.
    profiles_dir = _hermes_home() / "profiles"
    if profiles_dir.is_dir():
        for p in sorted(profiles_dir.iterdir()):
            if not p.is_dir() or p.name.startswith("."):
                continue
            e = entry(p.name)
            purpose, domain = None, None
            manifest = p / "profile.yaml"
            if manifest.is_file():
                raw = ""
                try:
                    import yaml

                    data = yaml.safe_load(manifest.read_text()) or {}
                    raw = str(data.get("description") or "").strip()
                except Exception:
                    raw = ""
                if not raw:  # fallback: a plain single-line description
                    for line in manifest.read_text().splitlines():
                        if line.startswith("description:"):
                            raw = line.split(":", 1)[1].strip().strip("'\"")
                            break
                if raw:
                    m = re.match(r"^\[([^\]]{2,40})\]\s*(.*)$", raw, re.S)
                    if m:
                        domain, raw = m.group(1).strip(), m.group(2).strip()
                    purpose = " ".join(raw.split())[:400] or None
            e["purpose"], e["domain"] = purpose, domain

    for e in rows.values():
        e.setdefault("purpose", None)
        e.setdefault("domain", None)

    items = sorted(rows.values(), key=lambda e: (-(e["jobs_failing"]), -(e["asks"]), -(e["running"]),
                                                 -(e["blocked"]), e["profile"]))
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_hours": hours,
        "profiles": items,
        "totals": {
            "profiles": len(items),
            "with_schedule": sum(1 for e in items if e["jobs"]),
            "failing": sum(1 for e in items if e["jobs_failing"]),
            "running": sum(e["running"] for e in items),
            "asks": sum(e["asks"] for e in items),
            "blocked": sum(e["blocked"] for e in items),
        },
    }


@router.get("/since")
def since(ts: int = Query(..., ge=0)):
    """What changed since *ts* — the 'since you last looked' panel.

    Three movements only: cards opened, cards finished, and cards newly parked *on the owner*
    (a newest blocked event with kind needs_input after ts). Everything else is noise here.
    """
    stamp = _int_or_none(ts) or 0
    opened: list[dict[str, Any]] = []
    finished: list[dict[str, Any]] = []
    parked: list[dict[str, Any]] = []
    for b in _boards():
        with closing(_ro(b["path"])) as conn:
            for r in _q(conn, """
                SELECT id, title, assignee, created_at FROM tasks
                 WHERE created_at >= ? ORDER BY created_at DESC LIMIT 40
            """, (stamp,)):
                opened.append({"board": b["slug"], "board_title": b["title"], "id": r["id"],
                               "title": r["title"], "assignee": r["assignee"], "at": _iso(r["created_at"])})
            for r in _q(conn, """
                SELECT id, title, assignee, completed_at FROM tasks
                 WHERE status = 'done' AND completed_at >= ? ORDER BY completed_at DESC LIMIT 40
            """, (stamp,)):
                finished.append({"board": b["slug"], "board_title": b["title"], "id": r["id"],
                                 "title": r["title"], "assignee": r["assignee"], "at": _iso(r["completed_at"])})
            for r in _q(conn, """
                SELECT t.id, t.title, t.assignee, MAX(e.created_at) AS at
                  FROM tasks t JOIN task_events e ON e.task_id = t.id
                 WHERE e.kind = 'blocked' AND e.created_at >= ?
                   AND t.status IN ('blocked','triage') AND t.block_kind = 'needs_input'
                 GROUP BY t.id ORDER BY at DESC LIMIT 40
            """, (stamp,)):
                parked.append({"board": b["slug"], "board_title": b["title"], "id": r["id"],
                               "title": r["title"], "assignee": r["assignee"], "at": _iso(r["at"])})
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "since": _iso(stamp),
        "counts": {"opened": len(opened), "finished": len(finished), "parked": len(parked)},
        "opened": opened,
        "finished": finished,
        "parked": parked,
    }


#: A card in one of these states is work somebody should be doing or deciding about right now.
#: ``running``/``done``/``archived`` are excluded: running has a claim, the others are behind us.
_ACTIONABLE_STATUSES = ("todo", "ready", "triage", "blocked")


def _lane_checker():
    """``callable(assignee) -> bool``: is this assignee a real lane? ``None`` when unknowable.

    Grounded in ``hermes_cli.profiles.profile_exists`` — the same predicate the dispatcher uses to
    decide whether it may spawn the assignee (``kanban_db_dispatch`` sends non-profile assignees to
    its ``skipped_nonspawnable`` bucket). ``None`` means the profile list could not be read, and the
    caller must then report only the cards that are unambiguously ownerless (blank assignee) rather
    than guessing which names are real.
    """
    try:
        from hermes_cli.profiles import profile_exists
    except Exception:
        log.warning("hermes_cli.profiles unavailable: unowned reports blank assignees only", exc_info=True)
        return None
    return profile_exists


@router.get("/unowned")
def unowned(limit: int = Query(60, ge=1, le=400)):
    """Work nobody is on: no assignee at all, or an assignee that is not a real lane.

    Two ways a card ends up ownerless and only the first is obvious. The second is the quieter one:
    the ``assignee`` column names something that is not a profile (``owner-request``, a typo, a
    retired bot), so the dispatcher refuses to spawn it and the card sits in ``ready`` forever.
    Both are listed, with ``reason`` saying which, so the queue is actionable by reading alone.
    """
    limit = _int_or_none(limit) or 60
    is_lane = _lane_checker()
    now = _now()
    items: list[dict[str, Any]] = []
    for b in _boards():
        with closing(_ro(b["path"])) as conn:
            for r in _q(conn, f"""
                SELECT id, title, status, COALESCE(block_kind,'') kind, created_at, priority,
                       COALESCE(TRIM(assignee),'') assignee
                  FROM tasks
                 WHERE status IN ({", ".join("?" * len(_ACTIONABLE_STATUSES))})
                 ORDER BY created_at ASC
            """, _ACTIONABLE_STATUSES):
                who = r["assignee"]
                if who:
                    if is_lane is None or is_lane(who):
                        continue  # a real lane owns it
                    reason = f"assignee {who!r} is not a profile"
                else:
                    reason = "no assignee"
                items.append({
                    "board": b["slug"], "board_title": b["title"], "id": r["id"], "title": r["title"],
                    "status": r["status"], "kind": r["kind"], "priority": r["priority"],
                    "assignee": who or None, "reason": reason,
                    "age_seconds": now - (_int_or_none(r["created_at"]) or now),
                })
    items.sort(key=lambda i: -(i["age_seconds"] or 0))
    by_board: dict[str, int] = {}
    for i in items:
        by_board[i["board_title"]] = by_board.get(i["board_title"], 0) + 1
    return {"generated_at": datetime.now(timezone.utc).isoformat(), "total": len(items),
            "shown": len(items[:limit]), "truncated": len(items) > limit,
            "non_lane_total": sum(1 for i in items if i["assignee"]),
            "lanes_known": is_lane is not None, "by_board": by_board, "items": items[:limit]}


class AssignBody(BaseModel):
    board: str
    task_id: str
    assignee: str


@router.post("/assign")
def assign(body: AssignBody):
    """Give a card an owner, through ``kanban_db.assign_task`` (the same path the CLI and the bundled
    kanban plugin use, so the assignment is recorded as an 'assigned' event like any other).

    The lane is checked first, and that check is the whole point of the button: the dispatcher refuses
    to spawn an assignee that is not a profile, so a typo here would park the card in ``ready``
    forever — recreating, one click at a time, the defect this queue exists to surface. A card that is
    running under a claim is refused by ``assign_task`` itself; that is a 409, not a 500.
    """
    who = (body.assignee or "").strip()
    if not who:
        raise HTTPException(status_code=400, detail="assignee required")
    is_lane = _lane_checker()
    if is_lane is not None and not is_lane(who):
        raise HTTPException(status_code=400, detail=f"{who!r} is not a profile on this box")
    with closing(_write_conn(body.board)) as conn:
        if kanban_db.get_task(conn, body.task_id) is None:
            raise HTTPException(status_code=404, detail=f"task {body.task_id} not found")
        try:
            ok = kanban_db.assign_task(conn, body.task_id, who)
        except RuntimeError as exc:  # claimed + running: assign_task refuses to yank it
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if not ok:
            raise HTTPException(status_code=409, detail="assign refused (state changed?)")
        after = kanban_db.get_task(conn, body.task_id)
    return {"ok": True, "task_id": body.task_id, "assignee": (after.assignee if after else who)}


#: Authors under which an owner answer is recorded, MEASURED across the live boards 2026-09-17.
#: There are three deliberate recorders and picking one of them understates the owner by more than
#: half — the first cut of this route keyed on 'jesse' alone and read 6 of 582 asks (1.0%) while the
#: same window carries the other two:
#:   * 'jesse'        — this plugin's own POST /answer and POST /comment (dashboard-typed answers);
#:   * 'owner'        — ~/.hermes/scripts/hermes-decision-answers.py, which records the owner's chat
#:                      reply verbatim as "**OWNER'S ANSWER, recorded verbatim.**";
#:   * 'owner-answer' — the same pattern written by hand/earlier lanes ("## OWNER DECIDED … verbatim").
#: NOT counted: 'owner-request' — measured as a swarm blackboard topology dump, not an answer at all.
#: The caller gets the list back as ``owner_authors`` so the number can never be read as wider than it
#: is; a comment under any other author (i.e. the ordinary case, a lane re-opening its own card) is
#: deliberately NOT an owner answer.
_OWNER_AUTHORS = ("jesse", "owner", "owner-answer")


@router.get("/attention")
def attention(days: int = Query(7, ge=1, le=90)):
    """How the owner-ask pipeline actually performs: filed, answered, and how long each waited.

    Two latencies, deliberately separate, because they answer two different questions:

    * ``median_wait_s`` pairs each ``blocked`` (needs_input) event with the first ``unblocked`` event
      after it on the same card — that interval is the real answer latency **whoever did the
      answering**, i.e. how long the ask waited before the estate moved on.
    * ``owner_median_wait_s`` pairs the same park with the first comment authored by the OWNER after
      it — how long the ask waited on the owner specifically. Its denominator is ``owner_answered``,
      never ``answered``: a park can be re-opened by the filing lane and never touched by the owner at
      all, and reporting the owner's latency against the estate's answer count would overstate the
      owner's throughput.

    ``owner_answers`` is the raw count of owner comments in the window (the floor under
    ``owner_answered``: an owner comment that is not tied to a park still counts there). An ask counts
    in the window it was FILED in, so a park from before the window answered inside it is not counted
    a second time. Because this plugin's answer button only shipped 2026-09-17 ~02:00Z, the
    'jesse'-authored part of the window is a floor: owner answers before that were recorded by the
    other two recorders.

    THE POPULATION IS NAMED, NOT ASSUMED: an owner comment is a comment under one of
    ``_OWNER_AUTHORS``, returned to the caller as ``owner_authors``. This measures "answered by the
    owner, by any recorded path", which is the honest reading of the card's question ("how long do MY
    asks wait") — it is NOT "answered through this dashboard", and a surface that labels it that way
    is wrong.
    """
    days = _int_or_none(days) or 7
    since = _now() - days * 86400
    now = _now()
    filed = answered = owner_answers = owner_answered = 0
    owner_by_author: dict[str, int] = {}
    latencies: list[int] = []
    owner_latencies: list[int] = []
    lanes: dict[str, dict[str, Any]] = {}
    open_count = 0
    oldest_open: Optional[int] = None

    def lane(name: Any) -> dict[str, Any]:
        key = str(name or "unassigned")
        return lanes.setdefault(
            key, {"lane": key, "filed": 0, "answered": 0, "owner_answered": 0, "_lat": [], "_owner": []})

    for b in _boards():
        with closing(_ro(b["path"])) as conn:
            owners = {r["id"]: r["assignee"] for r in _q(conn, "SELECT id, assignee FROM tasks")}
            blocks: dict[str, int] = {}
            for r in _q(conn, "SELECT task_id, created_at FROM task_events "
                              "WHERE kind='blocked' AND payload LIKE '%needs_input%' AND created_at >= ? "
                              "ORDER BY created_at", (since,)):
                ts = _int_or_none(r["created_at"])
                if ts:
                    blocks[r["task_id"]] = ts
            filed += len(blocks)
            for tid in blocks:
                lane(owners.get(tid))["filed"] += 1
            for r in _q(conn, "SELECT task_id, created_at FROM task_events "
                              "WHERE kind='unblocked' AND created_at >= ? ORDER BY created_at", (since,)):
                tid, ts = r["task_id"], _int_or_none(r["created_at"])
                b_at = blocks.get(tid)
                if b_at and ts and ts >= b_at:
                    answered += 1
                    latencies.append(ts - b_at)
                    entry = lane(owners.get(tid))
                    entry["answered"] += 1
                    entry["_lat"].append(ts - b_at)
            owner_done: set[str] = set()
            _ph = ", ".join("?" * len(_OWNER_AUTHORS))
            for r in _q(conn, f"SELECT task_id, created_at FROM task_comments "
                              f"WHERE author IN ({_ph}) AND created_at >= ? ORDER BY created_at",
                        tuple(_OWNER_AUTHORS) + (since,)):
                tid, ts = r["task_id"], _int_or_none(r["created_at"])
                parked = blocks.get(tid)
                if tid in owner_done or not parked or not ts or ts < parked:
                    continue  # not a park in this window, or a comment made before it
                owner_done.add(tid)  # ORDER BY created_at: the first one wins
                owner_answered += 1
                owner_latencies.append(ts - parked)
                entry = lane(owners.get(tid))
                entry["owner_answered"] += 1
                entry["_owner"].append(ts - parked)
            for r in _q(conn, f"SELECT author, COUNT(*) c FROM task_comments "
                              f"WHERE author IN ({_ph}) AND created_at >= ? GROUP BY author",
                        tuple(_OWNER_AUTHORS) + (since,)):
                n = int(r["c"] or 0)
                owner_answers += n
                owner_by_author[str(r["author"])] = owner_by_author.get(str(r["author"]), 0) + n
            for r in _q(conn, "SELECT id, created_at FROM tasks "
                              "WHERE block_kind='needs_input' AND status IN ('blocked','triage')"):
                open_count += 1
                ts = _int_or_none(r["created_at"])
                if ts and (oldest_open is None or ts < oldest_open):
                    oldest_open = ts

    for entry in lanes.values():
        entry["median_s"] = _pct(sorted(entry.pop("_lat")), 0.5)
        entry["owner_median_s"] = _pct(sorted(entry.pop("_owner")), 0.5)
    ordered = sorted(lanes.values(), key=lambda e: (-(e["filed"]), e["lane"]))
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_days": days,
        "filed": filed,
        "answered": answered,
        "owner_answers": owner_answers,
        "answer_rate": round(answered / filed, 3) if filed else None,
        "median_wait_s": _pct(sorted(latencies), 0.5),
        "p90_wait_s": _pct(sorted(latencies), 0.9),
        "measured": len(latencies),
        "owner_answered": owner_answered,
        "owner_authors": list(_OWNER_AUTHORS),
        "owner_answers_by_author": owner_by_author,
        "owner_answer_rate": round(owner_answered / filed, 3) if filed else None,
        "owner_median_wait_s": _pct(sorted(owner_latencies), 0.5),
        "owner_p90_wait_s": _pct(sorted(owner_latencies), 0.9),
        "owner_measured": len(owner_latencies),
        "still_open": open_count,
        "oldest_open_s": (now - oldest_open) if oldest_open else None,
        "lanes": ordered,
    }


# =====================================================================================
# PROJECTS — the owner-facing layer over the estate's own project store
# =====================================================================================
# MC_PROJECTS_ROUTES
#
# `~/.hermes/projects.db` (hermes_cli/projects_db.py) is the estate's REAL project store, and the
# desktop app already has a Projects surface over it — so this page reads the SAME store rather
# than inventing a parallel concept. Two measured facts shape the code below:
#
#   * projects.db is PER-PROFILE. "The One Stack" exists three times on this box
#     (p_38dd7b92 root, p_ae993f2c eng-lead, p_eefc522f tos-dreamer) with the same `slug`. Merge by
#     slug (fallback: primary_path, then id), never by id, or the page reports one project as three.
#   * Cards carry `tasks.project_id`, which can name an id from the CREATING profile's db — so a
#     project's cards are found by "any of its ids" OR "its board_slug".

MC_PROJECTS_STATE = Path(_hermes_home()) / "state" / "mc-projects.json"


def _mc_projects_state() -> dict:
    """Mission Control's own management layer: which bots belong to a project, its owner-facing
    status, and notes. Kept OUT of projects.db on purpose — that store is core-owned and the
    desktop app writes it; this is the layer the owner edits from here."""
    try:
        return json.loads(MC_PROJECTS_STATE.read_text())
    except Exception:
        return {"projects": {}}


def _mc_projects_save(state: dict) -> None:
    MC_PROJECTS_STATE.parent.mkdir(parents=True, exist_ok=True)
    MC_PROJECTS_STATE.write_text(json.dumps(state, indent=1, sort_keys=True))


def _project_records() -> list[dict]:
    """Every project on the box, merged by slug across all projects.db files."""
    homes = [Path(_hermes_home())] + sorted((Path(_hermes_home()) / "profiles").glob("*/"))
    merged: dict[str, dict] = {}
    for home in homes:
        db = home / "projects.db"
        if not db.exists():
            continue
        try:
            with closing(sqlite3.connect(f"file:{db}?mode=ro", uri=True)) as conn:
                conn.row_factory = sqlite3.Row
                for r in conn.execute("SELECT * FROM projects"):
                    key = (r["slug"] or r["id"] or "").strip()
                    rec = merged.setdefault(key, {
                        "key": key, "slug": r["slug"], "name": r["name"], "ids": [],
                        "board": r["board_slug"], "path": r["primary_path"],
                        "description": r["description"], "archived": bool(r["archived"]),
                        "homes": [],
                    })
                    if r["id"] not in rec["ids"]:
                        rec["ids"].append(r["id"])
                    rec["homes"].append("root" if home.name == ".hermes" else home.name)
                    rec["archived"] = rec["archived"] or bool(r["archived"])
        except Exception:
            continue
    return list(merged.values())


def _bot_schedules(profile: str) -> dict:
    """enabled / failing job counts for one bot, read from its own cron store."""
    store = Path(_hermes_home()) / "profiles" / profile / "cron" / "jobs.json"
    if profile == "default":
        store = Path(_hermes_home()) / "cron" / "jobs.json"
    try:
        jobs = json.loads(store.read_text())
        jobs = jobs.get("jobs", jobs) if isinstance(jobs, dict) else jobs
    except Exception:
        return {"enabled": 0, "failing": 0, "measured": False}
    enabled = [j for j in jobs if j.get("enabled", True)]
    failing = [j for j in enabled if str(j.get("last_status") or "").lower() not in ("ok", "", "none")]
    return {"enabled": len(enabled), "failing": len(failing), "measured": True,
            "failing_names": [j.get("name") for j in failing][:4]}


@router.get("/projects")
def projects():
    """Every active project with its health: cards, asks waiting on the owner, bots, schedules."""
    state = _mc_projects_state()
    registry = state.get("projects") or {}
    now = _now()

    # board -> per-status and per-project_id census
    by_pid: dict[str, dict] = {}
    all_assignees: dict[str, dict] = {}
    board_cards: dict[str, dict] = {}
    for b in _boards():
        with closing(_ro(b["path"])) as conn:
            for r in _q(conn, "SELECT project_id, status, COUNT(*) c FROM tasks GROUP BY 1, 2"):
                pid = r["project_id"] or ""
                d = by_pid.setdefault(pid, {})
                d[r["status"]] = int(r["c"] or 0)
            for r in _q(conn, "SELECT assignee, COUNT(*) c FROM tasks WHERE status IN "
                              "('todo','ready','triage','blocked','running') GROUP BY 1"):
                a = (r["assignee"] or "").strip()
                if a:
                    all_assignees[a] = all_assignees.get(a, {})
                    all_assignees[a][b["slug"]] = all_assignees[a].get(b["slug"], 0) + int(r["c"] or 0)
            row = {}
            for r in _q(conn, "SELECT status, COUNT(*) c FROM tasks GROUP BY 1"):
                row[r["status"]] = int(r["c"] or 0)
            for r in _q(conn, "SELECT COUNT(*) c FROM tasks WHERE block_kind='needs_input' "
                              "AND status IN ('blocked','triage')"):
                row["_asks"] = int(r["c"] or 0)
            board_cards[b["slug"]] = row

    # asks per project: reuse the framed-ask contract so this agrees with /waiting
    ask_by_board: dict[str, int] = {}
    for b in _boards():
        ask_by_board[b["slug"]] = board_cards.get(b["slug"], {}).get("_asks", 0)

    out = []
    for rec in _project_records():
        key = rec["key"]
        reg = registry.get(key) or registry.get(rec["slug"]) or {}
        status = (reg.get("status") or ("archived" if rec["archived"] else "active")).lower()
        cards = dict(by_pid.get("") or {}) and {}
        totals: dict[str, int] = {}
        for pid in rec["ids"]:
            for k, v in (by_pid.get(pid) or {}).items():
                totals[k] = totals.get(k, 0) + v
        if rec["board"]:
            for k, v in (board_cards.get(rec["board"]) or {}).items():
                if k != "_asks":
                    totals.setdefault(k, v)
        bots = list(reg.get("bots") or [])
        # derived: whoever is actually holding this project's cards
        for name, boards in all_assignees.items():
            if rec["board"] and boards.get(rec["board"]) and name not in bots:
                bots.append(name)
        sched = {b: _bot_schedules(b) for b in bots}
        out.append({
            "key": key, "slug": rec["slug"], "name": rec["name"], "status": status,
            "board": rec["board"], "path": rec["path"], "description": rec["description"],
            "ids": rec["ids"], "homes": rec["homes"],
            "cards": totals,
            "open": sum(v for k, v in totals.items() if k in ("todo", "ready", "triage", "running")),
            "blocked": totals.get("blocked", 0) + totals.get("triage", 0),
            "asks": ask_by_board.get(rec["board"], 0),
            "bots": sorted(set(bots)),
            "bots_explicit": list(reg.get("bots") or []),
            "schedules": sched,
            "failing": sum(1 for s in sched.values() if s.get("failing")),
            "notes": reg.get("notes") or "",
            "updated_at": reg.get("updated_at"),
        })
    out.sort(key=lambda p: (-p["asks"], -p["blocked"], p["name"] or ""))
    orphans = sorted(k for k in by_pid if k and not any(k in rec["ids"] for rec in _project_records()))
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "projects": out,
        "active": [p["key"] for p in out if p["status"] == "active"],
        "orphan_project_ids": orphans,
        "note": "projects.db is per-profile; records are merged by slug. Status and bot links are "
                "Mission Control's own layer, kept in state/mc-projects.json.",
    }


@router.post("/projects/save")
def projects_save(body: dict):
    """Set a project's owner-facing status, its bots, or its notes. This is the layer the owner
    edits here; `projects.db` itself is left to the desktop app's own Projects surface."""
    key = str(body.get("key") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="key required")
    status = str(body.get("status") or "").lower()
    if status and status not in ("active", "paused", "archived"):
        raise HTTPException(status_code=400, detail="status must be active|paused|archived")
    state = _mc_projects_state()
    # ⛔ `state.get("projects") or {}` is a WRITE LOSS when the map is empty: an empty dict is
    # falsy, so setdefault() writes into a throwaway and the save silently persists nothing.
    # MEASURED 2026-09-17 -- the save returned ok and the file stayed `{"projects": {}}`.
    entry = state.setdefault("projects", {}).setdefault(key, {})
    if status:
        entry["status"] = status
    bots_in = body.get("bots")
    if bots_in is not None:
        entry["bots"] = sorted({str(b).strip() for b in bots_in if str(b).strip()})
    if body.get("notes") is not None:
        entry["notes"] = body.get("notes")
    if body.get("name"):
        entry["name"] = body.get("name")
    entry["updated_at"] = datetime.now(timezone.utc).isoformat()
    _mc_projects_save(state)
    return {"ok": True, "key": key, "entry": entry}


class ProjectArchiveBody(BaseModel):
    key: str
    archived: bool = True
    pause_bots: bool = False


def _cron_set(profile: str, action: str) -> dict:
    """Pause/resume every enabled job in one bot's store, through the CLI (the scheduler owns the
    file). `action` is 'pause' or 'resume'."""
    store = Path(_hermes_home()) / "profiles" / profile / "cron" / "jobs.json"
    if profile == "default":
        store = Path(_hermes_home()) / "cron" / "jobs.json"
    try:
        jobs = json.loads(store.read_text())
        jobs = jobs.get("jobs", jobs) if isinstance(jobs, dict) else jobs
    except Exception as exc:                                        # noqa: BLE001
        return {"profile": profile, "changed": 0, "error": f"unreadable store: {exc}"}
    exe = str(Path(_hermes_home()) / "hermes-agent" / "venv" / "bin" / "hermes")
    changed, errors = 0, []
    for j in jobs:
        jid = j.get("id")
        if not jid:
            continue
        want = action == "pause"
        if bool(j.get("enabled", True)) is not want:
            continue
        try:
            p = subprocess.run([exe, "-p", profile, "cron", action, str(jid)],
                               capture_output=True, text=True, timeout=90)
            if p.returncode == 0:
                changed += 1
            else:
                errors.append((p.stderr or p.stdout or "").strip()[:80])
        except Exception as exc:                                    # noqa: BLE001
            errors.append(f"{type(exc).__name__}: {exc}")
    return {"profile": profile, "changed": changed, "errors": errors[:3]}


@router.post("/projects/archive")
def projects_archive(body: ProjectArchiveBody):
    """Archive a project (or bring it back). Optionally park its bots: pause every one of their
    scheduled jobs — reversible with the same call (`archived=false, pause_bots=true` resumes)."""
    key = str(body.get("key") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="key required")
    state = _mc_projects_state()
    # ⛔ `state.get("projects") or {}` is a WRITE LOSS when the map is empty: an empty dict is
    # falsy, so setdefault() writes into a throwaway and the save silently persists nothing.
    # MEASURED 2026-09-17 -- the save returned ok and the file stayed `{"projects": {}}`.
    entry = state.setdefault("projects", {}).setdefault(key, {})
    archived = bool(body.get("archived", True))
    entry["status"] = "archived" if archived else "active"
    entry["updated_at"] = datetime.now(timezone.utc).isoformat()
    _mc_projects_save(state)
    bots = entry.get("bots") or []
    moved = []
    if body.get("pause_bots") and bots:
        for b in bots:
            moved.append(_cron_set(b, "pause" if archived else "resume"))
    return {"ok": True, "key": key, "status": entry["status"], "bots": bots, "cron": moved}


# ---------------------------------------------------------------------------
# Flow / value stream — where the work is, how fast it moves, and what the
# constraint is. One funnel per project, live, plus the PR/CI/deploy leg.
#
# The measurement model, stated so the numbers cannot drift from their meaning:
#
#   * OCCUPANCY is a snapshot — `tasks.status` (+ `block_kind`) right now.
#   * FLOW is a window count — per-card stage-marker events in time order; an
#     edge A->B counts cards whose consecutive markers were A then B, so a card
#     that skips a stage records the edge it actually took (no invented traffic)
#     and rework shows up as a BACKWARD edge.
#   * DWELL is measured on the CURRENT occupants of a stage (median + oldest).
#   * The CONSTRAINT is ranked on queue-hours (wip x dwell — always measurable,
#     including stages whose exit event is not instrumented), with Little's-law
#     wait (wip / measured exit rate) shown beside it.
#
# A stage whose exit event is not instrumented reports `flow: "unmeasured"`
# rather than a zero, because "could not measure" is not "none moved".
# ---------------------------------------------------------------------------

_FLOW_STAGES = (
    ("filed", "Filed", "triage"),
    ("backlog", "Backlog", "todo"),
    ("ready", "Ready", "ready"),
    ("build", "In build", "running"),
    ("review", "In review", "review"),
    ("publish", "Awaiting publication", "awaiting_publication"),
    ("done", "Shipped", "done"),
)
_FLOW_COLUMN = {sid: col for sid, _, col in _FLOW_STAGES}
_FLOW_LABEL = {sid: lab for sid, lab, _ in _FLOW_STAGES}
_FLOW_ORDER = {sid: i for i, (sid, _, _) in enumerate(_FLOW_STAGES)}
_FLOW_COLUMN_INV = {col: sid for sid, _, col in _FLOW_STAGES}
# Event kind -> the stage it records entry into. Only events that NAME a stage
# are here; anything absent is reported as unmeasured rather than guessed.
_FLOW_MARKERS = {
    "created": "filed",
    "promoted": "ready",           # `promoted` is the renamed `ready` event
    "spawned": "build",
    "reclaimed": "build",
    "changes_requested": "build",  # rework: review -> build
    "review_requested": "review",
    "review_reopened": "review",
    "completed": "done",
}
_FLOW_CHURN_EVENTS = ("crashed", "gave_up", "spawn_failed", "respawn_guarded", "block_loop_detected")
_FLOW_RAILS = (
    ("needs_input", "Needs you"),
    ("capability", "No capability"),
    ("dependency", "Dependency"),
    ("transient", "Transient"),
)
# Stages whose exit event is genuinely instrumented. Backlog has no event that
# says "left todo"; `done` is terminal.
_FLOW_UNMEASURED = ("backlog", "done")
# A DISPATCH IS NOT ALWAYS BUILD. `spawned`/`reclaimed` record that a run picked the card
# up; when that run belongs to a review, audit or watch lane the card is being CHECKED,
# not built, and counting it as "In build" manufactures the review->build arc out of the
# reviewer's own pickup. Measured on the tos board, 7d: 12,847 spawns, of which
# eng-reviewer 3,284 + eng-reviewer-2 1,504 + eng-auditor 655 are non-building lanes,
# against 698 `changes_requested` — which is what real rework looks like.
_FLOW_REVIEW_LANE_RE = re.compile(r"reviewer|auditor|watcher", re.I)
_FLOW_DISPATCH_EVENTS = ("spawned", "reclaimed")
# A rail counts cards that ARE parked, not cards that ever carried a block_kind: the core
# preserves block_kind through the publication re-key and on archived cards, so a
# block_kind-only predicate reads 1,848 where 1,131 cards are actually parked.
_FLOW_PARKED_STATUSES = ("blocked", "triage", "awaiting_publication")
# A RAIL COUNTS CARDS WHOSE CURRENT STATE IS THAT PARK. `block_kind` is STICKY — the core
# preserves it through the publication re-key and after a card moves on (measured on tos:
# capability carries 349 cards in `review` and 354 archived; needs_input carries 263 in
# `awaiting_publication`) — so the STATUS is the discriminator and each rail has its own shape:
#   * needs_input / capability / transient leave the card in a parked status (blocked, triage);
#   * a dependency park does NOT. The core sends kind='dependency' to `todo` and auto-resumes it,
#     so a parked-status predicate reads the Dependency rail as a STRUCTURAL ZERO (measured:
#     block_kind='dependency' by status is todo 98 / archived 20 / running 3).
#   * `awaiting_publication` and `review` are live lanes on the funnel, not rails; a preserved
#     block_kind there is stale, which is why they are NOT in the default shape.
_FLOW_RAIL_STATUSES = {"dependency": ("todo",)}
_FLOW_RAIL_DEFAULT_STATUSES = ("blocked", "triage")

_GH_TTL_SECONDS = 600.0
_GH_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_GH_INFLIGHT: set[str] = set()
_GH_CACHE_LOCK = threading.Lock()


def _flow_payload_kind(payload: Optional[str]) -> Optional[str]:
    """The `kind` field of a park event payload — parsed, never LIKE-matched.

    MEASURED 2026-09-19: a `LIKE '%awaiting_publication%'` test matched 319 rows
    on the tos board where the true count was 211, because the park REASON text of
    a `needs_input` park discusses publication at length. Only the JSON field is
    the block kind.
    """
    if not payload:
        return None
    try:
        data = json.loads(payload)
    except Exception:                                               # noqa: BLE001
        return None
    return data.get("kind") if isinstance(data, dict) else None


def _flow_payload_fields(payload: Optional[str]) -> dict[str, Any]:
    """The parsed park-event payload, or {} — the JSON fields only, never prose."""
    if not payload:
        return {}
    try:
        data = json.loads(payload)
    except Exception:                                               # noqa: BLE001
        return {}
    return data if isinstance(data, dict) else {}


def _flow_median(values: list[float]) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2


def _board_workdir(slug: str) -> Optional[str]:
    """A board's default workdir, straight from the library enumeration."""
    try:
        for entry in kanban_db.list_boards(include_archived=True):
            if entry.get("slug") == slug:
                return entry.get("default_workdir")
    except Exception:                                               # noqa: BLE001
        log.debug("list_boards failed while resolving %s", slug, exc_info=True)
    return None


def _repo_from_path(path: Optional[str]) -> Optional[str]:
    """`owner/name` for a checkout, read from .git/config (never the network)."""
    if not path:
        return None
    cfg = Path(path) / ".git" / "config"
    if not cfg.is_file():
        # a linked worktree: .git is a FILE pointing at the real gitdir
        gitfile = Path(path) / ".git"
        if gitfile.is_file():
            try:
                target = gitfile.read_text().strip().split("gitdir:", 1)[-1].strip()
                cfg = Path(target) / "config"
            except Exception:                                       # noqa: BLE001
                return None
    try:
        text = cfg.read_text()
    except Exception:                                               # noqa: BLE001
        return None
    match = re.search(r'\[remote "origin"\][^\[]*?url\s*=\s*(\S+)', text)
    if not match:
        return None
    slug = re.search(r"github\.com[:/]+([^/]+/[^/\s]+?)(?:\.git)?$", match.group(1))
    return slug.group(1) if slug else None


def _gh_json(args: list[str], timeout: int = 45) -> dict[str, Any]:
    """Run a `gh` command and parse its JSON. Never raises."""
    try:
        proc = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return {"ok": False, "error": "gh not installed"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"gh timed out after {timeout}s"}
    except Exception as exc:                                        # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        return {"ok": False, "error": detail[0][:200] if detail else f"gh exit {proc.returncode}"}
    try:
        return {"ok": True, "data": json.loads(proc.stdout or "[]")}
    except Exception as exc:                                        # noqa: BLE001
        return {"ok": False, "error": f"unparseable gh output: {exc}"}


def _pr_ci_state(pr: dict[str, Any]) -> str:
    """Bucket one open PR by what is actually holding it."""
    if pr.get("isDraft"):
        return "draft"
    merge = (pr.get("mergeStateStatus") or "").upper()
    if merge == "DIRTY":
        return "conflicts"
    checks = pr.get("statusCheckRollup") or []
    states = [str(c.get("conclusion") or c.get("status") or c.get("state") or "").upper() for c in checks]
    if any(s in ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE")
           for s in states):
        return "ci_failing"
    if any(s in ("IN_PROGRESS", "QUEUED", "PENDING") for s in states):
        return "ci_running"
    if merge == "BEHIND":
        return "behind"
    if merge == "BLOCKED" or (pr.get("reviewDecision") or "") == "REVIEW_REQUIRED":
        return "awaiting_review"
    if merge == "CLEAN":
        return "mergeable"
    return "open"


def _deploy_ish(name: str) -> bool:
    low = (name or "").lower()
    if "deploy" in low or "promote" in low or "publish" in low:
        return True
    return "release" in low and "pre-release" not in low and "prerelease" not in low


def _gh_pipeline(repo: str) -> dict[str, Any]:
    """The slow half: three `gh` reads for one repo. Runs OFF the request path."""
    now = time.time()
    out: dict[str, Any] = {"repo": repo, "measured": False}
    open_prs = _gh_json(["pr", "list", "-R", repo, "--state", "open", "--limit", "200", "--json",
                         "number,title,isDraft,mergeStateStatus,reviewDecision,headRefName,"
                         "createdAt,updatedAt,statusCheckRollup"])
    merged = _gh_json(["pr", "list", "-R", repo, "--state", "merged", "--limit", "100", "--json",
                       "number,mergedAt,createdAt"])
    runs = _gh_json(["api", f"repos/{repo}/actions/runs?per_page=100&branch=main"])

    if not open_prs.get("ok") and not merged.get("ok") and not runs.get("ok"):
        out["error"] = open_prs.get("error") or merged.get("error") or runs.get("error")
        return out

    buckets: dict[str, int] = {}
    ages: list[float] = []
    oldest = 0.0
    if open_prs.get("ok"):
        for pr in open_prs["data"]:
            key = _pr_ci_state(pr)
            buckets[key] = buckets.get(key, 0) + 1
            stamp = pr.get("createdAt")
            if stamp:
                try:
                    age = (now - datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()) / 3600.0
                    ages.append(age)
                    oldest = max(oldest, age)
                except Exception:                                   # noqa: BLE001
                    pass
    merged_n, merge_lead = 0, []
    if merged.get("ok"):
        cutoff = now - 7 * 86400
        for pr in merged["data"]:
            try:
                m = datetime.fromisoformat(pr["mergedAt"].replace("Z", "+00:00")).timestamp()
            except Exception:                                       # noqa: BLE001
                continue
            if m >= cutoff:
                merged_n += 1
            try:
                c = datetime.fromisoformat(pr["createdAt"].replace("Z", "+00:00")).timestamp()
                merge_lead.append((m - c) / 3600.0)
            except Exception:                                       # noqa: BLE001
                pass

    deploy = {"in_progress": 0, "failed_24h": 0, "ok_24h": 0, "total": 0, "last_at": None, "names": []}
    ci_runs = {"in_progress": 0, "failed_24h": 0, "ok_24h": 0, "total": 0}
    if runs.get("ok"):
        cutoff24 = now - 86400
        for run in (runs["data"].get("workflow_runs") or []):
            name = run.get("name") or ""
            try:
                created = datetime.fromisoformat(str(run.get("created_at")).replace("Z", "+00:00")).timestamp()
            except Exception:                                       # noqa: BLE001
                created = 0.0
            target = deploy if _deploy_ish(name) else ci_runs
            target["total"] += 1
            if run.get("status") != "completed":
                target["in_progress"] += 1
            if created >= cutoff24:
                if run.get("conclusion") == "failure":
                    target["failed_24h"] += 1
                elif run.get("conclusion") == "success":
                    target["ok_24h"] += 1
            if target is deploy:
                if deploy["last_at"] is None or (run.get("created_at") or "") > deploy["last_at"]:
                    deploy["last_at"] = run.get("created_at")
                if name and name not in deploy["names"] and len(deploy["names"]) < 6:
                    deploy["names"].append(name)

    out.update({
        "measured": True,
        "prs_open": sum(buckets.values()),
        "pr_buckets": buckets,
        "pr_age_median_h": round(_flow_median(ages), 1) if ages else None,
        "pr_age_oldest_h": round(oldest, 1) if oldest else None,
        "prs_merged_7d": merged_n,
        "pr_merge_lead_h": round(_flow_median(merge_lead), 1) if merge_lead else None,
        "ci": ci_runs,
        "deploy": deploy,
        "partial": [label for label, res in
                    (("open_prs", open_prs), ("merged", merged), ("runs", runs)) if not res.get("ok")],
    })
    return out


def _gh_refresh(repo: str) -> None:
    """Single-flight background refresh: one `gh` burst per repo per TTL."""
    try:
        result = _gh_pipeline(repo)
    except Exception as exc:                                        # noqa: BLE001
        result = {"repo": repo, "measured": False, "error": f"{type(exc).__name__}: {exc}"}
    with _GH_CACHE_LOCK:
        _GH_CACHE[repo] = (time.time(), result)
        _GH_INFLIGHT.discard(repo)


def _code_pipeline(repo: str) -> dict[str, Any]:
    """The PR/CI/deploy leg for one repo.

    NEVER blocks a request on the network: a cold repo answers `warming`, a stale
    repo answers its previous reading with `refreshing: true`, and the refresh runs
    on a daemon thread. `gh` reads are expensive (the open-PR read with check
    rollups measured 7.3s) and every one is a call against the shared token, so
    one burst per repo per TTL is the whole budget.
    """
    now = time.time()
    with _GH_CACHE_LOCK:
        hit = _GH_CACHE.get(repo)
        if hit and now - hit[0] < _GH_TTL_SECONDS:
            return {**hit[1], "cache_age_seconds": round(now - hit[0], 1), "refreshing": False}
        starting = repo not in _GH_INFLIGHT
        if starting:
            _GH_INFLIGHT.add(repo)
    if starting:
        threading.Thread(target=_gh_refresh, args=(repo,), daemon=True,
                         name=f"mc-flow-gh-{repo.split('/')[-1]}").start()
    if hit:
        return {**hit[1], "cache_age_seconds": round(now - hit[0], 1), "refreshing": True}
    return {"repo": repo, "measured": False, "warming": True, "refreshing": True,
            "cache_age_seconds": None}


def _flow_for_board(db_path: str, window_hours: int, now: int) -> dict[str, Any]:
    """Occupancy + measured flow + dwell for one kanban board."""
    since = now - window_hours * 3600
    days = max(window_hours / 24.0, 1e-9)
    columns = set(_FLOW_COLUMN.values())
    with closing(_ro(db_path)) as conn:
        wip: dict[str, int] = {}
        done_total = 0
        rail_wip = {key: 0 for key, _ in _FLOW_RAILS}
        parked: list[dict[str, Any]] = []
        for row in _q(conn, "SELECT id, status, COALESCE(block_kind,'') bk, created_at FROM tasks"):
            status, kind = row["status"], row["bk"]
            if status == "done":
                done_total += 1
            elif status in columns:
                wip[status] = wip.get(status, 0) + 1
            if kind in rail_wip and status in _FLOW_RAIL_STATUSES.get(kind, _FLOW_RAIL_DEFAULT_STATUSES):
                rail_wip[kind] += 1
            if status in _FLOW_PARKED_STATUSES:
                parked.append({"id": row["id"], "status": status, "bk": kind,
                               "created_at": int(row["created_at"] or 0)})

        # -- markers, park episodes, churn ------------------------------------
        # The park-event kinds come from the ONE definition the queue readers use
        # (`_park_kinds()` -> `owner_ask_filter.PARK_EVENT_KINDS`), never from a copy of
        # the literal: a reader keyed on `blocked` alone sees about a tenth of the parks.
        park_kinds = set(_park_kinds())
        markers: dict[str, list[tuple[int, str]]] = {}
        park_start: dict[str, int] = {}
        last_park: dict[str, tuple[str, str]] = {}   # task -> (block kind, source_status)
        rail_entered = {key: 0 for key, _ in _FLOW_RAILS}
        publish_entered = 0
        churn = 0
        # `run_profile` carries the lane that recorded the event, which is what makes a
        # dispatch attributable (see _FLOW_REVIEW_LANE_RE).
        for row in _q(conn, "SELECT e.task_id, e.kind, e.payload, e.created_at, "
                            "COALESCE(r.profile,'') AS run_profile FROM task_events e "
                            "LEFT JOIN task_runs r ON r.id = e.run_id "
                            "WHERE e.kind != 'heartbeat' ORDER BY e.task_id, e.id"):
            kind, tid, ts = row["kind"], row["task_id"], int(row["created_at"])
            if kind in park_kinds:
                fields = _flow_payload_fields(row["payload"])
                # `blocked` and `block_loop_detected` name the park in `kind`;
                # `block_retyped` names the NEW park in `to` — it is a move from one park
                # to another, and that move IS the entry into the new lane.
                park_kind = str((fields.get("to") if kind == "block_retyped"
                                 else fields.get("kind")) or "")
                last_park[tid] = (park_kind, str(fields.get("source_status") or ""))
                if ts >= since:
                    if park_kind in rail_entered:
                        rail_entered[park_kind] += 1
                    if park_kind == "awaiting_publication":
                        publish_entered += 1
                        markers.setdefault(tid, []).append((ts, "publish"))
                # Episode start: the FIRST block since the last act that left a
                # park. A card re-parked with the same reason keeps its original
                # start, which is exactly what a bottleneck view has to show.
                if park_start.get(tid) is None:
                    park_start[tid] = ts
                continue
            if kind == "unblocked":
                park_start.pop(tid, None)
                prev = last_park.pop(tid, None)
                if prev and prev[0] == "awaiting_publication" and ts >= since:
                    # The card came back OUT of the publication queue into the
                    # stage it was parked from — a measured exit, and a rework
                    # edge the funnel has to draw.
                    src = _FLOW_COLUMN_INV.get(prev[1] or "")
                    if src and src != "publish":
                        markers.setdefault(tid, []).append((ts, src))
                continue
            if kind in ("completed", "spawned", "promoted", "created", "review_requested"):
                park_start.pop(tid, None)
                last_park.pop(tid, None)
            if kind == "dependency_wait":
                # A dependency park is recorded as `dependency_wait`, NOT as a
                # `blocked` event carrying kind=dependency — so the rail's entry
                # count has to come from here or it reads a permanent zero.
                if ts >= since:
                    rail_entered["dependency"] += 1
                continue
            if ts >= since and kind in _FLOW_CHURN_EVENTS:
                churn += 1
            # A dispatch by a review/audit/watch lane is the card being CHECKED, not built:
            # attribute it to the lane that ran, or the reviewer's own pickup is counted as
            # work entering "In build" and the review->build arc becomes an artifact.
            if kind in _FLOW_DISPATCH_EVENTS:
                stage = "review" if _FLOW_REVIEW_LANE_RE.search(row["run_profile"] or "") else "build"
            else:
                stage = _FLOW_MARKERS.get(kind)
            if stage and ts >= since:
                markers.setdefault(tid, []).append((ts, stage))

        edges: dict[tuple[str, str], int] = {}
        for _tid, seq in markers.items():
            seq.sort()
            for (_, a), (_, b) in zip(seq, seq[1:]):
                if a != b:
                    edges[(a, b)] = edges.get((a, b), 0) + 1

        # -- dwell of the CURRENT occupants -----------------------------------
        ages: dict[str, list[float]] = {sid: [] for sid, _, _ in _FLOW_STAGES}
        for row in _q(conn, "SELECT status, created_at FROM tasks "
                            "WHERE status IN ('triage','todo','ready')"):
            ages[_FLOW_COLUMN_INV[row["status"]]].append(now - int(row["created_at"] or now))
        for row in _q(conn, "SELECT COALESCE(tr.started_at, t.created_at) ts FROM tasks t "
                            "LEFT JOIN task_runs tr ON tr.id = t.current_run_id "
                            "WHERE t.status = 'running'"):
            if row["ts"]:
                ages["build"].append(now - int(row["ts"]))
        for row in _q(conn, "SELECT t.id, MAX(e.created_at) ts FROM tasks t "
                            "JOIN task_events e ON e.task_id = t.id "
                            "AND e.kind IN ('review_requested','review_reopened') "
                            "WHERE t.status = 'review' GROUP BY t.id"):
            ages["review"].append(now - int(row["ts"]))
        # Only publication parks need an episode age: triage/ready/todo already
        # carry their created_at above, and a `blocked` card is reported through
        # the rails rather than on the main line.
        for card in parked:
            if card["status"] != "awaiting_publication":
                continue
            ages["publish"].append(now - (park_start.get(card["id"]) or card["created_at"]))

    stages = []
    for sid, label, column in _FLOW_STAGES:
        count = wip.get(column, 0)
        inflow = sum(n for (_, dst), n in edges.items() if dst == sid)
        outflow = sum(n for (src, _), n in edges.items() if src == sid)
        rate = outflow / days
        wait = (count / (rate / 24.0)) if rate > 0 else None
        dwell = ages.get(sid) or []
        stages.append({
            "id": sid, "label": label,
            "wip": count,
            "in": inflow, "out": outflow,
            "out_per_day": round(rate, 2),
            # inflow vs outflow is the whole bottleneck story: a stage whose
            # arrivals exceed its departures is where the work is piling up.
            "net_per_day": round((inflow - outflow) / days, 2),
            "median_age_h": round(_flow_median(dwell) / 3600.0, 1) if dwell else None,
            "oldest_age_h": round(max(dwell) / 3600.0, 1) if dwell else None,
            "queue_hours": round(sum(dwell) / 3600.0, 1) if dwell else 0.0,
            "wait_h": round(wait, 1) if wait is not None else None,
            "flow": "unmeasured" if sid in _FLOW_UNMEASURED else "measured",
            "terminal": sid == "done",
        })
    ranked = [s for s in stages if s["wip"] > 0 and not s["terminal"]]
    constraint = max(ranked, key=lambda s: s["queue_hours"]) if ranked else None
    if constraint:
        constraint["constraint"] = True
    return {
        "stages": stages,
        "rails": [{"id": key, "label": label, "wip": rail_wip.get(key, 0),
                   "entered": rail_entered.get(key, 0)} for key, label in _FLOW_RAILS],
        "publish_entered": publish_entered,
        "churn": churn,
        "done_total": done_total,
        "edges": [{"from": a, "to": b, "count": n,
                   "direction": "forward" if _FLOW_ORDER.get(a, 0) < _FLOW_ORDER.get(b, 0) else "rework"}
                  for (a, b), n in sorted(edges.items(), key=lambda kv: -kv[1])],
        "rework": sum(n for (a, b), n in edges.items() if _FLOW_ORDER.get(a, 0) > _FLOW_ORDER.get(b, 0)),
        "cards_with_markers": len(markers),
        "window_hours": window_hours,
    }


def _flow_entry(key: str, name: str, slug: str, board: Optional[dict[str, Any]],
                path: Optional[str], window_hours: int, now: int,
                archived: bool = False, unattached: bool = False) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "key": key, "name": name, "slug": slug, "board": slug, "path": path,
        "archived": archived, "board_found": bool(board), "unattached": unattached,
    }
    if not board:
        return entry
    repo = _repo_from_path(path) or _repo_from_path(_board_workdir(slug))
    entry["repo"] = repo
    try:
        entry.update(_flow_for_board(board["path"], window_hours, now))
    except Exception as exc:                                        # noqa: BLE001
        log.warning("flow: board %s failed", slug, exc_info=True)
        entry["error"] = f"{type(exc).__name__}: {exc}"
    return entry


@router.get("/flow")
def flow(window_hours: int = Query(168, ge=6, le=1440), project: Optional[str] = None):
    """The living value-stream funnel: one row per project — kanban flow plus the
    PR/CI/deploy leg — with the constraint named.

    Occupancy and flow are read live from the boards; the code pipeline answers
    from a cache (10 min) and refreshes on a background thread, so no request ever
    waits on `gh`.
    """
    window_hours = int(window_hours)
    now = _now()
    boards = {b["slug"]: b for b in _boards()}
    rows: list[dict[str, Any]] = []
    claimed: set[str] = set()

    for rec in _project_records():
        key = rec["key"]
        if project and project not in (key, rec["slug"], rec["name"]):
            continue
        slug = (rec["board"] or "").strip()
        claimed.add(slug)
        rows.append(_flow_entry(key, rec["name"], slug, boards.get(slug),
                                rec["path"], window_hours, now, archived=rec["archived"]))

    if not project:
        for slug, board in boards.items():
            if slug in claimed:
                continue
            entry = _flow_entry(f"board:{slug}", board["title"], slug, board,
                                _board_workdir(slug), window_hours, now, unattached=True)
            # An unattached board earns a row when it is carrying work; an empty
            # one is noise, and the row's own `wip` sums already say "no load".
            if not entry.get("cards_with_markers") and not any(
                    s["wip"] for s in entry.get("stages", [])):
                continue
            rows.append(entry)

    repos = sorted({r["repo"] for r in rows if r.get("repo")})
    for repo in repos:
        pipeline = _code_pipeline(repo)
        for row in rows:
            if row.get("repo") == repo:
                row["pipeline"] = pipeline

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_hours": window_hours,
        "projects": rows,
        "counts": {"projects": sum(1 for r in rows if not r.get("unattached")),
                   "unattached_boards": sum(1 for r in rows if r.get("unattached"))},
        "model": {
            "occupancy": "snapshot of tasks.status right now",
            "flow": f"per-card stage-marker events in the last {window_hours}h; an edge counts "
                    "TRANSITIONS (a card whose consecutive markers were those two stages "
                    "contributes one per occurrence, so a card that cycles contributes more "
                    "than once)",
            "constraint": "highest queue-hours (summed dwell of the cards sitting in the stage)",
            "wait_h": "Little's law: wip / measured exit rate; null where no exit event is instrumented",
            "parks": "read over every park-event kind the queue readers use "
                     "(blocked, block_retyped, block_loop_detected), never `blocked` alone — a "
                     "reader keyed on `blocked` sees about a tenth of the parks",
            "dispatch": "a spawned/reclaimed event is attributed to the lane that ran it "
                        "(task_runs.profile): a review/audit/watch lane reads as In review, "
                        "anything else as In build",
            "rails": "cards whose CURRENT state is that park: blocked/triage for "
                     "needs_input, capability and transient, and status=todo for dependency "
                     "(a dependency park auto-resumes from todo, so a parked-status predicate "
                     "reads that rail as a structural zero). block_kind is sticky — a preserved "
                     "one on an archived, published or reviewed card is not a rail",
            "rework": "markers that run backwards through the stage order; counted from the "
                      "same markers, so it is only as good as the attribution above",
            "code_pipeline": f"gh reads, cached {int(_GH_TTL_SECONDS)}s, refreshed off the request path",
        },
    }


# --- the scheduler page's ONE source of numbers ---------------------------------
#
# ⛔ ONE IMPLEMENTATION, TWO CONSUMERS. `~/.hermes/scripts/lib/scheduler_telemetry.py` is the
# measurement; the cron watcher (`hermes-scheduler-telemetry.py`) escalates from it and this route
# renders it. The route does NOT re-derive a share or a wait here: two implementations of the same
# predicate is two contracts, and they drift (the store's own doctrine -- see `lib/owner_ask_filter`,
# `lib/finding_delivery`). The module is resolved by PATH the same way `_ask_filter()` resolves
# `owner_ask_filter`, because a per-profile dashboard backend would otherwise look for
# `<profile home>/scripts/lib` and find nothing.
_SCHED_TELE = None


def _sched_telemetry():
    """The measurement module, or None when it cannot be imported (reported, never guessed)."""
    global _SCHED_TELE
    if _SCHED_TELE is None:
        for lib_dir in _scripts_lib_dirs():
            try:
                if str(lib_dir) not in sys.path:
                    sys.path.insert(0, str(lib_dir))
                import scheduler_telemetry  # noqa: PLC0415
                _SCHED_TELE = scheduler_telemetry
                log.info("scheduler telemetry loaded from %s", lib_dir)
                break
            except Exception:
                continue
        if _SCHED_TELE is None:
            log.warning("scheduler_telemetry could not be imported; /scheduler will report that "
                        "rather than render numbers")
            _SCHED_TELE = False
    return _SCHED_TELE or None


@router.get("/scheduler")
def scheduler(window_minutes: int = Query(60, ge=5, le=1440),
              starve_minutes: int = Query(45, ge=5, le=1440)):
    """Per-board share, wait-time distribution and starvation, measured LIVE on every request.

    Live on purpose: a page that renders a cron-written state file shows yesterday's estate the
    moment the job stops, and the failure is silent. The watcher's own record is returned beside the
    reading (last run, last change, filings) so the page can show the ALERTING half's liveness --
    it is never the source of a number.

    An unreadable board, an unimportable module or an unreadable config are REPORTED here: the
    payload carries `unreadable` / `error` and the page renders them. "Could not measure" must never
    render as a zero.
    """
    window_minutes = _int_or_none(window_minutes) or 60
    starve_minutes = _int_or_none(starve_minutes) or 45
    now_iso = datetime.now(timezone.utc).isoformat()
    mod = _sched_telemetry()
    if mod is None:
        return {
            "error": "the measurement module (scripts/lib/scheduler_telemetry.py) could not be "
                     "imported, so NOTHING is measured. This page does not guess: no share, no "
                     "wait distribution and no starvation state can be rendered from here.",
            "generated_at_iso": now_iso,
            "boards": [], "alerts": [], "unreadable": [], "strays": [], "totals": {},
        }
    try:
        root = mod.hermes_root()
        payload = mod.snapshot(root, window_seconds=window_minutes * 60,
                               starve_seconds=starve_minutes * 60)
    except Exception as exc:  # noqa: BLE001 -- a route must answer, and must say why it could not
        log.exception("scheduler telemetry read failed")
        return {"error": "the telemetry read failed: %s: %s" % (type(exc).__name__, exc),
                "generated_at_iso": now_iso, "boards": [], "alerts": [], "unreadable": [],
                "strays": [], "totals": {}}

    payload["generated_at_iso"] = datetime.fromtimestamp(
        payload.get("generated_at") or time.time(), timezone.utc).isoformat()
    payload["root"] = str(root)
    payload["watcher"] = _sched_watcher_state(root, payload.get("generated_at"))
    return payload


def _sched_watcher_state(root: Path, now: Optional[int]) -> dict[str, Any]:
    """What the cron watcher recorded on its last run -- READ ONLY, and never a number's source."""
    path = root / "state" / "scheduler-telemetry.json"
    out: dict[str, Any] = {"state_path": str(path), "read": False,
                           "last_run_at": None, "last_changed_at": None,
                           "stale_seconds": None, "filings": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        out["why"] = "the watcher's state file could not be read (%s) -- the ALERTING half has " \
                     "not run, or has never written it" % type(exc).__name__
        return out
    out["read"] = True
    out["last_run_at"] = _iso(data.get("last_run_at"))
    out["last_changed_at"] = _iso(data.get("last_changed_at"))
    last = _int_or_none(data.get("last_run_at"))
    if last and now:
        out["stale_seconds"] = max(0, int(now) - last)
    elif last:
        out["stale_seconds"] = max(0, int(time.time()) - last)
    return out
