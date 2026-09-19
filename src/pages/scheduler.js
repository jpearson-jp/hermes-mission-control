/* Mission Control — Scheduler: what the ONE ranking actually did.
 *
 * The three facts the epic names, rendered live off the hub's /scheduler route (which reads the
 * same measurement module the cron watcher escalates from — one implementation, two consumers):
 * per-board share of the tick budget actually spent, the wait-time distribution of takeable cards
 * (chosen and still waiting), and the starvation state of every board.
 *
 * Everything here is theme-aware and hand-rolled (no chart library): bars are divs, the share
 * stack is one row, and every number is the payload's — this page computes nothing itself.
 */

  /* `pct` is page-local on purpose: the page bundles share `core.js` but not each other, so a helper
   * defined in insights.js is NOT available here. */
  function pct(frac) {
    if (frac == null) return "—";
    return Math.round(frac * 100) + "%";
  }

  var SCHED_REASON = {
    "starved": "STARVED",
    "at-board-cap": "at its own ceiling — not starvation",
    "no-budget-elsewhere": "no budget anywhere — not starvation",
    "got-budget": "it got budget while the card waited",
    "below-threshold": "below the starvation threshold",
    "no-ready-cards": "no ready cards",
    "no-spawnable-cards": "no spawnable card (assignee is not a live lane)",
    "takeability-unmeasured": "takeability UNMEASURED — the profile list could not be read"
  };

  function schedReason(r) {
    return SCHED_REASON[r] || r || "—";
  }

  function SharePanel(props) {
    var d = props.data;
    var rows = (d.boards || []).filter(function (b) { return b.spawns_window > 0; })
      .sort(function (a, b) { return b.spawns_window - a.spawns_window; })
      .map(function (b) {
        return {
          label: b.slug, value: b.spawns_window, cls: "mc-c-run",
          sub: pct(b.share) + " · " + num(b.ready_spawnable) + " waiting",
          title: b.slug + ": " + num(b.spawns_window) + " spawns (" + pct(b.share) +
                 " of the window's budget), " + num(b.ready_spawnable) + " spawnable ready card(s)"
        };
      });
    var segs = (d.boards || []).filter(function (b) { return b.share; })
      .sort(function (a, b) { return b.share - a.share; })
      .map(function (b, i) {
        return { label: b.slug, value: Math.round(b.share * 1000),
                 cls: ["mc-c-run", "mc-c-2", "mc-c-3", "mc-c-4", "mc-c-todo"][i % 5] };
      });
    return h(Panel, {
      title: "Dispatch share",
      sub: "worker spawns per board in the last " + dur(d.window_seconds) +
           " — the budget is spent on spawns, so this IS the share",
      right: h(Pill, null, num((d.totals || {}).spawns) + " spawns")
    },
      h(HBars, { rows: rows }),
      segs.length ? h("div", { className: "mc-row-m" }, h("span", null, "share of the window: "),
        h("div", { style: { flex: "1 1 auto" } }, h(StackBar, { segments: segs }))) : null,
      h("div", { className: "mc-row-m" },
        "A board with no row spawned nothing in the window. Its waiting cards are still counted " +
        "below — a zero share is only starvation when something else took the budget."));
  }

  function WaitPanel(props) {
    var d = props.data;
    var rows = (d.boards || []).slice().sort(function (a, b) {
      return (b.oldest_ready_seconds || -1) - (a.oldest_ready_seconds || -1);
    });
    var body = rows.map(function (b) {
      var c = b.wait_chosen || {}, w = b.wait_waiting || {};
      return h("tr", { key: b.slug },
        h("td", null, b.slug,
          b.starved ? h(Pill, { kind: "mc-pill-warn" }, "starved") : null),
        h("td", null, h(Pill, { kind: (b.oldest_ready_seconds || 0) > 3600 ? "mc-pill-warn" : "" },
          dur(b.oldest_ready_seconds))),
        h("td", null, num(b.ready_spawnable), h("span", { className: "mc-muted" },
          b.ready_nonspawnable ? " (+" + b.ready_nonspawnable + " non-lane)" : "")),
        h("td", null, c.n ? dur(c.p50) + " / " + dur(c.p90) + " / " + dur(c.max) : "—"),
        h("td", null, h("span", { className: "mc-muted" }, num(c.n))),
        h("td", null, w.n ? dur(w.p50) + " / " + dur(w.p90) + " / " + dur(w.max) : "—"),
        h("td", null, h("span", { className: "mc-muted" }, num(w.n))));
    });
    return h(Panel, {
      title: "Wait-time distribution",
      sub: "how long a takeable card sat before it was CHOSEN, and how long the cards waiting " +
           "right now have sat — p50 / p90 / max",
      right: h(Pill, { kind: ((d.totals || {}).waiting_p50 || 0) > 3600 ? "mc-pill-warn" : "" },
        "waiting p50 " + dur((d.totals || {}).waiting_p50))
    },
      h("table", { className: "mc-table" },
        h("thead", null, h("tr", null,
          h("th", null, "board"), h("th", null, "oldest wait"), h("th", null, "ready"),
          h("th", null, "chosen p50/p90/max"), h("th", null, "n"),
          h("th", null, "waiting p50/p90/max"), h("th", null, "n"))),
        h("tbody", null, body)),
      h("div", { className: "mc-row-m" },
        "Both clocks are the ranking's OWN: a card's wait is measured from the newest event that " +
        "(re)opened its lane (promoted / created / unblocked / review_reopened / reclaimed / " +
        "assigned), which is the age the scheduler's aging term ages by."),
      h("div", { className: "mc-row-m" },
        "CHOSEN is timed on the spawn event inside the window; WAITING is the queue as it stands " +
        "now. The second column is the one that shows starvation before it bites."));
  }

  function StarvationPanel(props) {
    var d = props.data;
    var alerts = d.alerts || [];
    var rows = (d.boards || []).filter(function (b) { return b.ready_total > 0; })
      .sort(function (a, b) {
        return (b.oldest_ready_seconds || 0) - (a.oldest_ready_seconds || 0);
      })
      .map(function (b) {
        return h("tr", { key: b.slug },
          h("td", null, b.slug),
          h("td", null, h(Pill, { kind: b.starved ? "mc-pill-warn" : "" }, schedReason(b.starve_reason))),
          h("td", null, dur(b.oldest_ready_seconds)),
          h("td", null, num(b.spawns_window)),
          h("td", null, num(b.spawns_since_oldest)),
          h("td", null, num(b.running) + " / " + (b.cap == null ? "—" : num(b.cap))));
      });
    return h(Panel, {
      title: "Starvation",
      sub: "a board with takeable cards whose share stayed at zero while the budget went " +
           "elsewhere, for longer than " + dur(d.starve_seconds),
      right: alerts.length
        ? h(Pill, { kind: "mc-pill-warn" }, alerts.length + " starved")
        : h(Pill, { kind: "mc-pill-run" }, "none")
    },
      alerts.length
        ? h("div", { className: "mc-cards" }, alerts.map(function (a) {
            return h("div", { key: a.board, className: "mc-row" },
              h("div", { className: "mc-row-t" }, a.board_title || a.board),
              h("div", { className: "mc-row-m" },
                h(Pill, { kind: "mc-pill-warn" }, "starved"),
                h("span", null, "oldest takeable card waiting " + dur(a.oldest_ready_seconds)),
                h("span", null, "threshold " + dur(a.threshold_seconds)),
                h("span", null, num(a.spawns_elsewhere_in_span) + " spawns went elsewhere in " +
                  "that span"),
                h("span", null, "live runs " + num(a.running) +
                  (a.cap == null ? "" : " / cap " + num(a.cap)))));
          }))
        : h("div", { className: "mc-muted" }, "No board is starved."),
      rows.length ? h("table", { className: "mc-table" },
        h("thead", null, h("tr", null,
          h("th", null, "board"), h("th", null, "state"), h("th", null, "oldest wait"),
          h("th", null, "spawns/win"), h("th", null, "spawns in span"), h("th", null, "runs/cap"))),
        h("tbody", null, rows)) : null,
      h("div", { className: "mc-row-m" },
        "The predicate, in full: takeable ready cards AND the oldest one waiting at least the " +
        "threshold AND zero spawns on that board in that whole span AND the estate spawning on " +
        "some OTHER board inside it AND the board below its own ceiling. Every clause is measured " +
        "off the board — none of them needs a state file."));
  }

  function HowToReadPanel(props) {
    var d = props.data;
    var s = d.scheduler || {}, caps = d.caps || {}, t = d.totals || {};
    var w = d.watcher || {};
    return h(Panel, { title: "How to read this", sub: "definitions and the alerting half's liveness" },
      h("div", { className: "mc-row-m" },
        h(Pill, { kind: s.mode === "global" ? "mc-pill-run" : "" }, "mode " + (s.mode || "—")),
        h("span", null, "aging " + num(s.aging_boost_per_hour) + "/h"),
        h("span", null, "weights " + (Object.keys(s.board_weights || {}).length
          ? Object.keys(s.board_weights).map(function (k) { return k + "=" + s.board_weights[k]; }).join(", ")
          : "none")),
        h("span", null, "host cap " + (caps.host == null ? "—" : num(caps.host))),
        h("span", null, "board cap " + (caps.default_board == null ? "—" : num(caps.default_board)))),
      s.mode === "per_board"
        ? h("div", { className: "mc-row-m" },
            "Mode is per_board: each board spends its own tick on the top of its own queue, and " +
            "the shared host budget goes to whichever board ticks first. The three facts below " +
            "are exactly what the flip to `global` will have to be judged on.")
        : null,
      h("div", { className: "mc-row-m" },
        "share = this board's spawns ÷ every board's spawns in the window. Undefined (—) when the " +
        "estate spawned nothing at all: a share of zero spawns is not zero percent."),
      h("div", { className: "mc-row-m" },
        "read on " + num(t.boards) + " board(s) at " + (d.root || "—") +
        (d.takeability_measured ? "" : " · TAKEABILITY UNMEASURED (no profile list)") +
        (d.strays && d.strays.length ? " · " + d.strays.length + " stray file(s) skipped" : "")),
      h("div", { className: "mc-row-m" },
        h(Pill, { kind: w.stale_seconds == null || w.stale_seconds > 2700 ? "mc-pill-warn" : "" },
          "alerting half " + (w.last_run_at ? "ran " + dur(w.stale_seconds) + " ago" : "has not run")),
        w.last_changed_at ? h("span", null, "last change reported " + hhmm(w.last_changed_at)) : null,
        w.filings && w.filings.length ? h("span", null, w.filings.length + " card(s) filed") : null,
        w.why ? h("span", null, w.why) : null),
      h("div", { className: "mc-row-m" },
        "The numbers here are measured LIVE on every load by the same module " +
        "(`lib/scheduler_telemetry.py`) the cron watcher escalates from — one implementation, two " +
        "consumers. The watcher's own record above is a state file: it says when the ALERTING half " +
        "last ran, and is never the source of a number on this page."));
  }

  function SchedulerPage() {
    var poll = usePoll("/scheduler", 30000);
    var d = poll.state.data;
    if (poll.state.error && !d) {
      return h("div", { className: "mc-root" },
        h("div", { className: "mc-err" }, "backend error: " + poll.state.error));
    }
    if (!d) return h("div", { className: "mc-root" }, h("div", { className: "mc-muted" },
      "measuring the scheduler…"));
    if (d.error) return h("div", { className: "mc-root" }, h("div", { className: "mc-err" }, d.error));

    var t = d.totals || {};
    var head = h(PageHead, {
      title: "Scheduler",
      sub: "what the ranking did · window " + dur(d.window_seconds) + " · starvation ≥ " +
           dur(d.starve_seconds) + " · updated " + hhmm(d.generated_at_iso) + " · auto-refresh 30s"
    }, h("div", { className: "mc-filter" },
      h("a", { className: "mc-btn", href: "/insights" }, "← Insights"),
      h("a", { className: "mc-btn", href: "/mission-control" }, "Mission Control →"),
      h("button", { className: "mc-btn", onClick: function () { poll.load(); } }, "refresh")));

    var kpis = h("div", { className: "mc-stats" },
      h(Stat, { k: "mode", v: (d.scheduler || {}).mode || "—",
                n: "per_board = each board spends its own tick",
                tone: (d.scheduler || {}).mode === "global" ? "run" : null }),
      h(Stat, { k: "spawns / window", v: num(t.spawns), n: "workers started, all boards" }),
      h(Stat, { k: "boards w/ takeable work", v: num(t.boards_with_spawnable),
                n: num(t.boards) + " boards read" }),
      h(Stat, { k: "starved", v: num(t.starved),
                n: (d.alerts || []).length ? (d.alerts || []).map(function (a) { return a.board; }).join(", ")
                                           : "no board lost its share",
                tone: (d.alerts || []).length ? "warn" : null }),
      h(Stat, { k: "median wait (chosen)", v: dur(t.chosen_p50),
                n: "p90 " + dur(t.chosen_p90) + " · " + num(t.chosen_measured) + " spawns timed" }),
      h(Stat, { k: "median wait (waiting now)", v: dur(t.waiting_p50),
                n: "p90 " + dur(t.waiting_p90) + " · " + num(t.ready) + " cards ready",
                tone: (t.waiting_p90 || 0) > 3600 ? "warn" : null }),
      h(Stat, { k: "running now", v: num(t.running), n: "live runs across every board" }));

    return h("div", { className: "mc-root" },
      head, kpis,
      h("div", { className: "mc-grid" },
        h("div", { className: "mc-cards" }, h(SharePanel, { data: d }), h(WaitPanel, { data: d })),
        h("div", { className: "mc-cards" }, h(StarvationPanel, { data: d }),
          h(HowToReadPanel, { data: d }))));
  }
