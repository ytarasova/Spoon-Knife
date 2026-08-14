"""
Tests for temporal SIGKILL crash detection and recovery.

Strategy:
  1. Start a temporal_worker subprocess.
  2. Wait until it has written at least one tick.
  3. Send SIGKILL (which cannot be caught or deferred).
  4. Assert that crash_recovery.detect_crash() reports a crash.
  5. Assert that crash_recovery.recover() cleans up the lock and updates state.
"""

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from crash_recovery import CrashReport, detect_crash, recover


WORKER_SCRIPT = Path(__file__).parent / "temporal_worker.py"
POLL_INTERVAL = 0.05   # seconds between readiness checks
READINESS_TIMEOUT = 5  # seconds to wait for the worker to start ticking


def _wait_for_tick(state_dir: str, min_ticks: int = 1, timeout: float = READINESS_TIMEOUT) -> dict:
    """Poll the state file until the worker has recorded *min_ticks* ticks."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        state_path = os.path.join(state_dir, "worker_state.json")
        try:
            with open(state_path) as f:
                state = json.load(f)
            if state.get("ticks", 0) >= min_ticks and state.get("status") == "running":
                return state
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(POLL_INTERVAL)
    raise TimeoutError(f"Worker did not reach {min_ticks} tick(s) within {timeout}s")


class TestSigkillCrash(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix="temporal_crash_")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def _start_worker(self, tick_interval: float = 0.05) -> subprocess.Popen:
        return subprocess.Popen(
            [sys.executable, str(WORKER_SCRIPT),
             "--state-dir", self.tmp_dir,
             "--tick-interval", str(tick_interval)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    # ── Test 1: SIGKILL leaves a detectable crash ─────────────────────────────

    def test_sigkill_detected_as_crash(self):
        proc = self._start_worker()
        try:
            _wait_for_tick(self.tmp_dir, min_ticks=2)
            proc.send_signal(signal.SIGKILL)
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
            proc.wait()
            raise

        # Give the OS a moment to reflect the process death.
        time.sleep(0.1)

        report = detect_crash(self.tmp_dir)
        self.assertTrue(report.crashed, f"Expected crash but got: {report.reason}")
        self.assertIn("dead process", report.reason)
        self.assertGreaterEqual(report.ticks_completed, 2)

    # ── Test 2: Clean stop is NOT reported as a crash ─────────────────────────

    def test_clean_stop_not_a_crash(self):
        proc = self._start_worker()
        try:
            _wait_for_tick(self.tmp_dir, min_ticks=1)
            proc.send_signal(signal.SIGTERM)  # worker catches this via finally
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
            proc.wait()
            raise

        time.sleep(0.1)
        report = detect_crash(self.tmp_dir)
        self.assertFalse(report.crashed, f"Unexpected crash report: {report.reason}")
        self.assertEqual(report.status, "stopped")

    # ── Test 3: recover() removes the stale lock after a crash ───────────────

    def test_recover_removes_lock(self):
        proc = self._start_worker()
        try:
            _wait_for_tick(self.tmp_dir, min_ticks=1)
            proc.send_signal(signal.SIGKILL)
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
            proc.wait()
            raise

        time.sleep(0.1)

        lock_path = os.path.join(self.tmp_dir, "worker.lock")
        self.assertTrue(os.path.exists(lock_path), "Lock file should exist before recovery")

        report = recover(self.tmp_dir)
        self.assertTrue(report.crashed, "recover() should have detected the crash")
        self.assertFalse(os.path.exists(lock_path), "recover() should have removed the lock file")

    # ── Test 4: after recover(), a new worker can start ───────────────────────

    def test_new_worker_starts_after_recovery(self):
        proc = self._start_worker()
        try:
            _wait_for_tick(self.tmp_dir, min_ticks=1)
            proc.send_signal(signal.SIGKILL)
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
            proc.wait()
            raise

        time.sleep(0.1)
        recover(self.tmp_dir)

        # Start a replacement worker; it must be able to acquire the lock and tick.
        proc2 = self._start_worker()
        try:
            state = _wait_for_tick(self.tmp_dir, min_ticks=1)
            self.assertEqual(state["status"], "running")
        finally:
            proc2.kill()
            proc2.wait()

    # ── Test 5: state written before SIGKILL is readable and consistent ───────

    def test_state_before_sigkill_is_valid_json(self):
        proc = self._start_worker()
        try:
            _wait_for_tick(self.tmp_dir, min_ticks=3)
            proc.send_signal(signal.SIGKILL)
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
            proc.wait()
            raise

        time.sleep(0.1)

        state_path = os.path.join(self.tmp_dir, "worker_state.json")
        with open(state_path) as f:
            state = json.load(f)  # must not raise — atomic writes ensure this

        self.assertIn("ticks", state)
        self.assertGreaterEqual(state["ticks"], 3)

    # ── Test 6: recover() updates persisted status to "crashed" ──────────────

    def test_recover_marks_status_crashed(self):
        proc = self._start_worker()
        try:
            _wait_for_tick(self.tmp_dir, min_ticks=1)
            proc.send_signal(signal.SIGKILL)
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
            proc.wait()
            raise

        time.sleep(0.1)
        recover(self.tmp_dir)

        state_path = os.path.join(self.tmp_dir, "worker_state.json")
        with open(state_path) as f:
            state = json.load(f)

        self.assertEqual(state.get("status"), "crashed")
        self.assertIn("crash_reason", state)


if __name__ == "__main__":
    unittest.main()
