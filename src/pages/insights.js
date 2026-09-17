/* Mission Control — Insights: the estate at a glance. Throughput, what is stuck, who is working,
 * what is failing, and how fast work actually moves. Hand-rolled SVG/CSS, theme-aware. */

  var STATUS_CLS = {
    running: "mc-c-run", ready: "mc-c-run", todo: "mc-c-todo", triage: "mc-c-triage",
    blocked: "mc-c-blocked", done: "mc-c-done", archived: "mc-c-arch", review: "mc-c-triage"
  };

  function mins(sec) {
    if (sec == null) return "—";
    return dur(sec);
  }

  function InsightsPage() {
    var poll = usePoll("/insights", 60000);
    var [detail, setDetail, detailNode] = useDetail();
    var d = poll.state.data;

    if (poll.state.error && !d) return h("div", { className: "mc-root" }, h("div", { className: "mc-err" }, "backend error: " + poll.state.error));
    if (!d) return h("div", { className: "mc-root" }, h("div", { className: "mc-muted" }, "measuring the estate…"));

    var sm = d.status_mix || {};
    var runs = d.runs || {};
    var cycle = d.cycle || {};
    var stuck = d.stuck || { aging: [], aging_by_kind: {}, oldest: [], total: 0 };
    var sched = d.schedules || { failing: [], upcoming: [] };

    var head = h(PageHead, {
      title: "Insights",
      sub: "updated " + hhmm(d.generated_at) + " · window " + d.window_hours + "h · auto-refresh 60s"
    }, h("div", { className: "mc-filter" },
      h("a", { className: "mc-btn", href: "/mission-control" }, "← Mission Control"),
      h("a", { className: "mc-btn", href: "/waiting-on-me" }, "Waiting on me →"),
      h("button", { className: "mc-btn", onClick: poll.load }, "refresh")));

    var kpis = h("div", { className: "mc-stats" },
      h(Stat, { k: "running now", v: num(sm.running || 0), n: "cards with a live run", tone: "run" }),
      h(Stat, { k: "created / 24h", v: num(d.window_hours ? (d.throughput || []).reduce(function (n, r) { return n + r.created; }, 0) : 0), n: "cards opened" }),
      h(Stat, { k: "completed / 24h", v: num((d.throughput || []).reduce(function (n, r) { return n + r.completed; }, 0)), n: "cards finished" }),
      h(Stat, { k: "median run", v: mins(runs.duration_median_s), n: "p90 " + mins(runs.duration_p90_s) + " · " + num(runs.measured) + " runs" }),
      h(Stat, { k: "median cycle", v: mins(cycle.median_s), n: "card open→done · p90 " + mins(cycle.p90_s) }),
      h(Stat, { k: "stuck", v: num(stuck.total), n: "blocked or triage", tone: "warn" }),
      h(Stat, { k: "waiting on you", v: num((d.awaiting || {}).framed || 0),
                n: "framed asks · oldest " + mins((d.awaiting || {}).oldest_seconds),
                tone: ((d.awaiting || {}).framed || 0) ? "warn" : null }));

    var pulse = h(Panel, { title: "Live pulse", sub: "non-heartbeat events per 10 minutes, last 2 hours" },
      h(Spark, { points: d.spark || [], height: 90, label: "estate activity" }));

    var throughput = h(Panel, {
      title: "Throughput",
      sub: "per hour over " + d.window_hours + "h — opened, finished, newly blocked"
    },
      h(GroupedBars, {
        rows: d.throughput || [],
        series: [
          { key: "created", label: "opened", cls: "mc-c-run" },
          { key: "completed", label: "finished", cls: "mc-c-done" },
          { key: "blocked", label: "blocked", cls: "mc-c-blocked" }
        ]
      }));

    var mix = h(Panel, { title: "What state the estate is in", sub: num(Object.keys(sm).reduce(function (n, k) { return n + sm[k]; }, 0)) + " cards, all boards" },
      h(StackBar, {
        segments: ["running", "ready", "todo", "triage", "blocked", "done", "archived"].map(function (k) {
          return { label: k, value: sm[k] || 0, cls: STATUS_CLS[k] || "mc-c-arch" };
        })
      }));

    var kindRows = Object.keys(d.blocked_kinds || {}).sort(function (a, b) { return d.blocked_kinds[b] - d.blocked_kinds[a]; }).map(function (k) {
      return {
        label: k, value: d.blocked_kinds[k],
        cls: k === "needs_input" ? "mc-c-warn" : (k === "capability" ? "mc-c-4" : "mc-c-blocked"),
        title: k === "needs_input" ? "waiting on a human decision" : (k === "capability" ? "blocked by a missing capability" : k)
      };
    });
    var kinds = h(Panel, { title: "Why cards are stuck", sub: "by block kind" }, h(HBars, { rows: kindRows }));

    var kindNames = Object.keys(stuck.aging_by_kind || {});
    var agingRows = [];
    (stuck.aging || []).forEach(function (b, i) {
      agingRows.push({
        label: b.label, value: b.count,
        cls: ["mc-c-ok", "mc-c-ok", "mc-c-warn", "mc-c-bad", "mc-c-bad"][i] || "mc-c-warn",
        title: "how long cards have been blocked"
      });
    });
    var oldestTable = h("table", { className: "mc-table" },
      h("thead", null, h("tr", null,
        h("th", null, "waiting"), h("th", null, "card"), h("th", null, "kind"), h("th", null, "owner"))),
      h("tbody", null, (stuck.oldest || []).map(function (r) {
        return h("tr", { key: r.board + r.id },
          h("td", null, h(Pill, { kind: r.age_seconds > 86400 ? "mc-pill-warn" : "" }, dur(r.age_seconds))),
          h("td", null, h("a", { className: "mc-link", onClick: function () { setDetail({ board: r.board, id: r.id }); } }, r.title),
            h("div", { className: "mc-row-m" }, h(IdChip, { id: r.id }))),
          h("td", null, h(Pill, null, r.kind)),
          h("td", null, h("span", { className: "mc-muted" }, r.assignee || "—")));
      })));
    var stuckPanel = h(Panel, {
      title: "Stuck work",
      sub: num(stuck.total) + " cards blocked or in triage — the oldest " + (stuck.oldest || []).length + " below"
    }, h(HBars, { rows: agingRows }), oldestTable);

    var runRows = Object.keys(runs.running_by_profile || {}).sort(function (a, b) {
      return runs.running_by_profile[b] - runs.running_by_profile[a];
    }).map(function (p) {
      return { label: p, value: runs.running_by_profile[p], cls: "mc-c-run", sub: "+" + ((runs.done_24h_by_profile || {})[p] || 0) + " done/24h" };
    });
    var people = h(Panel, {
      title: "Who is working",
      sub: num(runs.started_24h) + " runs started and " + num(runs.finished_24h) + " finished in 24h"
    }, h(HBars, { rows: runRows }));

    var failRows = (d.failures || []).map(function (f) {
      return h("div", { key: f.board + f.id, className: "mc-row" },
        h("div", { className: "mc-row-t" }, f.title),
        h("div", { className: "mc-row-m" },
          h(Pill, { kind: f.failures > 1 ? "mc-pill-warn" : "" }, f.failures + " consecutive"),
          h("span", null, f.assignee || "—"),
          h(IdChip, { id: f.id }),
          h("a", { className: "mc-link", onClick: function () { setDetail({ board: f.board, id: f.id }); } }, "open card")),
        f.error ? h("div", { className: "mc-ask" }, f.error) : null);
    });
    var failPanel = h(Panel, {
      title: "Failing work",
      right: (d.failures || []).length ? h(Pill, { kind: "mc-pill-warn" }, (d.failures || []).length + " cards") : h(Pill, { kind: "mc-pill-run" }, "none")
    }, (d.failures || []).length ? h("div", { className: "mc-cards" }, failRows) : h("div", { className: "mc-muted" }, "No card is carrying a failure streak."));

    var schedBad = (sched.failing || []).length;
    var schedPanel = h(Panel, {
      title: "Schedule health",
      sub: (sched.enabled || 0) + " enabled · " + (sched.paused || 0) + " paused · " + (sched.total || 0) + " total jobs",
      right: schedBad ? h(Pill, { kind: "mc-pill-warn" }, schedBad + " failing") : h(Pill, { kind: "mc-pill-run" }, "all ok")
    },
      (sched.failing || []).length ? h("div", { className: "mc-cards" }, (sched.failing || []).map(function (j) {
        return h("div", { key: j.profile + j.id, className: "mc-row" },
          h("div", { className: "mc-row-t" }, j.name || j.id),
          h("div", { className: "mc-row-m" },
            h(Pill, { kind: "mc-pill-warn" }, "streak " + j.failure_streak),
            h(Pill, null, j.profile),
            h("span", null, j.schedule || ""),
            h("span", null, "last: " + (j.last_status || "—")),
            j.deliver ? h("span", null, "deliver: " + j.deliver) : null));
      })) : null,
      h("table", { className: "mc-table" },
        h("thead", null, h("tr", null, h("th", null, "next run"), h("th", null, "job"), h("th", null, "profile"))),
        h("tbody", null, (sched.upcoming || []).map(function (j) {
          return h("tr", { key: j.profile + j.id },
            h("td", null, hhmm(j.next_run_at)),
            h("td", null, j.name || j.id),
            h("td", null, h("span", { className: "mc-muted" }, j.profile)));
        }))));

    return h("div", { className: "mc-root" },
      head, kpis,
      h("div", { className: "mc-grid" },
        h("div", { className: "mc-cards" }, pulse, throughput, stuckPanel, failPanel),
        h("div", { className: "mc-cards" }, mix, kinds, people, schedPanel)),
      detailNode);
  }
