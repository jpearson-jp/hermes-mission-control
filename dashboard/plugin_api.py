"""Mission Control — backend routes, mounted at ``/api/plugins/mission-control/``.

Reads (cheap, read-only SQLite over every kanban board + every profile's cron store):
what is running, what is parked on Jesse, what shipped today, what is scheduled.

Writes are exactly two owner actions, both routed through ``hermes_cli.kanban_db`` — the
same code path the CLI and the bundled kanban plugin use, so the surfaces cannot drift:

    POST /answer   comment on a card as the owner, then (by default) ``unblock_task`` it
    POST /comment  comment on a card as the owner, no state change

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

log = logging.getLogger(__name__)

router = APIRouter()

_FRAME_MARKER = "OPTIONS FOR THE OWNER"
_REC_RE = re.compile(r"\*\*RECOMMENDATION:\s*(\d+)\*\*")
_OPT_RE = re.compile(r"^\s*(\d+)[.)]\s+(.*)$")
_HUMAN_HINT_RE = re.compile(r"\bjesse\b|\bowner\b|\byour call\b|\bneeds your\b", re.I)

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

        return Path(get_hermes_home())
    except Exception:
        return Path.home() / ".hermes"


def _boards() -> list[dict[str, Any]]:
    """Every kanban board on this box, newest activity last (slug + display title)."""
    root = _hermes_home() / "kanban" / "boards"
    out: list[dict[str, Any]] = []
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


def _ask_reasons(conn: sqlite3.Connection, ids: list[str]) -> dict[str, str]:
    """Newest ``blocked`` event reason per task (what the decision-nag quotes as THE ASK)."""
    out: dict[str, str] = {}
    for chunk in _chunks(ids):
        marks = ",".join("?" * len(chunk))
        latest = {r["task_id"]: r["mid"] for r in conn.execute(
            f"SELECT task_id, MAX(id) mid FROM task_events "
            f"WHERE kind='blocked' AND task_id IN ({marks}) GROUP BY task_id", chunk)}
        if not latest:
            continue
        ev_marks = ",".join("?" * len(latest))
        for row in conn.execute(
                f"SELECT id, task_id, payload FROM task_events WHERE id IN ({ev_marks})", list(latest.values())):
            reason = _reason_from_payload(row["payload"])
            if reason:
                out[row["task_id"]] = reason
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
        "THE ASK (verbatim — the newest park reason on the card):",
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


def _awaiting_for_board(slug: str, db: str, limit: int) -> dict[str, Any]:
    """Every owner-facing park on this board, split into framed asks and un-framed parks.

    The whole park set is inspected for framing (cheap: two batched queries); item *detail* is
    capped so the payload stays small.
    """
    with closing(_ro(db)) as conn:
        rows = _q(conn, _AWAITING_SQL)
        framed_bodies = _frame_bodies(conn, [r["id"] for r in rows])
        by_id = {r["id"]: r for r in rows}
        framed_ids = [r["id"] for r in rows if r["id"] in framed_bodies]
        # preview budget: every framed ask (they are the point), then the newest un-framed parks
        preview_ids = framed_ids + [r["id"] for r in rows if r["id"] not in framed_bodies][:limit]
        reasons = _ask_reasons(conn, preview_ids)

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
        "total": len(rows),
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
