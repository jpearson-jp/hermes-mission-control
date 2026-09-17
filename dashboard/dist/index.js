/* Mission Control — dashboard tab.
 *
 * One pane of glass over the estate. Reads /api/plugins/mission-control/*, and writes
 * exactly two owner actions: answer a parked decision (comment + re-open for dispatch) or
 * leave a comment. Plain IIFE, no build step, React from the dashboard SDK.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !SDK.React) {
    console.error("mission-control: plugin SDK unavailable");
    return;
  }
  var React = SDK.React;
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useCallback = React.useCallback;
  var fetchJSON = SDK.fetchJSON;
  var API = "/api/plugins/mission-control";

  // ---------------------------------------------------------------- helpers
  function dur(sec) {
    if (sec == null) return "—";
    sec = Math.max(0, Math.floor(sec));
    if (sec < 60) return sec + "s";
    if (sec < 3600) return Math.floor(sec / 60) + "m";
    if (sec < 86400) return Math.floor(sec / 3600) + "h " + Math.floor((sec % 3600) / 60) + "m";
    return Math.floor(sec / 86400) + "d " + Math.floor((sec % 86400) / 3600) + "h";
  }
  function hhmm(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toISOString().slice(5, 16).replace("T", " "); } catch (e) { return "—"; }
  }

  // ---------------------------------------------------------------- clipboard + chat handoff
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
    } catch (e) { /* fall through to the legacy path */ }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error("execCommand copy refused"));
      } catch (e) { reject(e); }
    });
  }

  /** The dashboard's own chat tab, carrying the profile this page is scoped to. */
  function chatHref() {
    var p = null;
    try { p = new URLSearchParams(window.location.search).get("profile"); } catch (e) { /* ignore */ }
    return "/chat" + (p ? "?profile=" + encodeURIComponent(p) : "");
  }

  /**
   * Card identity + the two handoffs. The card id is always visible — copying it into a chat by
   * hand is the floor, not the ceiling. "Chat about it" copies the full context block AND opens
   * the dashboard's real chat tab (a new surface's own PTY), so the conversation has the card.
   */
  function CardTools(props) {
    var it = props.item;
    var [note, setNote] = useState(null);
    var label = props.label || it.id;

    function copyOnly(what) {
      var text = what === "id" ? it.id : (it.briefing || it.id);
      copyText(text).then(function () {
        setNote(what === "id" ? "ID copied (" + it.id + ")" : "context copied — paste it into the chat");
      }, function (e) {
        setNote("copy failed: " + e.message + " — select the text by hand");
      });
    }

    function chatNow() {
      // Open first, inside the click gesture: a popup opened after an await gets blocked.
      try { window.open(chatHref(), "_blank", "noopener"); } catch (e) { /* popup blocked */ }
      copyText(it.briefing || it.id).then(function () {
        setNote("chat opened + context copied → paste with Ctrl-V");
      }, function () {
        setNote("chat opened — copy the context from the card panel by hand");
      });
    }

    return h("div", { className: "mc-tools" },
      h("span", { className: "mc-id", title: "card id (click to copy)", onClick: function () { copyOnly("id"); } }, label),
      h("button", { className: "mc-btn", onClick: function () { copyOnly("id"); } }, "Copy ID"),
      h("button", { className: "mc-btn", onClick: function () { copyOnly("ctx"); } }, "Copy context"),
      h("button", { className: "mc-btn mc-btn-p", onClick: chatNow }, "Chat about it ↗"),
      props.extra || null,
      note ? h("span", { className: "mc-ok" }, note) : null);
  }
  function usePoll(path, ms) {
    var [state, set] = useState({ data: null, error: null, at: null });
    var load = useCallback(function () {
      fetchJSON(API + path)
        .then(function (d) { set({ data: d, error: null, at: new Date() }); })
        .catch(function (e) { set(function (s) { return { data: s.data, error: String(e && e.message || e), at: s.at }; }); });
    }, [path]);
    useEffect(function () {
      load();
      var t = setInterval(load, ms);
      return function () { clearInterval(t); };
    }, [load, ms]);
    return { state: state, load: load };
  }

  // ---------------------------------------------------------------- pieces
  function Pill(props) {
    return h("span", { className: "mc-pill " + (props.kind || "") }, props.children);
  }

  /** A copyable card id — the floor of the handoff, usable inside tables. */
  function IdChip(props) {
    var [done, setDone] = useState(false);
    return h("span", {
      className: "mc-id",
      title: "click to copy this card id",
      onClick: function () {
        copyText(props.id).then(function () { setDone(true); setTimeout(function () { setDone(false); }, 1500); });
      }
    }, done ? "copied" : props.id);
  }
  function Stat(props) {
    return h("div", { className: "mc-stat" },
      h("div", { className: "mc-stat-k" }, props.k),
      h("div", { className: "mc-stat-v" }, props.v),
      props.n ? h("div", { className: "mc-stat-n" }, props.n) : null);
  }
  function Panel(props) {
    return h("div", { className: "mc-card" },
      h("div", { className: "mc-card-h" },
        h("div", { className: "mc-card-t" }, props.title),
        props.right || null),
      h("div", { className: "mc-card-c" }, props.children));
  }
  function Bars(props) {
    var pts = props.points || [];
    if (!pts.length) return h("div", { className: "mc-muted" }, "no activity in window");
    var max = pts.reduce(function (m, p) { return Math.max(m, p.count); }, 1);
    return h("div", { className: "mc-bars", title: pts.length + " hourly buckets" },
      pts.map(function (p, i) {
        return h("div", { key: i, className: "mc-bar", style: { height: Math.max(2, (p.count / max) * 40) + "px" }, title: hhmm(p.bucket) + " — " + p.count });
      }));
  }

  // ---------------------------------------------------------------- answer row
  function AskRow(props) {
    var item = props.item;
    var [open, setOpen] = useState(false);
    var [choice, setChoice] = useState(item.recommendation || null);
    var [text, setText] = useState("");
    var [busy, setBusy] = useState(false);
    var [msg, setMsg] = useState(null);
    var [err, setErr] = useState(null);

    function send(unblock) {
      setBusy(true); setErr(null); setMsg(null);
      fetchJSON(API + "/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          board: item.board, task_id: item.id, choice: choice,
          option_text: choice ? item.options[choice - 1] : null,
          text: text, unblock: unblock
        })
      }).then(function (r) {
        setBusy(false);
        setMsg("recorded (comment #" + r.comment_id + ") — card " + r.status_before + " → " + r.status_after);
        setText("");
        if (props.onDone) props.onDone();
      }).catch(function (e) { setBusy(false); setErr(String(e && e.message || e)); });
    }

    return h("div", { className: "mc-row" },
      h("div", { className: "mc-row-h" },
        h("div", { style: { flex: "1 1 auto" } },
          h("div", { className: "mc-row-t" }, item.title),
          h("div", { className: "mc-row-m" },
            h(Pill, { kind: "mc-pill-me" }, "needs you"),
            h("span", null, "project: " + (item.board_title || item.board)),
            h("span", null, "asked by " + (item.assignee || "unknown")),
            h("span", null, "parked " + dur(item.age_seconds) + " ago"),
            h("span", null, item.comments + " comments"),
            (item.hints || []).map(function (x) {
              return h(Pill, { key: x, kind: "mc-pill-warn" }, x);
            }))),
        h("button", { className: "mc-btn", onClick: function () { setOpen(!open); } }, open ? "hide" : "open")),
      h(CardTools, { item: item }),
      item.summary ? h("div", { className: "mc-sum" }, item.summary) : null,
      !open && item.ask ? h("div", { className: "mc-ask" }, item.ask.slice(0, 320) + (item.ask.length > 320 ? "…" : "")) : null,
      open ? h("div", { className: "mc-cards" },
        item.ask ? h("div", { className: "mc-ask" }, item.ask) : null,
        (item.options || []).map(function (o, i) {
          var n = i + 1;
          var rec = item.recommendation === n;
          return h("button", {
            key: n,
            className: "mc-opt" + (choice === n ? " mc-opt-on" : ""),
            onClick: function () { setChoice(n); }
          },
            h("span", { className: "mc-opt-n" }, n + "."),
            h("span", { style: { flex: "1 1 auto" } }, o),
            rec ? h(Pill, { kind: "mc-pill-rec" }, "recommended") : null);
        }),
        h("textarea", {
          className: "mc-ta", value: text, placeholder: "Answer, nuance, or constraints (optional)…",
          onChange: function (e) { setText(e.target.value); }
        }),
        h("div", { className: "mc-actions" },
          h("button", {
            className: "mc-btn mc-btn-p", disabled: busy || (choice == null && !text.trim()),
            onClick: function () { send(true); }
          }, busy ? "sending…" : "Answer & re-open card"),
          h("button", {
            className: "mc-btn", disabled: busy || !text.trim(),
            onClick: function () { send(false); }
          }, "Comment only (stay parked)"),
          !item.framed ? h(Pill, { kind: "mc-pill-warn" }, "no framed options") : null)) : null,
      msg ? h("div", { className: "mc-ok" }, msg) : null,
      err ? h("div", { className: "mc-err" }, err) : null);
  }

  // ---------------------------------------------------------------- card detail
  function CardDetail(props) {
    var ref = props.target; // {board, id}
    var [st, set] = useState({ data: null, error: null });
    useEffect(function () {
      fetchJSON(API + "/card?board=" + encodeURIComponent(ref.board) + "&id=" + encodeURIComponent(ref.id))
        .then(function (d) { set({ data: d, error: null }); })
        .catch(function (e) { set({ data: null, error: String(e && e.message || e) }); });
    }, [ref.board, ref.id]);
    if (st.error) return h(Panel, { title: "Card " + ref.id, right: h("button", { className: "mc-btn", onClick: props.onClose }, "close") },
      h("div", { className: "mc-err" }, st.error));
    if (!st.data) return h(Panel, { title: "Card " + ref.id, right: h("button", { className: "mc-btn", onClick: props.onClose }, "close") },
      h("div", { className: "mc-muted" }, "loading…"));
    var d = st.data, t = d.task;
    return h(Panel, {
      title: t.title,
      right: h("div", { className: "mc-actions" },
        h(Pill, null, d.board_title || ref.board), h(Pill, null, t.status), t.block_kind ? h(Pill, { kind: "mc-pill-warn" }, t.block_kind) : null,
        h("button", { className: "mc-btn", onClick: props.onClose }, "close"))
    },
      h("div", { className: "mc-row-m" },
        h("span", null, t.id), t.assignee ? h("span", null, t.assignee) : null,
        h("span", null, "created " + hhmm(t.created_at)),
        t.branch_name ? h("span", null, t.branch_name) : null,
        d.parents.length ? h("span", null, "parents: " + d.parents.map(function (p) { return p.id + "(" + p.status + ")"; }).join(", ")) : null),
      (d.hints || []).length ? h("div", { className: "mc-row-m" },
        (d.hints || []).map(function (x) { return h(Pill, { key: x, kind: "mc-pill-warn" }, x); })) : null,
      h(CardTools, {
        item: { id: t.id, briefing: d.briefing },
        extra: h("span", { className: "mc-muted" }, "cli: hermes kanban --board " + ref.board + " show " + t.id)
      }),
      h("details", { className: "mc-brief" },
        h("summary", null, "the context block that gets copied (select it by hand if the clipboard is blocked)"),
        h("pre", { className: "mc-brief-pre" }, d.briefing || "")),
      d.frame && d.frame.summary ? h("div", { className: "mc-sum" }, d.frame.summary) : null,
      h("div", { className: "mc-body" }, t.body || "(no body)"),
      h("div", { className: "mc-muted" }, "ask (newest park reason)"),
      h("div", { className: "mc-ask" }, d.ask || "(none recorded)"),
      h("div", { className: "mc-muted" }, "runs: " + d.runs.length + " · comments: " + d.comments.length),
      h("div", { className: "mc-cards" }, d.comments.slice(0, 8).map(function (c) {
        return h("div", { key: c.id, className: "mc-cmt" },
          h("div", { className: "mc-row-m" }, h("span", null, c.author || "?"), h("span", null, hhmm(c.created_at))),
          h("div", { className: "mc-cmt-b" }, c.body.length > 1200 ? c.body.slice(0, 1200) + "…" : c.body));
      })));
  }

  // ---------------------------------------------------------------- page
  function MissionControl() {
    var poll = usePoll("/overview", 30000);
    var [board, setBoard] = useState("all");
    var [q, setQ] = useState("");
    var [detail, setDetail] = useState(null);
    var [showParked, setShowParked] = useState(false);
    var d = poll.state.data;

    if (poll.state.error && !d) {
      return h("div", { className: "mc-root" }, h("div", { className: "mc-err" }, "Mission Control backend error: " + poll.state.error));
    }
    if (!d) return h("div", { className: "mc-root" }, h("div", { className: "mc-muted" }, "loading mission control…"));

    var t = d.totals;
    var match = function (x) {
      if (board !== "all" && x.board !== board) return false;
      if (!q.trim()) return true;
      var s = q.toLowerCase();
      return ((x.title || "") + " " + (x.assignee || "") + " " + (x.id || "")).toLowerCase().indexOf(s) !== -1;
    };
    var framed = (d.awaiting.framed || []).filter(match);
    var parked = (d.awaiting.parked || []).filter(match);
    var flight = (d.in_flight || []).filter(match);
    var boards = d.boards || [];
    var sched = d.schedules || { failing: [], upcoming: [] };

    return h("div", { className: "mc-root" },
      h("div", { className: "mc-head" },
        h("div", { className: "mc-title" }, "Mission Control"),
        h("div", { className: "mc-sub" }, "updated " + hhmm(d.generated_at) + " · auto-refresh 30s"),
        h("div", { className: "mc-spacer" }),
        h("div", { className: "mc-filter" },
          h("button", { className: "mc-chip" + (board === "all" ? " mc-chip-on" : ""), onClick: function () { setBoard("all"); } }, "all boards"),
          boards.map(function (b) {
            return h("button", { key: b.slug, className: "mc-chip" + (board === b.slug ? " mc-chip-on" : ""), onClick: function () { setBoard(b.slug); } },
              b.slug + " · " + Object.keys(b.counts || {}).reduce(function (n, k) { return n + b.counts[k]; }, 0));
          }),
          h("input", { className: "mc-input", placeholder: "filter…", value: q, onChange: function (e) { setQ(e.target.value); } }),
          h("button", { className: "mc-btn", onClick: poll.load }, "refresh"))),

      h("div", { className: "mc-stats" },
        h(Stat, { k: "waiting on you", v: t.framed, n: t.needs_input + " parked in total" }),
        h(Stat, { k: "running now", v: t.running, n: "bot runs in flight" }),
        h(Stat, { k: "shipped today", v: t.done_today, n: t.created_today + " created today" }),
        h(Stat, { k: "capability blocks", v: t.blocked_capability, n: "blocked, not needing input" }),
        h(Stat, { k: "schedules failing", v: (sched.failing || []).length, n: (sched.enabled || 0) + " of " + (sched.total || 0) + " enabled" })),

      h("div", { className: "mc-grid" },
        h("div", { className: "mc-cards" },
          h(Panel, {
            title: "Waiting on you — answer in place",
            right: h("div", { className: "mc-actions" }, h(Pill, { kind: "mc-pill-me" }, framed.length + " shown"), h(Pill, null, d.awaiting.framed_total + " framed"))
          },
            framed.length ? framed.map(function (i) { return h(AskRow, { key: i.board + i.id, item: i, onDone: poll.load }); })
              : h("div", { className: "mc-muted" }, "Nothing framed for you right now."),
            h("div", { className: "mc-actions" },
              h("button", { className: "mc-btn", onClick: function () { setShowParked(!showParked); } },
                (showParked ? "hide" : "show") + " parks with no framed ask (" + d.awaiting.parked_total + ")")),
            showParked ? h("div", { className: "mc-cards mc-cards-scroll" }, parked.map(function (i) {
              return h("div", { key: i.board + i.id, className: "mc-row" },
                h("div", { className: "mc-row-t" }, i.title),
                h("div", { className: "mc-row-m" },
                  h(Pill, null, i.board_title || i.board), i.assignee ? h("span", null, "asked by " + i.assignee) : null,
                  h("span", null, "parked " + dur(i.age_seconds)),
                  h(IdChip, { id: i.id }),
                  h("a", { className: "mc-link", onClick: function () { setDetail({ board: i.board, id: i.id }); } }, "open card")),
                i.ask ? h("div", { className: "mc-ask" }, i.ask.slice(0, 260) + "…") : null,
                h("div", { className: "mc-actions" },
                  h("button", { className: "mc-btn mc-btn-p", onClick: function () { setDetail({ board: i.board, id: i.id }); } }, "read & answer")));
            })) : null),

          detail ? h(CardDetail, { target: detail, onClose: function () { setDetail(null); } }) : null,

          h(Panel, { title: "In flight — what the bots are doing now", right: h(Pill, { kind: "mc-pill-run" }, flight.length + " running") },
            flight.length ? h("table", { className: "mc-table" },
              h("thead", null, h("tr", null,
                h("th", null, ""), h("th", null, "card"), h("th", null, "profile"), h("th", null, "elapsed"), h("th", null, "heartbeat"))),
              h("tbody", null, flight.map(function (r) {
                return h("tr", { key: r.board + r.id },
                  h("td", null, h(Pill, null, r.board)),
                  h("td", null, h("a", { className: "mc-link", onClick: function () { setDetail({ board: r.board, id: r.id }); } }, r.title),
                    h("div", { className: "mc-row-m" },
                      h(IdChip, { id: r.id }),
                      r.project_id ? h("span", null, r.project_id) : null)),
                  h("td", null, r.profile || "—"),
                  h("td", null, dur(r.elapsed_seconds)),
                  h("td", null, r.heartbeat_age_seconds != null && r.heartbeat_age_seconds > 300
                    ? h(Pill, { kind: "mc-pill-warn" }, "stale " + dur(r.heartbeat_age_seconds))
                    : h("span", { className: "mc-muted" }, dur(r.heartbeat_age_seconds))));
              }))) : h("div", { className: "mc-muted" }, "No card is running right now.")),

          h(Panel, { title: "Shipped today", right: h(Pill, null, t.done_today + " done") },
            (d.recent_done || []).length ? h("div", { className: "mc-cards" }, d.recent_done.map(function (c) {
              return h("div", { key: c.board + c.id, className: "mc-row" },
                h("div", { className: "mc-row-t" }, c.title),
                h("div", { className: "mc-row-m" }, h(Pill, null, c.board), h("span", null, c.assignee || "—"),
                  h("span", null, hhmm(c.completed_at)), h("span", null, c.runs + " runs"),
                  h(IdChip, { id: c.id }),
                  h("a", { className: "mc-link", onClick: function () { setDetail({ board: c.board, id: c.id }); } }, "open card")));
            })) : h("div", { className: "mc-muted" }, "Nothing completed in the last day."))),

        h("div", { className: "mc-cards" },
          h(Panel, { title: "Boards" },
            boards.map(function (b) {
              var c = b.counts || {};
              return h("div", { key: b.slug, className: "mc-row" },
                h("div", { className: "mc-row-t" }, b.title + " (" + b.slug + ")"),
                h("div", { className: "mc-row-m" },
                  h(Pill, { kind: c.running ? "mc-pill-run" : "" }, (c.running || 0) + " running"),
                  h(Pill, { kind: c.blocked ? "mc-pill-warn" : "" }, (c.blocked || 0) + " blocked"),
                  h(Pill, null, (c.todo || 0) + " todo"),
                  h(Pill, null, (c.triage || 0) + " triage"),
                  h(Pill, null, (c.done || 0) + " done"),
                  h(Pill, null, (c.archived || 0) + " archived")));
            })),

          h(Panel, { title: "Estate activity — last 12h" },
            h(Bars, { points: d.pulse || [] }),
            h("div", { className: "mc-row-m" },
              h("span", null, (d.pulse || []).reduce(function (n, p) { return n + p.count; }, 0) + " non-heartbeat events"),
              h("span", null, "across " + boards.length + " boards"))),

          h(Panel, {
            title: "Schedule",
            right: (sched.failing || []).length ? h(Pill, { kind: "mc-pill-warn" }, sched.failing.length + " failing") : h(Pill, { kind: "mc-pill-run" }, "all ok")
          },
            (sched.failing || []).length ? h("div", { className: "mc-cards" }, sched.failing.map(function (j) {
              return h("div", { key: j.profile + j.id, className: "mc-row" },
                h("div", { className: "mc-row-t" }, j.name || j.id),
                h("div", { className: "mc-row-m" },
                  h(Pill, { kind: "mc-pill-warn" }, "streak " + j.failure_streak),
                  h(Pill, null, j.profile), h("span", null, j.schedule || ""),
                  h("span", null, "last: " + (j.last_status || "—")),
                  j.deliver ? h("span", null, "deliver: " + j.deliver) : null),
                j.last_error ? h("div", { className: "mc-ask" }, String(j.last_error).slice(0, 240)) : null);
            })) : null,
            h("div", { className: "mc-muted" }, "next up"),
            h("table", { className: "mc-table" },
              h("thead", null, h("tr", null, h("th", null, "when"), h("th", null, "job"), h("th", null, "profile"))),
              h("tbody", null, (sched.upcoming || []).slice(0, 10).map(function (j) {
                return h("tr", { key: j.profile + j.id },
                  h("td", null, hhmm(j.next_run_at)),
                  h("td", null, j.name || j.id),
                  h("td", null, h("span", { className: "mc-muted" }, j.profile)));
              })))),
        )));
  }

  window.__HERMES_PLUGINS__.register("mission-control", MissionControl);
})();
