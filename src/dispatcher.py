"""
Dispatcher: queues and routes tasks to workers.

TaskState tracks a task through its lifecycle. The Dispatcher assigns tasks
to workers and records results. Workers are callables; a worker that raises
is considered faulted and its in-flight tasks are left in DISPATCHED state
so the post-fault probe can recover them.
"""

import threading
import time
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any, Callable, Dict, List, Optional


class TaskState(Enum):
    PENDING = auto()
    DISPATCHED = auto()
    COMPLETED = auto()
    FAILED = auto()


@dataclass
class Task:
    task_id: str
    payload: Any
    state: TaskState = TaskState.PENDING
    worker_id: Optional[str] = None
    result: Any = None
    error: Optional[str] = None
    dispatched_at: Optional[float] = None
    completed_at: Optional[float] = None


@dataclass
class DispatcherFault(Exception):
    reason: str

    def __str__(self) -> str:
        return f"DispatcherFault: {self.reason}"


class Dispatcher:
    """Assigns tasks to registered workers and tracks their lifecycle."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tasks: Dict[str, Task] = {}
        self._workers: Dict[str, Callable] = {}
        self._faulted: bool = False
        self._fault_reason: Optional[str] = None

    # ------------------------------------------------------------------
    # Worker registration
    # ------------------------------------------------------------------

    def register_worker(self, worker_id: str, fn: Callable) -> None:
        with self._lock:
            self._workers[worker_id] = fn

    def deregister_worker(self, worker_id: str) -> None:
        with self._lock:
            self._workers.pop(worker_id, None)

    # ------------------------------------------------------------------
    # Task management
    # ------------------------------------------------------------------

    def enqueue(self, task: Task) -> None:
        with self._lock:
            self._tasks[task.task_id] = task

    def dispatch(self, task_id: str, worker_id: str) -> None:
        """Dispatch a pending task to a worker. Raises DispatcherFault on worker error."""
        with self._lock:
            if self._faulted:
                raise DispatcherFault(self._fault_reason or "dispatcher already faulted")
            task = self._tasks.get(task_id)
            if task is None:
                raise KeyError(f"unknown task {task_id!r}")
            if task.state != TaskState.PENDING:
                raise ValueError(f"task {task_id!r} is not PENDING (state={task.state})")
            worker = self._workers.get(worker_id)
            if worker is None:
                raise KeyError(f"unknown worker {worker_id!r}")
            task.state = TaskState.DISPATCHED
            task.worker_id = worker_id
            task.dispatched_at = time.monotonic()

        # Execute outside the lock so callers can enqueue/inspect concurrently.
        try:
            result = worker(task.payload)
            with self._lock:
                task.state = TaskState.COMPLETED
                task.result = result
                task.completed_at = time.monotonic()
        except Exception as exc:
            with self._lock:
                task.state = TaskState.FAILED
                task.error = str(exc)
                task.completed_at = time.monotonic()
                self._faulted = True
                self._fault_reason = str(exc)
            raise DispatcherFault(str(exc)) from exc

    def inject_fault(self, reason: str = "injected fault") -> None:
        """Force the dispatcher into a faulted state for testing."""
        with self._lock:
            self._faulted = True
            self._fault_reason = reason

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    @property
    def faulted(self) -> bool:
        with self._lock:
            return self._faulted

    def tasks_in_state(self, state: TaskState) -> List[Task]:
        with self._lock:
            return [t for t in self._tasks.values() if t.state == state]

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "faulted": self._faulted,
                "fault_reason": self._fault_reason,
                "task_counts": {s.name: 0 for s in TaskState}
                | {
                    s.name: sum(1 for t in self._tasks.values() if t.state == s)
                    for s in TaskState
                },
                "worker_count": len(self._workers),
            }
