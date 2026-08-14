"""
Temporal outage resilience: detect and recover from periods of transient
unavailability in a temporal (time-based periodic) worker.

An *outage* is distinct from a crash:
- Crash: the process dies (SIGKILL) — detected via stale lock held by dead PID.
- Outage: the process is alive but its tasks are repeatedly failing because
  a dependency (external service, database, etc.) is temporarily unavailable.
  The process stays alive; we layer retry/backoff/circuit-breaker logic around
  each task execution so it can ride out the outage and resume automatically.

Core primitives:
  ExponentialBackoff   – wait times that grow geometrically with jitter.
  CircuitBreaker       – stops hammering a failing dependency; auto-resets.
  OutageTracker        – persists outage lifecycle events atomically to disk.
  OutageAwareWorker    – runs periodic tasks through the above primitives.
"""

import json
import math
import os
import random
import shutil
import tempfile
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional


# ── State/Lock file names (mirrors temporal_worker.py conventions) ────────────

STATE_FILE = "worker_state.json"
OUTAGE_FILE = "outage_state.json"
LOCK_FILE = "worker.lock"


# ─────────────────────────────────────────────────────────────────────────────
# Enums
# ─────────────────────────────────────────────────────────────────────────────

class CircuitState(Enum):
    CLOSED = "closed"      # Normal: requests pass through.
    OPEN = "open"          # Outage: requests fail fast without calling the task.
    HALF_OPEN = "half_open"  # Probe: one request is allowed to test recovery.


class OutagePhase(Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"   # Failures observed but circuit still closed.
    OUTAGE = "outage"       # Circuit open — dependency unavailable.
    RECOVERING = "recovering"  # Circuit half-open — probing for recovery.


# ─────────────────────────────────────────────────────────────────────────────
# ExponentialBackoff
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class BackoffConfig:
    base: float = 0.1       # seconds for the first retry
    multiplier: float = 2.0
    max_delay: float = 30.0
    jitter: float = 0.1     # fraction of delay added as random noise


class ExponentialBackoff:
    """Yields monotonically increasing delays with optional jitter."""

    def __init__(self, config: Optional[BackoffConfig] = None) -> None:
        self._cfg = config or BackoffConfig()
        self._attempt = 0

    def reset(self) -> None:
        self._attempt = 0

    @property
    def attempt(self) -> int:
        return self._attempt

    def next_delay(self) -> float:
        delay = min(
            self._cfg.base * (self._cfg.multiplier ** self._attempt),
            self._cfg.max_delay,
        )
        jitter = delay * self._cfg.jitter * random.random()
        self._attempt += 1
        return delay + jitter

    def sleep(self) -> float:
        """Sleep for the next delay and return how long we slept."""
        d = self.next_delay()
        time.sleep(d)
        return d


# ─────────────────────────────────────────────────────────────────────────────
# CircuitBreaker
# ─────────────────────────────────────────────────────────────────────────────

class CircuitOpenError(Exception):
    """Raised when a call is attempted while the circuit breaker is open."""


@dataclass
class CircuitBreakerConfig:
    failure_threshold: int = 3      # consecutive failures before opening
    success_threshold: int = 1      # successes in HALF_OPEN before closing
    cooldown: float = 5.0           # seconds before transitioning to HALF_OPEN


class CircuitBreaker:
    """
    Standard three-state circuit breaker.

    CLOSED  → failures increment counter → threshold reached → OPEN
    OPEN    → after cooldown → HALF_OPEN
    HALF_OPEN → success → CLOSED; failure → OPEN
    """

    def __init__(self, config: Optional[CircuitBreakerConfig] = None) -> None:
        self._cfg = config or CircuitBreakerConfig()
        self._state = CircuitState.CLOSED
        self._consecutive_failures = 0
        self._consecutive_successes = 0
        self._opened_at: Optional[float] = None

    @property
    def state(self) -> CircuitState:
        self._maybe_transition_to_half_open()
        return self._state

    def _maybe_transition_to_half_open(self) -> None:
        if (
            self._state is CircuitState.OPEN
            and self._opened_at is not None
            and time.time() - self._opened_at >= self._cfg.cooldown
        ):
            self._state = CircuitState.HALF_OPEN
            self._consecutive_successes = 0

    def allow_request(self) -> bool:
        """Return True if a request is allowed through, False to fail-fast."""
        self._maybe_transition_to_half_open()
        if self._state is CircuitState.CLOSED:
            return True
        if self._state is CircuitState.HALF_OPEN:
            return True
        return False  # OPEN

    def record_success(self) -> None:
        self._maybe_transition_to_half_open()
        self._consecutive_failures = 0
        if self._state is CircuitState.HALF_OPEN:
            self._consecutive_successes += 1
            if self._consecutive_successes >= self._cfg.success_threshold:
                self._state = CircuitState.CLOSED
                self._opened_at = None
        # In CLOSED, success resets failure run.

    def record_failure(self) -> None:
        self._maybe_transition_to_half_open()
        self._consecutive_failures += 1
        self._consecutive_successes = 0
        if self._state is CircuitState.HALF_OPEN:
            self._state = CircuitState.OPEN
            self._opened_at = time.time()
        elif (
            self._state is CircuitState.CLOSED
            and self._consecutive_failures >= self._cfg.failure_threshold
        ):
            self._state = CircuitState.OPEN
            self._opened_at = time.time()

    def call(self, fn: Callable[[], Any]) -> Any:
        """Execute *fn* through the circuit breaker; raise CircuitOpenError if open."""
        if not self.allow_request():
            raise CircuitOpenError(
                f"Circuit is OPEN (opened at {self._opened_at:.1f}); "
                f"cooldown remaining: "
                f"{max(0, self._cfg.cooldown - (time.time() - self._opened_at)):.1f}s"
            )
        try:
            result = fn()
            self.record_success()
            return result
        except Exception:
            self.record_failure()
            raise


# ─────────────────────────────────────────────────────────────────────────────
# OutageTracker
# ─────────────────────────────────────────────────────────────────────────────

def _write_atomic(path: str, data: dict) -> None:
    """Atomically write *data* as JSON to *path* via temp-file + rename."""
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


def _read_json(path: str) -> dict:
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


@dataclass
class OutageEvent:
    phase: OutagePhase
    timestamp: float
    reason: str
    extra: dict = field(default_factory=dict)


class OutageTracker:
    """
    Persists the outage lifecycle to *outage_state.json* inside *state_dir*.

    Writes are atomic (temp-file + rename) so the file is never partially
    visible to readers, even if the process is SIGKILL'd mid-write.
    """

    def __init__(self, state_dir: str) -> None:
        self._path = os.path.join(state_dir, OUTAGE_FILE)
        os.makedirs(state_dir, exist_ok=True)
        raw = _read_json(self._path)
        self._phase = OutagePhase(raw.get("phase", OutagePhase.HEALTHY.value))
        self._history: list[dict] = raw.get("history", [])

    @property
    def phase(self) -> OutagePhase:
        return self._phase

    def record(self, phase: OutagePhase, reason: str, extra: Optional[dict] = None) -> None:
        self._phase = phase
        event = {
            "phase": phase.value,
            "timestamp": time.time(),
            "reason": reason,
            **(extra or {}),
        }
        self._history.append(event)
        self._persist()

    def _persist(self) -> None:
        _write_atomic(
            self._path,
            {
                "phase": self._phase.value,
                "history": self._history,
                "updated_at": time.time(),
            },
        )

    def load(self) -> dict:
        return _read_json(self._path)


# ─────────────────────────────────────────────────────────────────────────────
# OutageAwareWorker
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class WorkerConfig:
    tick_interval: float = 0.1          # seconds between ticks (healthy)
    max_ticks: Optional[int] = None     # None = run forever
    backoff: BackoffConfig = field(default_factory=BackoffConfig)
    circuit: CircuitBreakerConfig = field(default_factory=CircuitBreakerConfig)
    # If a task fails, retry up to this many times before counting it as
    # a circuit-breaker failure.
    max_retries_per_tick: int = 2


class OutageAwareWorker:
    """
    Runs a periodic task function with outage detection and recovery.

    Lifecycle per tick:
      1. Check circuit breaker → if OPEN, skip and sleep (fast-fail).
      2. Call the task function with retries + exponential backoff.
      3. On success  → record_success(); tracker → HEALTHY.
      4. On failure  → record_failure(); possibly transition circuit → OPEN.
      5. Persist worker state atomically after each tick attempt.

    State files written to *state_dir*:
      worker_state.json – ticks, timestamps, current phase.
      outage_state.json – outage phase + full event history.
    """

    def __init__(
        self,
        task: Callable[[], Any],
        state_dir: str,
        config: Optional[WorkerConfig] = None,
    ) -> None:
        self._task = task
        self._state_dir = state_dir
        self._cfg = config or WorkerConfig()
        self._tracker = OutageTracker(state_dir)
        self._breaker = CircuitBreaker(self._cfg.circuit)
        self._backoff = ExponentialBackoff(self._cfg.backoff)
        self._state_path = os.path.join(state_dir, STATE_FILE)
        os.makedirs(state_dir, exist_ok=True)

    # ── Public API ────────────────────────────────────────────────────────────

    def run(self) -> None:
        """Main loop; returns when max_ticks is reached."""
        state = _read_json(self._state_path)
        state.setdefault("ticks", 0)
        state.setdefault("failed_ticks", 0)
        state.setdefault("skipped_ticks", 0)
        state["status"] = "running"
        state["start_time"] = time.time()
        _write_atomic(self._state_path, state)

        tick = 0
        while self._cfg.max_ticks is None or tick < self._cfg.max_ticks:
            self._do_tick(state)
            tick += 1
            time.sleep(self._cfg.tick_interval)

        state["status"] = "stopped"
        _write_atomic(self._state_path, state)

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _do_tick(self, state: dict) -> None:
        """Attempt the task, update state, persist."""
        circuit_state = self._breaker.state

        if circuit_state is CircuitState.OPEN:
            state["skipped_ticks"] = state.get("skipped_ticks", 0) + 1
            state["last_tick_time"] = time.time()
            state["phase"] = self._tracker.phase.value
            _write_atomic(self._state_path, state)
            return

        success = self._attempt_with_retry()

        state["ticks"] = state.get("ticks", 0) + 1
        state["last_tick_time"] = time.time()

        if success:
            self._backoff.reset()
            new_phase = self._resolve_healthy_phase()
            if new_phase != self._tracker.phase:
                self._tracker.record(new_phase, "task succeeded; circuit closed")
            state["phase"] = new_phase.value
        else:
            state["failed_ticks"] = state.get("failed_ticks", 0) + 1
            new_phase = self._resolve_failed_phase()
            if new_phase != self._tracker.phase:
                self._tracker.record(new_phase, f"task failed; circuit={self._breaker.state.value}")
            state["phase"] = new_phase.value

        _write_atomic(self._state_path, state)

    def _attempt_with_retry(self) -> bool:
        """Try the task up to max_retries_per_tick+1 times; return True on success."""
        local_backoff = ExponentialBackoff(self._cfg.backoff)
        for attempt in range(self._cfg.max_retries_per_tick + 1):
            try:
                self._breaker.call(self._task)
                return True
            except CircuitOpenError:
                return False
            except Exception:
                if attempt < self._cfg.max_retries_per_tick:
                    local_backoff.sleep()
                else:
                    self._breaker.record_failure()
        return False

    def _resolve_healthy_phase(self) -> OutagePhase:
        state = self._breaker.state
        if state is CircuitState.CLOSED:
            return OutagePhase.HEALTHY
        if state is CircuitState.HALF_OPEN:
            return OutagePhase.RECOVERING
        return OutagePhase.OUTAGE

    def _resolve_failed_phase(self) -> OutagePhase:
        state = self._breaker.state
        if state is CircuitState.OPEN:
            return OutagePhase.OUTAGE
        if state is CircuitState.HALF_OPEN:
            return OutagePhase.RECOVERING
        return OutagePhase.DEGRADED


# ─────────────────────────────────────────────────────────────────────────────
# detect_outage / recover — module-level helpers (mirrors crash_recovery API)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class OutageReport:
    in_outage: bool
    phase: OutagePhase
    reason: str
    history: list = field(default_factory=list)
    updated_at: Optional[float] = None


def detect_outage(state_dir: str) -> OutageReport:
    """
    Read persisted outage state from *state_dir* and return an :class:`OutageReport`.
    """
    path = os.path.join(state_dir, OUTAGE_FILE)
    raw = _read_json(path)
    phase = OutagePhase(raw.get("phase", OutagePhase.HEALTHY.value))
    history = raw.get("history", [])
    updated_at = raw.get("updated_at")
    in_outage = phase in (OutagePhase.OUTAGE, OutagePhase.DEGRADED, OutagePhase.RECOVERING)
    reason = history[-1].get("reason", "") if history else "no events recorded"
    return OutageReport(
        in_outage=in_outage,
        phase=phase,
        reason=reason,
        history=history,
        updated_at=updated_at,
    )


def recover_from_outage(state_dir: str) -> OutageReport:
    """
    If an outage is detected, stamp the outage state file with HEALTHY and
    return the report so callers know recovery was triggered.

    In practice, true recovery happens automatically once the circuit breaker
    transitions back to CLOSED after a successful HALF_OPEN probe.  This
    function is the *administrative* recovery path — useful for operators who
    want to force-reset the tracked phase without restarting the worker.
    """
    report = detect_outage(state_dir)
    if report.in_outage:
        tracker = OutageTracker(state_dir)
        tracker.record(
            OutagePhase.HEALTHY,
            "manual recovery: operator reset outage phase",
            {"previous_phase": report.phase.value},
        )
    return report
