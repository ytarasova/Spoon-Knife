"""
Lease manager: time-bounded ownership with crash detection.

A lease grants exclusive ownership for a fixed TTL (time-to-live).  The
holder must renew the lease (heartbeat) before it expires.  If the owner
dies (SIGKILL or crash) without releasing the lease, the lease becomes
stale: the lock file is present but the PID is no longer alive.

Lease state is persisted to a JSON file so recovery survives process
restarts.  All writes are atomic (temp-file + rename) to prevent torn reads.
"""

import json
import os
import tempfile
import shutil
import time
from dataclasses import dataclass, field
from typing import Optional


LEASE_FILE = "lease.json"

# Default lease TTL in seconds: if the owner does not heartbeat within this
# window, the lease is considered expired even if the PID is still alive.
DEFAULT_TTL_SECS = 5.0


@dataclass
class LeaseState:
    owner: Optional[str]
    pid: Optional[int]
    acquired_at: Optional[float]
    last_heartbeat: Optional[float]
    ttl_secs: float
    status: str  # "held", "released", "crashed", "expired"
    crash_detected_at: Optional[float] = None
    crash_reason: str = ""
    details: dict = field(default_factory=dict)

    @property
    def age_secs(self) -> Optional[float]:
        if self.last_heartbeat is None:
            return None
        return time.time() - self.last_heartbeat

    @property
    def is_expired(self) -> bool:
        age = self.age_secs
        return age is not None and age > self.ttl_secs


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _read_json(path: str) -> Optional[dict]:
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _write_json_atomic(path: str, data: dict) -> None:
    dir_ = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=dir_, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        shutil.move(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def acquire(lease_dir: str, owner: str, ttl_secs: float = DEFAULT_TTL_SECS) -> bool:
    """
    Attempt to acquire the lease for *owner*.

    Returns True if the lease was acquired (either it was free, expired, or
    the previous owner has died).  Returns False if the lease is currently
    held by a live process within its TTL.
    """
    os.makedirs(lease_dir, exist_ok=True)
    lease_path = os.path.join(lease_dir, LEASE_FILE)
    now = time.time()

    data = _read_json(lease_path) or {}
    current_pid = data.get("pid")
    current_status = data.get("status", "released")
    last_hb = data.get("last_heartbeat")

    # Lease is free if: never held, explicitly released, or previous holder died.
    if current_status in ("released", "crashed", "expired"):
        pass  # proceed to acquire
    elif current_pid is not None and not _pid_alive(current_pid):
        pass  # previous owner is dead — takeover allowed
    elif last_hb is not None and (now - last_hb) > ttl_secs:
        pass  # heartbeat expired — lease is stale
    else:
        return False  # lease is actively held

    new_data = {
        "owner": owner,
        "pid": os.getpid(),
        "acquired_at": now,
        "last_heartbeat": now,
        "ttl_secs": ttl_secs,
        "status": "held",
    }
    _write_json_atomic(lease_path, new_data)
    return True


def heartbeat(lease_dir: str) -> bool:
    """
    Renew the lease held by the current process.

    Returns True if the heartbeat was written successfully.  Returns False if
    the lease file is missing or owned by a different PID (which can happen if
    the lease was revoked and re-acquired by another process).
    """
    lease_path = os.path.join(lease_dir, LEASE_FILE)
    data = _read_json(lease_path)
    if data is None:
        return False
    if data.get("pid") != os.getpid():
        return False  # we no longer own this lease

    data["last_heartbeat"] = time.time()
    _write_json_atomic(lease_path, data)
    return True


def release(lease_dir: str) -> None:
    """Release the lease cleanly (called by the holder before exiting)."""
    lease_path = os.path.join(lease_dir, LEASE_FILE)
    data = _read_json(lease_path) or {}
    if data.get("pid") == os.getpid():
        data["status"] = "released"
        data["pid"] = None
        _write_json_atomic(lease_path, data)


def inspect(lease_dir: str, now: Optional[float] = None) -> LeaseState:
    """
    Return the current :class:`LeaseState` without modifying any files.

    A crash is inferred when:
      * ``status == "held"`` in the lease file, AND
      * The recorded PID is no longer alive, OR the heartbeat has expired.
    """
    if now is None:
        now = time.time()

    lease_path = os.path.join(lease_dir, LEASE_FILE)
    data = _read_json(lease_path) or {}

    owner = data.get("owner")
    pid = data.get("pid")
    acquired_at = data.get("acquired_at")
    last_hb = data.get("last_heartbeat")
    ttl_secs = data.get("ttl_secs", DEFAULT_TTL_SECS)
    status = data.get("status", "released")
    age = (now - last_hb) if last_hb is not None else None

    if status == "held":
        if pid is not None and not _pid_alive(pid):
            return LeaseState(
                owner=owner,
                pid=pid,
                acquired_at=acquired_at,
                last_heartbeat=last_hb,
                ttl_secs=ttl_secs,
                status="crashed",
                crash_reason="lease held by dead process (owner died without releasing)",
                details={"raw": data},
            )
        if age is not None and age > ttl_secs:
            return LeaseState(
                owner=owner,
                pid=pid,
                acquired_at=acquired_at,
                last_heartbeat=last_hb,
                ttl_secs=ttl_secs,
                status="expired",
                crash_reason=f"heartbeat expired: last renewal {age:.2f}s ago (TTL {ttl_secs}s)",
                details={"raw": data},
            )

    return LeaseState(
        owner=owner,
        pid=pid,
        acquired_at=acquired_at,
        last_heartbeat=last_hb,
        ttl_secs=ttl_secs,
        status=status,
        details={"raw": data},
    )


def recover(lease_dir: str) -> LeaseState:
    """
    Detect a crashed or expired lease and clear it so a new owner can acquire.

    Returns the :class:`LeaseState` describing what was found.
    """
    state = inspect(lease_dir)
    if state.status in ("crashed", "expired"):
        lease_path = os.path.join(lease_dir, LEASE_FILE)
        data = _read_json(lease_path) or {}
        data["status"] = state.status
        data["crash_detected_at"] = time.time()
        data["crash_reason"] = state.crash_reason
        data["pid"] = None
        _write_json_atomic(lease_path, data)
    return state
