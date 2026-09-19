/* Mission Control — the hub page: what is running, what is waiting, what shipped, what is due. */

/* --- Project flow: the value-stream funnel, on the hub page ---
   Same shape as the desktop half's Flow page and the same /flow payload: band thickness is how
   many cards are in that stage right now, the outlined band is the constraint, and every stage
   says whether it is flowing, slowing, backed up, idle, or a queue whose exit is not
   instrumented. Stage ids and labels come from the payload, so the backend owns the model. */

  function flowVerdict(s) {
    if (!s.wip) return { tone: "dim", label: "idle — no load" };
    if (s.flow === "n/a") return { tone: "ok", label: "count" };
    if (s.constraint) return { tone: "hot", label: "CONSTRAINT" };
    if (s.flow === "unmeasured") return { tone: "warn", label: "queue · exit not instrumented" };
    if (s.wait_h == null) return { tone: "warn", label: "no measured exit" };
    if (s.wait_h <= 2) return { tone: "ok", label: "flowing" };
    if (s.wait_h <= 12) return { tone: "warn", label: "slowing" };
    return { tone: "hot", label: "backed up" };
  }

  function flowStageLine(s) {
    var bits = [];
    if (s.wip) bits.push(num(s.wip) + " here");
    if (s.median_age_h != null) bits.push("median " + s.median_age_h + "h");
    if (s.oldest_age_h != null && s.oldest_age_h !== s.median_age_h) bits.push("oldest " + s.oldest_age_h + "h");
    if (s.flow === "unmeasured") bits.push("flow not instrumented");
    else if (s.flow !== "n/a") bits.push(num(s.out) + " out / " + (s.window_hours || 168) + "h");
    if (s.wait_h != null && s.wip) bits.push("~" + num(s.wait_h) + "h to clear");
    return bits.join(" · ");
  }

  /* The pipe: bands sized by WIP, trapezoid links between them, rework arcs underneath. */
  function FlowPipe(props) {
    var rows = (props.stages || []).filter(function (s) { return !s.terminal; });
    if (!rows.length) return h("div", { className: "mc-muted" }, "nothing in the flow");
    var W = 1000, H = props.height || 190, cy = H * 0.4;
    var maxWip = Math.max.apply(null, [1].concat(rows.map(function (s) { return s.wip || 0; })));
    var bh = function (v) { return v ? Math.max(3, (v / maxWip) * (H * 0.28)) : 1.5; };
    var slot = W / rows.length;
    var pad = Math.min(20, slot * 0.18);
    var left = function (i) { return i * slot + pad; };
    var right = function (i) { return (i + 1) * slot - pad; };
    var centre = function (i) { return (left(i) + right(i)) / 2; };
    var index = {};
    rows.forEach(function (s, i) { index[s.id] = i; });

    var kids = [];
    for (var i = 0; i < rows.length - 1; i++) {
      var a = bh(rows[i].wip), b = bh(rows[i + 1].wip);
      kids.push(h("polygon", {
        key: "link-" + i,
        className: "mc-flow-link",
        "data-idle": (!rows[i].wip && !rows[i + 1].wip) ? "true" : undefined,
        points: [right(i).toFixed(1) + "," + (cy - a / 2).toFixed(1),
                 left(i + 1).toFixed(1) + "," + (cy - b / 2).toFixed(1),
                 left(i + 1).toFixed(1) + "," + (cy + b / 2).toFixed(1),
                 right(i).toFixed(1) + "," + (cy + a / 2).toFixed(1)].join(" ")
      }));
    }
    rows.forEach(function (s, i) {
      var hh = bh(s.wip);
      kids.push(h("rect", {
        key: "band-" + s.id,
        className: "mc-flow-band mc-flow-band-" + flowVerdict(s).tone,
        "data-hot": s.constraint ? "true" : undefined,
        x: left(i).toFixed(1), y: (cy - hh / 2).toFixed(1),
        width: Math.max(2, right(i) - left(i)).toFixed(1), height: hh.toFixed(1), rx: 3
      }));
    });
    rows.forEach(function (s, i) {
      kids.push(h("text", {
        key: "num-" + s.id, className: "mc-flow-num", textAnchor: "middle",
        x: centre(i).toFixed(1), y: (cy - H * 0.3).toFixed(1)
      }, num(s.wip)));
      kids.push(h("text", {
        key: "lbl-" + s.id, className: "mc-flow-lbl", textAnchor: "middle",
        x: centre(i).toFixed(1), y: (H * 0.84).toFixed(1)
      }, s.label));
    });
    (props.edges || [])
      .filter(function (e) { return e.direction === "rework" && index[e.from] != null && index[e.to] != null; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, 2)
      .forEach(function (e, k) {
        var a = index[e.from], b = index[e.to], y = H * (0.62 + k * 0.08);
        kids.push(h("path", {
          key: "rw-" + e.from + "-" + e.to, className: "mc-flow-rework",
          d: "M " + centre(a).toFixed(1) + "," + (cy + bh(rows[a].wip) / 2).toFixed(1) +
             " C " + centre(a).toFixed(1) + "," + y.toFixed(1) + " " +
             centre(b).toFixed(1) + "," + y.toFixed(1) + " " +
             centre(b).toFixed(1) + "," + (cy + bh(rows[b].wip) / 2).toFixed(1)
        }));
      });

    return h("svg", {
      className: "mc-flow-svg", viewBox: "0 0 " + W + " " + H, preserveAspectRatio: "none",
      role: "img", "aria-label": props.label || "value stream"
    }, kids);
  }

  function FlowStageGrid(props) {
    var rows = (props.stages || []).filter(function (s) { return !s.terminal; });
    return h("div", { className: "mc-flow-stages" }, rows.map(function (s) {
      var v = flowVerdict(s);
      return h("div", { key: s.id, className: "mc-flow-stage", "data-tone": v.tone },
        h("div", { className: "mc-flow-stage-h" },
          h("span", { className: "mc-flow-stage-t" }, s.label),
          h(Pill, { kind: v.tone === "hot" ? "mc-pill-warn" : "" }, v.label)),
        h("div", { className: "mc-flow-stage-v" }, num(s.wip)),
        h("div", { className: "mc-flow-stage-m" }, flowStageLine(s)));
    }));
  }

  function pipelineStagesWeb(pl) {
    if (!pl || !pl.measured) return [];
    var b = pl.pr_buckets || {}, dp = pl.deploy || {};
    var mk = function (id, label, wip) { return { id: id, label: label, wip: wip || 0, terminal: false, flow: "n/a" }; };
    return [mk("pr_open", "PRs open", pl.prs_open), mk("ci_run", "CI running", b.ci_running),
      mk("ci_fail", "CI failing", b.ci_failing), mk("conflict", "Conflicts", b.conflicts),
      mk("review", "Awaiting review", b.awaiting_review), mk("mergeable", "Ready to merge", b.mergeable),
      mk("merged", "Merged 7d", pl.prs_merged_7d), mk("deploy", "Deploys running", dp.in_progress)];
  }

  function ProjectFlowBlock(props) {
    var p = props.project;
    var stages = p.stages || [];
    var c = stages.find(function (s) { return s.constraint; });
    var pl = p.pipeline || {};
    return h("div", { className: "mc-flow-proj" },
      h("div", { className: "mc-flow-proj-h" },
        h("strong", null, p.name),
        h(Pill, null, "board " + p.board),
        p.repo ? h("span", { className: "mc-muted" }, p.repo) : null,
        c && c.wip
          ? h(Pill, { kind: "mc-pill-warn" }, "constraint · " + c.label + " · " + num(c.wip) + " waiting")
          : h("span", { className: "mc-muted" }, "nothing in flight")),
      !p.board_found
        ? h("div", { className: "mc-muted" }, "no kanban board on this box yet, so there is no flow to measure")
        : h(FlowPipe, { stages: stages, edges: p.edges, height: 170, label: p.name + " value stream" }),
      p.board_found ? h(FlowStageGrid, { stages: stages }) : null,
      c && c.wait_h != null
        ? h("div", { className: "mc-row-m" },
            h("span", null, num(c.queue_hours) + " queue-hours in the constraint"),
            h("span", null, "~" + num(c.wait_h) + "h to clear at the measured exit rate"),
            c.net_per_day != null ? h("span", null, "net " + (c.net_per_day > 0 ? "+" : "") + c.net_per_day + "/day") : null)
        : null,
      p.repo
        ? h("div", { className: "mc-row-m" },
            pl.measured
              ? h("span", null, "PR/CI: " + num(pl.prs_open) + " open · " + num(pl.prs_merged_7d) + " merged in 7d · " +
                  num((pl.ci || {}).failed_24h) + " CI failures 24h · " + num((pl.deploy || {}).in_progress) + " deploys running")
              : h("span", { className: "mc-muted" }, pl.error ? "code pipeline unavailable: " + pl.error : "reading the code pipeline…"))
        : null);
  }

  function FlowPanel() {
    var poll = usePoll("/flow?window_hours=168", 60000);
    var d = poll.state.data;
    if (!d) return h(Panel, { title: "Project flow — where the work is stuck", sub: "loading…" },
      h("div", { className: "mc-muted" }, "reading the boards…"));
    var projects = (d.projects || []).filter(function (p) { return !p.unattached; });
    var boards = (d.projects || []).filter(function (p) { return p.unattached; });
    var constraints = projects.concat(boards)
      .map(function (p) { return { p: p, c: (p.stages || []).find(function (s) { return s.constraint; }) }; })
      .filter(function (x) { return x.c && x.c.wip > 0; })
      .sort(function (a, b) { return (b.c.queue_hours || 0) - (a.c.queue_hours || 0); });
    return h(Panel, {
      title: "Project flow — where the work is stuck",
      sub: (projects.length + boards.length) + " projects/boards · band thickness = cards in that stage now · updated " + hhmm(d.generated_at),
      right: h("a", { className: "mc-link", href: "/mission-control" }, "auto-refresh 60s")
    },
      constraints.length
        ? h("div", { className: "mc-flow-stages" }, constraints.slice(0, 6).map(function (x) {
            var v = flowVerdict(Object.assign({}, x.c, { constraint: true }));
            return h("div", { key: x.p.key, className: "mc-flow-stage", "data-tone": "hot" },
              h("div", { className: "mc-flow-stage-h" },
                h("span", { className: "mc-flow-stage-t" }, x.p.name),
                h(Pill, { kind: "mc-pill-warn" }, x.c.label)),
              h("div", { className: "mc-flow-stage-v" }, num(x.c.wip)),
              h("div", { className: "mc-flow-stage-m" },
                flowStageLine(Object.assign({}, x.c, { window_hours: x.p.window_hours }))));
          }))
        : h("div", { className: "mc-muted" }, "No stage is carrying a queue on any project right now."),
      h("div", { className: "mc-cards" }, projects.concat(boards).map(function (p) {
        return h(ProjectFlowBlock, { key: p.key, project: p });
      })),
      h("div", { className: "mc-muted" },
        "Occupancy is live; flow counts are per-card stage events over 7d; the code leg (PR → CI → merge → deploy) is cached ~10 minutes because each read is a GitHub API call. " +
        "A stage whose exit event is not instrumented says so instead of showing a zero."));
  }

  function OverviewPage() {
    var poll = usePoll("/overview", 30000);
    var [board, setBoard] = useState("all");
    var [q, setQ] = useState("");
    var [detail, setDetail, detailNode] = useDetail();
    var d = poll.state.data;

    if (poll.state.error && !d) return h("div", { className: "mc-root" }, h("div", { className: "mc-err" }, "Mission Control backend error: " + poll.state.error));
    if (!d) return h("div", { className: "mc-root" }, h("div", { className: "mc-muted" }, "loading mission control…"));

    var t = d.totals, boards = d.boards || [], sched = d.schedules || { failing: [], upcoming: [] };
    var match = function (x) {
      if (board !== "all" && x.board !== board) return false;
      if (!q.trim()) return true;
      var s = q.toLowerCase();
      return ((x.title || "") + " " + (x.assignee || "") + " " + (x.id || "")).toLowerCase().indexOf(s) !== -1;
    };
    var framed = (d.awaiting.framed || []).filter(match);
    var parked = (d.awaiting.parked || []).filter(match);
    var flight = (d.in_flight || []).filter(match);
    var pulsePts = (d.pulse || []).map(function (p) { return { t: p.bucket, count: p.count }; });

    return h("div", { className: "mc-root" },
      h(PageHead, { title: "Mission Control", sub: "updated " + hhmm(d.generated_at) + " · auto-refresh 30s" },
        h("div", { className: "mc-filter" },
          h("a", { className: "mc-btn", href: "/waiting-on-me" }, "Waiting on me →"),
          h("a", { className: "mc-btn", href: "/insights" }, "Insights →"),
          h("button", { className: "mc-btn", onClick: poll.load }, "refresh"))),

      h("div", { className: "mc-stats" },
        h(Stat, { k: "waiting on you", v: t.framed, n: t.needs_input + " parked in total",
                  tone: t.framed > 20 ? "warn" : null }),
        h(Stat, { k: "running now", v: t.running, n: "bot runs in flight" }),
        h(Stat, { k: "shipped today", v: t.done_today, n: t.created_today + " created today" }),
        h(Stat, { k: "capability blocks", v: t.blocked_capability, n: "blocked, not needing input" }),
        h(Stat, { k: "schedules failing", v: (sched.failing || []).length,
                  n: (sched.enabled || 0) + " of " + (sched.total || 0) + " enabled",
                  tone: (sched.failing || []).length ? "bad" : null })),

      h("div", { className: "mc-filter" },
        h("button", { className: "mc-chip" + (board === "all" ? " mc-chip-on" : ""), onClick: function () { setBoard("all"); } }, "all boards"),
        boards.map(function (b) {
          return h("button", { key: b.slug, className: "mc-chip" + (board === b.slug ? " mc-chip-on" : ""), onClick: function () { setBoard(b.slug); } },
            b.slug + " · " + Object.keys(b.counts || {}).reduce(function (n, k) { return n + b.counts[k]; }, 0));
        }),
        h("input", { className: "mc-input", placeholder: "filter…", value: q, onChange: function (e) { setQ(e.target.value); } })),

      h(FlowPanel, null),

      h("div", { className: "mc-grid" },
        h("div", { className: "mc-cards" },
          h(Panel, {
            title: "Waiting on you — answer in place",
            sub: framed.length + " shown of " + d.awaiting.framed_total + " framed",
            right: h("a", { className: "mc-link", href: "/waiting-on-me" }, "open the full inbox →")
          },
            framed.length ? framed.map(function (i) { return h(AskRow, { key: i.board + i.id, item: i, onDone: poll.load }); })
              : h("div", { className: "mc-muted" }, "Nothing framed for you right now."),
            h("div", { className: "mc-actions" },
              h("a", { className: "mc-link", href: "/waiting-on-me" }, "show all parks with no framed ask (" + d.awaiting.parked_total + ") →"))),

          detailNode,

          h(Panel, {
            title: "In flight — what the bots are doing now",
            right: h(Pill, { kind: "mc-pill-run" }, flight.length + " running")
          },
            flight.length ? h("table", { className: "mc-table" },
              h("thead", null, h("tr", null,
                h("th", null, ""), h("th", null, "card"), h("th", null, "profile"), h("th", null, "elapsed"), h("th", null, "heartbeat"))),
              h("tbody", null, flight.map(function (r) {
                return h("tr", { key: r.board + r.id },
                  h("td", null, h(Pill, null, r.board)),
                  h("td", null, h("a", { className: "mc-link", onClick: function () { setDetail({ board: r.board, id: r.id }); } }, r.title),
                    h("div", { className: "mc-row-m" }, h(IdChip, { id: r.id }))),
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
            h(Spark, { points: pulsePts, height: 64, label: "non-heartbeat events" }),
            h("div", { className: "mc-row-m" },
              h("span", null, num((d.pulse || []).reduce(function (n, p) { return n + p.count; }, 0)) + " events"),
              h("span", null, boards.length + " boards"))),

          h(Panel, {
            title: "Schedule",
            right: (sched.failing || []).length
              ? h(Pill, { kind: "mc-pill-warn" }, sched.failing.length + " failing")
              : h(Pill, { kind: "mc-pill-run" }, "all ok")
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
              h("tbody", null, (sched.upcoming || []).slice(0, 8).map(function (j) {
                return h("tr", { key: j.profile + j.id },
                  h("td", null, hhmm(j.next_run_at)),
                  h("td", null, j.name || j.id),
                  h("td", null, h("span", { className: "mc-muted" }, j.profile)));
              })))))));
  }
