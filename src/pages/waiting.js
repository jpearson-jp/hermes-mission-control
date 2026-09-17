/* Mission Control — the owner's inbox: every decision parked on Jesse, oldest first. */

  function WaitingPage() {
    var poll = usePoll("/waiting", 30000);
    var [q, setQ] = useState("");
    var [tag, setTag] = useState(null);
    var [showParked, setShowParked] = useState(false);
    var [detail, setDetail, detailNode] = useDetail();
    var d = poll.state.data;

    if (poll.state.error && !d) return h("div", { className: "mc-root" }, h("div", { className: "mc-err" }, "backend error: " + poll.state.error));
    if (!d) return h("div", { className: "mc-root" }, h("div", { className: "mc-muted" }, "loading your inbox…"));

    var t = d.totals || {};
    var match = function (x) {
      if (tag && (x.hints || []).indexOf(tag) === -1) return false;
      if (!q.trim()) return true;
      var s = q.toLowerCase();
      return ((x.title || "") + " " + (x.assignee || "") + " " + (x.id || "") + " " + (x.ask || "")).toLowerCase().indexOf(s) !== -1;
    };
    var framed = (d.framed || []).filter(match);
    var parked = (d.parked || []).filter(match);
    var oldest = framed.length ? framed[0] : null;

    return h("div", { className: "mc-root" },
      h(PageHead, {
        title: "Waiting on Me",
        sub: "updated " + hhmm(d.generated_at) + " · " + t.framed + " real asks · " + t.parked + " other parks"
      },
        h("div", { className: "mc-filter" },
          h("a", { className: "mc-btn", href: "/mission-control" }, "← Mission Control"),
          h("a", { className: "mc-btn", href: "/insights" }, "Insights →"),
          h("button", { className: "mc-btn", onClick: poll.load }, "refresh"))),

      h("div", { className: "mc-stats" },
        h(Stat, { k: "decisions waiting", v: t.framed, n: "framed with options + a recommendation",
                  tone: t.framed ? "warn" : null }),
        h(Stat, { k: "oldest wait", v: oldest ? dur(oldest.age_seconds) : "—",
                  n: oldest ? oldest.assignee : "" }),
        h(Stat, { k: "other parks", v: t.parked, n: "parked, no framed ask yet" }),
        h(Stat, { k: "boards", v: (d.boards || []).length, n: (d.boards || []).map(function (b) { return b.slug; }).join(", ") })),

      h(Panel, { title: "How long they have been waiting", sub: "every framed ask, by age" },
        h("div", { className: "mc-split" },
          h(HBars, {
            rows: (d.aging || []).map(function (b, i) {
              return { label: b.label, value: b.count, cls: ["mc-c-ok", "mc-c-ok", "mc-c-warn", "mc-c-bad", "mc-c-bad"][i] || "mc-c-3" };
            })
          }),
          h("div", { className: "mc-tags" },
            h("div", { className: "mc-muted" }, "what kind of ask"),
            Object.keys(d.tags || {}).map(function (k) {
              return h("button", {
                key: k, className: "mc-chip" + (tag === k ? " mc-chip-on" : ""),
                onClick: function () { setTag(tag === k ? null : k); }
              }, k + " " + d.tags[k]);
            })))),

      h(Panel, {
        title: "Decisions waiting on you",
        sub: framed.length + (q || tag ? " matching" : "") + " of " + t.framed,
        right: h("div", { className: "mc-filter" },
          h("input", { className: "mc-input", placeholder: "filter…", value: q, onChange: function (e) { setQ(e.target.value); } }),
          (q || tag) ? h("button", { className: "mc-btn", onClick: function () { setQ(""); setTag(null); } }, "clear") : null)
      },
        framed.length
          ? h("div", { className: "mc-cards" }, framed.map(function (i) { return h(AskRow, { key: i.board + i.id, item: i, onDone: poll.load }); }))
          : h("div", { className: "mc-muted" }, (q || tag) ? "nothing matches that filter." : "Nothing framed for you right now.")),

      detailNode,

      h(Panel, {
        title: "Parked, but nothing framed for you",
        sub: t.parked + " cards",
        right: h("button", { className: "mc-btn", onClick: function () { setShowParked(!showParked); } }, showParked ? "hide" : "show")
      },
        h("div", { className: "mc-muted" },
          "These are parked needs_input cards with no OPTIONS block, so the decision-nag will not send them as an ask. They may still be yours — most are internal hand-offs."),
        showParked ? h("div", { className: "mc-cards mc-cards-scroll" }, parked.map(function (i) {
          return h("div", { key: i.board + i.id, className: "mc-row" },
            h("div", { className: "mc-row-t" }, i.title),
            h("div", { className: "mc-row-m" },
              h(Pill, null, i.board_title || i.board),
              i.assignee ? h("span", null, "asked by " + i.assignee) : null,
              h("span", null, "parked " + dur(i.age_seconds)),
              h(IdChip, { id: i.id }),
              h("a", { className: "mc-link", onClick: function () { setDetail({ board: i.board, id: i.id }); } }, "open card")),
            i.ask ? h("div", { className: "mc-ask" }, i.ask.slice(0, 260) + "…") : null,
            h("div", { className: "mc-actions" },
              h("button", { className: "mc-btn mc-btn-p", onClick: function () { setDetail({ board: i.board, id: i.id }); } }, "read & answer"),
              h(CardTools, { item: i })));
        })) : null));
  }
