"""Tests for the Mission Control plugin.

`render-check.mjs` is the headless Node harness for the desktop half; `test_ask_reasons.py` is the
Python arm for the backend route module. Run the Python half with the dashboard's own interpreter
(it imports `hermes_cli`):

    /home/hermes/.hermes/hermes-agent/venv/bin/python -m unittest discover -s tests -t . -v
"""
