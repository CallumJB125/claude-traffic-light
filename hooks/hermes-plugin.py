"""Plexiform metadata-only Hermes observers. No conversation/tool hooks."""
import json
import os
from pathlib import Path
import re
import subprocess
import threading
from collections import OrderedDict

_ID = re.compile(r"^[A-Za-z0-9_.-]{1,120}$")
_TURN = re.compile(r"^[A-Za-z0-9_.:-]{1,256}$")
_lock = threading.Lock()
_closed = OrderedDict()
_ended = OrderedDict()
_config = None


def _remember(store, key):
    store[key] = True
    store.move_to_end(key)
    while len(store) > 2048:
        store.popitem(last=False)


def _report(event, session_id=None, turn_id=None, completed=None, failed=None,
            interrupted=None, **_ignored):
    # Ignore unknown/additive fields rather than serializing Hermes' event object.
    if not isinstance(session_id, str) or not _ID.fullmatch(session_id):
        return
    if event in ("working", "stop") and (not isinstance(turn_id, str) or not _TURN.fullmatch(turn_id)):
        return
    if event == "stop" and not any(v is True for v in (completed, failed, interrupted)):
        return
    with _lock:
        if session_id in _ended or (event == "working" and (session_id, turn_id) in _closed):
            return
        if event == "stop":
            _remember(_closed, (session_id, turn_id))
        if event == "end":
            _remember(_ended, session_id)
        payload = {"event": event, "sessionId": session_id}
        if event in ("working", "stop"):
            payload["turnId"] = turn_id
        if event == "stop":
            payload["failed"] = failed is True
        env = {"PATH": "/usr/bin:/bin", "CLAUDE_TRAFFIC_LIGHT_HOME": _config["dataDir"]}
        if _config.get("electron"):
            env["ELECTRON_RUN_AS_NODE"] = "1"
        try:
            subprocess.run(_config["command"], input=json.dumps(payload), text=True,  # privacy-flow: hermes-activity-observer
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           env=env, cwd=str(Path(__file__).parent), timeout=1, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
    # Observer callbacks always return None: no directives, approvals or context.


def register(ctx):
    global _config
    _config = json.loads((Path(__file__).parent / "plexiform.json").read_text())
    if _config.get("owner") != "plexiform-hermes-activity-v1":
        return
    def observer(event):
        def callback(session_id=None, turn_id=None, completed=None, failed=None, interrupted=None, **_ignored):
            return _report(event, session_id, turn_id, completed, failed, interrupted)
        return callback
    for name, event in (("on_session_start", "start"), ("on_stream_start", "working"),
                        ("on_session_end", "stop"), ("on_session_finalize", "end")):
        ctx.register_hook(name, observer(event))
