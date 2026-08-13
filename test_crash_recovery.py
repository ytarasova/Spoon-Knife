"""Tests for temporal task worker crash recovery (SIGKILL simulation)."""

import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from crash_recovery import Task, TaskState, TemporalWorker, WriteAheadLog


class TestWriteAheadLog(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.wal = WriteAheadLog(Path(self.tmpdir.name))

    def tearDown(self):
        self.tmpdir.cleanup()

    def _task(self, state=TaskState.PENDING, offset=0.0):
        return Task(
            id="t1",
            name="send_email",
            payload={"to": "user@example.com"},
            scheduled_at=time.time() + offset,
            state=state,
        )

    def test_round_trip(self):
        task = self._task()
        self.wal.write(task)
        loaded = self.wal.read("t1")
        self.assertEqual(loaded.id, "t1")
        self.assertEqual(loaded.state, TaskState.PENDING)

    def test_incomplete_tasks_returns_in_progress_only(self):
        self.wal.write(self._task(TaskState.PENDING))

        t2 = Task("t2", "send_email", {}, time.time(), TaskState.IN_PROGRESS)
        self.wal.write(t2)

        t3 = Task("t3", "send_email", {}, time.time(), TaskState.COMPLETED)
        self.wal.write(t3)

        incomplete = self.wal.incomplete_tasks()
        self.assertEqual([t.id for t in incomplete], ["t2"])

    def test_pending_tasks_respects_scheduled_at(self):
        past = Task("past", "job", {}, time.time() - 10, TaskState.PENDING)
        future = Task("future", "job", {}, time.time() + 100, TaskState.PENDING)
        self.wal.write(past)
        self.wal.write(future)

        due = self.wal.pending_tasks()
        self.assertEqual([t.id for t in due], ["past"])

    def test_overwrite_state(self):
        task = self._task()
        self.wal.write(task)
        task.state = TaskState.COMPLETED
        self.wal.write(task)
        loaded = self.wal.read("t1")
        self.assertEqual(loaded.state, TaskState.COMPLETED)


class TestTemporalWorker(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.wal = WriteAheadLog(Path(self.tmpdir.name))
        self.worker = TemporalWorker(self.wal)
        self.executed: list[str] = []

    def tearDown(self):
        self.tmpdir.cleanup()

    def _register_echo(self):
        def handler(payload):
            self.executed.append(payload.get("msg", "ok"))
        self.worker.register("echo", handler)

    def _task(self, task_id="t1", offset=0.0, state=TaskState.PENDING):
        return Task(
            id=task_id,
            name="echo",
            payload={"msg": task_id},
            scheduled_at=time.time() + offset,
            state=state,
        )

    # --- normal execution ---

    def test_run_due_executes_past_tasks(self):
        self._register_echo()
        self.worker.schedule(self._task("t1", offset=-5))
        self.worker.schedule(self._task("t2", offset=100))  # future, skip
        ran = self.worker.run_due()
        self.assertEqual([t.id for t in ran], ["t1"])
        self.assertEqual(self.executed, ["t1"])

    def test_completed_task_state(self):
        self._register_echo()
        self.worker.schedule(self._task("t1", offset=-1))
        self.worker.run_due()
        stored = self.wal.read("t1")
        self.assertEqual(stored.state, TaskState.COMPLETED)
        self.assertIsNotNone(stored.completed_at)

    def test_unknown_handler_marks_failed(self):
        self.worker.schedule(self._task("t1"))
        # no handler registered → should fail gracefully
        self.worker.run_due()
        stored = self.wal.read("t1")
        self.assertEqual(stored.state, TaskState.FAILED)
        self.assertIn("no handler", stored.error)

    def test_handler_exception_marks_failed(self):
        self.worker.register("echo", lambda _: (_ for _ in ()).throw(RuntimeError("boom")))
        self.worker.schedule(self._task("t1"))
        self.worker.run_due()
        stored = self.wal.read("t1")
        self.assertEqual(stored.state, TaskState.FAILED)
        self.assertIn("boom", stored.error)

    # --- SIGKILL crash recovery simulation ---

    def test_recover_replays_in_progress_tasks(self):
        """
        Simulates a SIGKILL crash: a task was written as IN_PROGRESS in the WAL
        but never completed (the process died before the COMPLETED write).
        On the next startup, recover() must re-run it.
        """
        self._register_echo()
        # Simulate crash: task is stuck IN_PROGRESS in the WAL
        crashed_task = Task(
            id="crashed",
            name="echo",
            payload={"msg": "crashed"},
            scheduled_at=time.time() - 10,
            state=TaskState.IN_PROGRESS,
            started_at=time.time() - 10,
        )
        self.wal.write(crashed_task)

        recovered = self.worker.recover()

        self.assertEqual([t.id for t in recovered], ["crashed"])
        self.assertEqual(self.executed, ["crashed"])
        stored = self.wal.read("crashed")
        self.assertEqual(stored.state, TaskState.COMPLETED)

    def test_recover_increments_attempt_count(self):
        self._register_echo()
        task = Task(
            id="t1",
            name="echo",
            payload={"msg": "t1"},
            scheduled_at=time.time() - 1,
            state=TaskState.IN_PROGRESS,
            attempt=2,
        )
        self.wal.write(task)
        self.worker.recover()
        stored = self.wal.read("t1")
        self.assertEqual(stored.attempt, 3)

    def test_recover_does_not_replay_completed_tasks(self):
        self._register_echo()
        done = Task("done", "echo", {"msg": "done"}, time.time() - 1, TaskState.COMPLETED)
        self.wal.write(done)
        recovered = self.worker.recover()
        self.assertEqual(recovered, [])
        self.assertEqual(self.executed, [])

    def test_recover_does_not_replay_pending_tasks(self):
        self._register_echo()
        pending = Task("p1", "echo", {"msg": "p1"}, time.time() - 1, TaskState.PENDING)
        self.wal.write(pending)
        recovered = self.worker.recover()
        self.assertEqual(recovered, [])

    def test_full_restart_cycle(self):
        """
        Full lifecycle: schedule → crash mid-execution → new worker recovers.
        """
        self._register_echo()

        # Worker 1: schedules and begins a task but is SIGKILL'd before completing
        worker1 = TemporalWorker(self.wal)
        worker1.register("echo", lambda p: self.executed.append(p["msg"]))
        task = self._task("job1", offset=-1)
        worker1.schedule(task)

        # Simulate crash: manually flip state to IN_PROGRESS without completing
        stored = self.wal.read("job1")
        stored.state = TaskState.IN_PROGRESS
        stored.started_at = time.time()
        self.wal.write(stored)

        # Worker 2 starts fresh, recovers the crashed task
        worker2 = TemporalWorker(self.wal)
        worker2.register("echo", lambda p: self.executed.append(p["msg"]))
        worker2.recover()

        self.assertEqual(self.executed, ["job1"])
        self.assertEqual(self.wal.read("job1").state, TaskState.COMPLETED)

    # --- subprocess SIGKILL test ---

    def test_subprocess_sigkill_leaves_in_progress_in_wal(self):
        """
        Actual SIGKILL of a child process: verify the WAL has IN_PROGRESS entry
        that a subsequent recovery pass would pick up.
        """
        wal_dir = Path(self.tmpdir.name) / "sigkill_wal"
        wal_dir.mkdir()

        script = f"""
import sys, time
sys.path.insert(0, {repr(str(Path(__file__).parent))})
from crash_recovery import Task, TaskState, TemporalWorker, WriteAheadLog
from pathlib import Path

wal = WriteAheadLog(Path({repr(str(wal_dir))}))
worker = TemporalWorker(wal)

task = Task("sigkill_job", "slow", {{"x": 1}}, __import__('time').time() - 1)
wal.write(task)

# Write IN_PROGRESS to WAL, then sleep (simulating long work)
task.state = TaskState.IN_PROGRESS
task.started_at = __import__('time').time()
wal.write(task)

# Signal parent we're ready to be killed
print("READY", flush=True)
time.sleep(30)  # SIGKILL arrives here
"""
        proc = subprocess.Popen(
            [sys.executable, "-c", script],
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            # Wait until the child has written IN_PROGRESS
            line = proc.stdout.readline().strip()
            self.assertEqual(line, "READY")

            # SIGKILL — process cannot catch this
            os.kill(proc.pid, signal.SIGKILL)
            proc.wait()
        finally:
            proc.stdout.close()

        # Verify WAL has the IN_PROGRESS entry
        recovery_wal = WriteAheadLog(wal_dir)
        incomplete = recovery_wal.incomplete_tasks()
        self.assertEqual(len(incomplete), 1)
        self.assertEqual(incomplete[0].id, "sigkill_job")
        self.assertEqual(incomplete[0].state, TaskState.IN_PROGRESS)


if __name__ == "__main__":
    unittest.main()
