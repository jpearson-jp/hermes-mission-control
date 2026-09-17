/* Mission Control — the hub page: what is running, what is waiting, what shipped, what is due. */

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
