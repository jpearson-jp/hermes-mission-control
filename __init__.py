"""Mission Control — agent-side half of the plugin.

Deliberately empty: this plugin's whole surface is the web-dashboard extension in
``dashboard/`` (tab, static bundle, ``/api/plugins/mission-control/`` routes). It registers no
hooks, no tools and no CLI commands, so it cannot change agent behaviour — it only reads the
estate and carries two owner writes (comment / answer-and-reopen) through
``hermes_cli.kanban_db``.
"""


def register(ctx):  # noqa: ARG001 — plugin contract requires the entry point
    """No-op registration: the dashboard extension needs no agent-side wiring."""
