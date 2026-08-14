"""
Crash recovery: detect whether the temporal worker was SIGKILL'd and left
state in an inconsistent or stale condition.
"""

import json
import os
import time
from dataclasses import dataclass, field
from typing import Optional


STATE_FILE = "worker_state.json"
LOCK_FILE = "worker.lock"

# A worker is considered stale if its last tick was more than this many seconds ago
# while the lock is still held (i.e. the PID is dead but the lock was not released).
STALE_THRESHOLD_SECS = 5.0


@dataclass
class CrashReport:
    crashed: bool
    pid: Optional[int] = None
    last_tick_time: Optional[float] = None
    ticks_completed: int = 0
    status: str = "unknown"
    reason: str = ""
    age_secs: Optional[float] = None
    details: dict = field(default_factory=dict)


def _pid_alive(pid: int) -> bool:
    """Return True if the process with *pid* is still running."""
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # The process exists but we can't signal it.
        return True


def _read_json(path: str) -> Optional[dict]:
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def detect_crash(state_dir: str, now: Optional[float] = None) -> CrashReport:
    """
    Examine the state directory and return a :class:`CrashReport`.

    A crash is detected when:
    * The lock file is present (a worker claimed ownership), AND
    * The worker PID is no longer alive (it was SIGKILL'd or otherwise died
      without releasing the lock).

    Additionally, if the state shows ``status == "running"`` but the last-tick
    timestamp is older than :data:`STALE_THRESHOLD_SECS`, the worker is
    considered stale even if the PID happens to be alive (e.g. hung).
    """
    if now is None:
        now = time.time()

    lock_path = os.path.join(state_dir, LOCK_FILE)
    state_path = os.path.join(state_dir, STATE_FILE)

    state = _read_json(state_path) or {}
    pid_from_lock: Optional[int] = None

    if os.path.exists(lock_path):
        try:
            with open(lock_path) as f:
                pid_from_lock = int(f.read().strip())
        except (ValueError, FileNotFoundError):
            pass

    pid = pid_from_lock or state.get("pid")
    last_tick = state.get("last_tick_time")
    ticks = state.get("ticks", 0)
    status = state.get("status", "unknown")
    age = (now - last_tick) if last_tick is not None else None

    # ── Case 1: Lock present but PID is dead → definite crash ────────────────
    if pid_from_lock is not None and not _pid_alive(pid_from_lock):
        return CrashReport(
            crashed=True,
            pid=pid_from_lock,
            last_tick_time=last_tick,
            ticks_completed=ticks,
            status=status,
            reason="lock held by dead process (SIGKILL or crash)",
            age_secs=age,
            details={"state": state},
        )

    # ── Case 2: State says running but tick is stale ─────────────────────────
    if status == "running" and age is not None and age > STALE_THRESHOLD_SECS:
        return CrashReport(
            crashed=True,
            pid=pid,
            last_tick_time=last_tick,
            ticks_completed=ticks,
            status=status,
            reason=f"worker appears hung: last tick {age:.1f}s ago (threshold {STALE_THRESHOLD_SECS}s)",
            age_secs=age,
            details={"state": state},
        )

    # ── Case 3: Cleanly stopped ───────────────────────────────────────────────
    if status == "stopped":
        return CrashReport(
            crashed=False,
            pid=pid,
            last_tick_time=last_tick,
            ticks_completed=ticks,
            status=status,
            reason="worker stopped cleanly",
            age_secs=age,
            details={"state": state},
        )

    # ── Case 4: Still running (lock held by live PID) ────────────────────────
    return CrashReport(
        crashed=False,
        pid=pid,
        last_tick_time=last_tick,
        ticks_completed=ticks,
        status=status,
        reason="worker is running",
        age_secs=age,
        details={"state": state},
    )


def recover(state_dir: str) -> CrashReport:
    """
    Detect a crash and, if one is found, clean up the stale lock file so a new
    worker can start safely.  Returns the :class:`CrashReport`.
    """
    report = detect_crash(state_dir)
    if report.crashed:
        lock_path = os.path.join(state_dir, LOCK_FILE)
        try:
            os.unlink(lock_path)
        except FileNotFoundError:
            pass
        # Update the persisted status so future callers know recovery ran.
        state_path = os.path.join(state_dir, STATE_FILE)
        state = _read_json(state_path) or {}
        state["status"] = "crashed"
        state["crash_detected_at"] = time.time()
        state["crash_reason"] = report.reason
        try:
            import tempfile, shutil
            dir_ = os.path.dirname(os.path.abspath(state_path))
            fd, tmp = tempfile.mkstemp(dir=dir_, suffix=".tmp")
            with os.fdopen(fd, "w") as f:
                json.dump(state, f, indent=2)
            shutil.move(tmp, state_path)
        except Exception:
            pass
    return report
