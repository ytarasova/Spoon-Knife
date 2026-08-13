"""
Temporal task worker with SIGKILL crash recovery.

SIGKILL (signal 9) cannot be caught or blocked — the OS kills the process
immediately. Recovery requires durable checkpointing: write-ahead journal
entries before doing work, then sweep for incomplete entries on restart.

Architecture:
  - Each task is recorded in a write-ahead log (WAL) before execution
  - On startup, the worker replays any tasks that were in-progress at crash time
  - Tasks are idempotent: replaying a completed task is safe
"""

import json
import os
import time
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import Callable, Optional
from datetime import datetime, timezone


class TaskState(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class Task:
    id: str
    name: str
    payload: dict
    scheduled_at: float  # Unix timestamp
    state: TaskState = TaskState.PENDING
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    error: Optional[str] = None
    attempt: int = 0


class WriteAheadLog:
    """Durable task journal using atomic file writes."""

    def __init__(self, path: Path):
        self.path = path
        self.path.mkdir(parents=True, exist_ok=True)

    def _task_path(self, task_id: str) -> Path:
        return self.path / f"{task_id}.json"

    def write(self, task: Task) -> None:
        """Atomically persist task state via temp-file rename."""
        tmp = self._task_path(task.id).with_suffix(".tmp")
        data = asdict(task)
        data["state"] = task.state.value
        tmp.write_text(json.dumps(data))
        tmp.rename(self._task_path(task.id))

    def read(self, task_id: str) -> Optional[Task]:
        p = self._task_path(task_id)
        if not p.exists():
            return None
        data = json.loads(p.read_text())
        data["state"] = TaskState(data["state"])
        return Task(**data)

    def all_tasks(self) -> list[Task]:
        tasks = []
        for p in sorted(self.path.glob("*.json")):
            data = json.loads(p.read_text())
            data["state"] = TaskState(data["state"])
            tasks.append(Task(**data))
        return tasks

    def incomplete_tasks(self) -> list[Task]:
        """Return tasks that were in-progress when the process last died."""
        return [
            t for t in self.all_tasks()
            if t.state == TaskState.IN_PROGRESS
        ]

    def pending_tasks(self, now: Optional[float] = None) -> list[Task]:
        if now is None:
            now = time.time()
        return [
            t for t in self.all_tasks()
            if t.state == TaskState.PENDING and t.scheduled_at <= now
        ]


class TemporalWorker:
    """
    Executes time-scheduled tasks with crash recovery.

    On every startup, the worker:
    1. Scans the WAL for IN_PROGRESS tasks (left over from a SIGKILL)
    2. Re-executes them (tasks must be idempotent)
    3. Then processes newly scheduled PENDING tasks
    """

    def __init__(self, wal: WriteAheadLog):
        self.wal = wal
        self._handlers: dict[str, Callable[[dict], None]] = {}

    def register(self, name: str, fn: Callable[[dict], None]) -> None:
        self._handlers[name] = fn

    def schedule(self, task: Task) -> None:
        self.wal.write(task)

    def recover(self) -> list[Task]:
        """Re-run any tasks that were interrupted by SIGKILL."""
        crashed = self.wal.incomplete_tasks()
        for task in crashed:
            task.attempt += 1
            self._execute(task)
        return crashed

    def run_due(self, now: Optional[float] = None) -> list[Task]:
        """Execute all tasks scheduled up to `now`."""
        due = self.wal.pending_tasks(now)
        for task in due:
            self._execute(task)
        return due

    def _execute(self, task: Task) -> None:
        handler = self._handlers.get(task.name)
        if handler is None:
            task.state = TaskState.FAILED
            task.error = f"no handler registered for '{task.name}'"
            self.wal.write(task)
            return

        # Write IN_PROGRESS to WAL before doing any work.
        # If SIGKILL fires after this write, recover() will replay it.
        task.state = TaskState.IN_PROGRESS
        task.started_at = time.time()
        self.wal.write(task)

        try:
            handler(task.payload)
            task.state = TaskState.COMPLETED
            task.completed_at = time.time()
        except Exception as exc:
            task.state = TaskState.FAILED
            task.error = str(exc)
        finally:
            self.wal.write(task)
