"""
Temporal worker: runs periodic tasks and persists state to disk.

This process can be killed with SIGKILL at any time. Because SIGKILL bypasses
all signal handlers, the state file may be left partially written — the
canonical crash scenario for temporal operations.
"""

import json
import os
import signal
import sys
import time
import argparse
import tempfile
import shutil
from pathlib import Path

STATE_FILE = "worker_state.json"
LOCK_FILE = "worker.lock"


def _write_state_atomic(path: str, state: dict) -> None:
    """Write state atomically using a temp-file + rename so readers never see partial writes."""
    dir_ = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=dir_, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f, indent=2)
        shutil.move(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_state(path: str) -> dict:
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _acquire_lock(lock_path: str, pid: int) -> None:
    with open(lock_path, "w") as f:
        f.write(str(pid))


def _release_lock(lock_path: str) -> None:
    try:
        os.unlink(lock_path)
    except FileNotFoundError:
        pass


def _lock_owner(lock_path: str) -> int | None:
    try:
        with open(lock_path) as f:
            return int(f.read().strip())
    except (FileNotFoundError, ValueError):
        return None


class _StopSignal(Exception):
    """Raised by our SIGTERM handler so the finally block can run cleanly."""


def _install_sigterm_handler() -> None:
    def _handler(signum, frame):
        raise _StopSignal()
    signal.signal(signal.SIGTERM, _handler)


def run_worker(state_dir: str, tick_interval: float = 0.1, max_ticks: int | None = None) -> None:
    """
    Run the temporal worker.

    Each tick:
      1. Reads current state.
      2. Increments tick counter.
      3. Records timestamp.
      4. Writes state atomically.

    The process can be SIGKILL'd between any two of these steps. The crash
    recovery module detects whether the resulting state is consistent.
    """
    os.makedirs(state_dir, exist_ok=True)
    state_path = os.path.join(state_dir, STATE_FILE)
    lock_path = os.path.join(state_dir, LOCK_FILE)

    _install_sigterm_handler()
    pid = os.getpid()
    _acquire_lock(lock_path, pid)

    state = _read_state(state_path)
    state.setdefault("ticks", 0)
    state.setdefault("start_time", time.time())
    state["pid"] = pid
    state["status"] = "running"
    _write_state_atomic(state_path, state)

    tick = 0
    try:
        while max_ticks is None or tick < max_ticks:
            state = _read_state(state_path)
            state["ticks"] = state.get("ticks", 0) + 1
            state["last_tick_time"] = time.time()
            state["status"] = "running"
            state["pid"] = pid
            _write_state_atomic(state_path, state)
            tick += 1
            time.sleep(tick_interval)
    except _StopSignal:
        pass
    finally:
        state = _read_state(state_path)
        state["status"] = "stopped"
        _write_state_atomic(state_path, state)
        _release_lock(lock_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Temporal worker process")
    parser.add_argument("--state-dir", default=".", help="Directory for state and lock files")
    parser.add_argument("--tick-interval", type=float, default=0.1, help="Seconds between ticks")
    parser.add_argument("--max-ticks", type=int, default=None, help="Stop after N ticks (default: run forever)")
    args = parser.parse_args()

    run_worker(args.state_dir, args.tick_interval, args.max_ticks)


if __name__ == "__main__":
    main()
