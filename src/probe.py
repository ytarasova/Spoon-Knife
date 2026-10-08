"""
Post-fault dispatch probe.

After a Dispatcher enters a faulted state, the probe:
  1. Collects all tasks that were in-flight (DISPATCHED) at crash time.
  2. Re-dispatches them to healthy workers in a new, clean Dispatcher.
  3. Returns a ProbeReport that records what was recovered vs. lost.

Usage
-----
    original_dispatcher.inject_fault("worker panic")
    report = probe(original_dispatcher, workers={"w1": my_worker})
    assert report.recovered == 3
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from .dispatcher import Dispatcher, Task, TaskState


@dataclass
class ProbeReport:
    probed_at: float
    was_faulted: bool
    fault_reason: Optional[str]

    # Task counts from the faulted dispatcher snapshot
    snapshot_before: Dict[str, Any] = field(default_factory=dict)

    # Recovery results
    recovered: int = 0
    failed_recovery: int = 0
    skipped: int = 0          # tasks already in a terminal state

    details: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def total_in_flight(self) -> int:
        return self.recovered + self.failed_recovery

    @property
    def success(self) -> bool:
        return self.was_faulted and self.failed_recovery == 0 and self.recovered >= 0


def probe(
    dispatcher: Dispatcher,
    workers: Dict[str, Callable],
    *,
    timeout: float = 5.0,
) -> ProbeReport:
    """
    Probe a (possibly faulted) dispatcher and recover its in-flight tasks.

    Parameters
    ----------
    dispatcher:
        The dispatcher to probe. It may or may not be in a faulted state.
    workers:
        A mapping of worker_id -> callable to use for re-dispatch.
        The probe will round-robin across available workers.
    timeout:
        Per-task recovery timeout in seconds (unused by sync workers but
        included for future async extension).

    Returns
    -------
    ProbeReport
    """
    snapshot = dispatcher.snapshot()
    report = ProbeReport(
        probed_at=time.monotonic(),
        was_faulted=snapshot["faulted"],
        fault_reason=snapshot.get("fault_reason"),
        snapshot_before=snapshot,
    )

    # Collect in-flight tasks that need recovery.
    in_flight = dispatcher.tasks_in_state(TaskState.DISPATCHED)
    terminal_count = sum(
        snapshot["task_counts"].get(s, 0)
        for s in ("COMPLETED", "FAILED")
    )
    report.skipped = terminal_count

    if not in_flight:
        return report

    # Build a fresh dispatcher for recovery.
    recovery_dispatcher = Dispatcher()
    worker_ids = list(workers)
    for wid, fn in workers.items():
        recovery_dispatcher.register_worker(wid, fn)

    for idx, task in enumerate(in_flight):
        recovery_task = Task(
            task_id=f"{task.task_id}__recovery",
            payload=task.payload,
        )
        recovery_dispatcher.enqueue(recovery_task)
        worker_id = worker_ids[idx % len(worker_ids)]

        detail: Dict[str, Any] = {
            "original_task_id": task.task_id,
            "recovery_task_id": recovery_task.task_id,
            "worker_id": worker_id,
        }

        try:
            recovery_dispatcher.dispatch(recovery_task.task_id, worker_id)
            detail["outcome"] = "recovered"
            detail["result"] = recovery_task.result
            report.recovered += 1
        except Exception as exc:
            detail["outcome"] = "failed"
            detail["error"] = str(exc)
            report.failed_recovery += 1

        report.details.append(detail)

    return report
