"""
Tests for lease-owner crash detection and recovery.

Strategy:
  1. Start a lease_owner subprocess.
  2. Wait until it has sent at least one heartbeat (via a ready-file sentinel).
  3. Send SIGKILL (which cannot be caught or deferred).
  4. Assert that lease_manager.inspect() reports the lease as crashed.
  5. Assert that lease_manager.recover() clears the stale state so a new
     owner can acquire the lease.
"""

import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import lease_manager
from lease_manager import LeaseState

OWNER_SCRIPT = Path(__file__).parent / "lease_owner.py"
POLL_INTERVAL = 0.05   # seconds between readiness checks
READINESS_TIMEOUT = 5  # seconds to wait for the owner to write the ready-file


def _wait_for_ready(ready_file: str, timeout: float = READINESS_TIMEOUT) -> int:
    """Poll until *ready_file* exists; return the PID written inside."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with open(ready_file) as f:
                return int(f.read().strip())
        except (FileNotFoundError, ValueError):
            pass
        time.sleep(POLL_INTERVAL)
    raise TimeoutError(f"Lease owner did not write ready-file within {timeout}s")


class TestLeaseOwnerDies(unittest.TestCase):

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix="lease_crash_")
        self.ready_file = os.path.join(self.tmp_dir, "ready")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def _start_owner(
        self,
        owner: str = "test-owner",
        ttl: float = 5.0,
        heartbeat_interval: float = 0.05,
        max_heartbeats: int | None = None,
    ) -> subprocess.Popen:
        return subprocess.Popen(
            [
                sys.executable, str(OWNER_SCRIPT),
                "--lease-dir", self.tmp_dir,
                "--owner", owner,
                "--ttl", str(ttl),
                "--heartbeat-interval", str(heartbeat_interval),
                "--ready-file", self.ready_file,
                *(["--max-heartbeats", str(max_heartbeats)] if max_heartbeats else []),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    # ── Test 1: SIGKILL leaves a detectable crashed lease ─────────────────────

    def test_sigkill_leaves_crashed_lease(self):
        proc = self._start_owner()
        try:
            _wait_for_ready(self.ready_file)
            proc.send_signal(signal.SIGKILL)
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
            proc.wait()
            raise

        # Give the OS a moment to reflect the process death.
        time.sleep(0.1)

        state = lease_manager.inspect(self.tmp_dir)
        self.assertEqual(state.status, "crashed", f"Expected 'crashed', got {state.status!r}: {state.crash_reason}")
        self.assertIn("dead process", state.crash_reason)

    # ── Test 2: Clean SIGTERM does NOT leave a crashed lease ──────────────────

    def test_sigterm_releases_lease_cleanly(self):
        proc = self._start_owner()
        try:
            _wait_for_ready(self.ready_file)
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
            proc.wait()
            raise

        time.sleep(0.1)

        state = lease_manager.inspect(self.tmp_dir)
        self.assertEqual(state.status, "released", f"Expected 'released', got {state.status!r}: {state.crash_reason}")
        self.assertFalse(state.is_expired)

    # ── Test 3: recover() clears the stale lease after a crash ───────────────

    def test_recover_clears_crashed_lease(self):
        proc = self._start_owner()
        try:
            _wait_for_ready(self.ready_file)
            proc.send_signal(signal.SIGKILL)
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
            proc.wait()
            raise

        time.sleep(0.1)

        # Before recovery the lease is still marked "held".
        raw_state = lease_manager.inspect(self.tmp_dir)
        self.assertEqual(raw_state.status, "crashed")

        # recover() detects and clears the stale lease.
        recovered = lease_manager.recover(self.tmp_dir)
        self.assertEqual(recovered.status, "crashed", "recover() should report the crash it found")

        # After recovery the lease file should reflect the crash.
        post = lease_manager.inspect(self.tmp_dir)
        self.assertIn(post.status, ("crashed", "released"),
                      "lease should be cleared after recovery")
        self.assertIsNone(post.pid, "pid should be cleared after recovery")

    # ── Test 4: New owner can acquire lease after crash + recovery ────────────

    def test_new_owner_acquires_after_crash_and_recovery(self):
        proc = self._start_owner(owner="original-owner")
        try:
            _wait_for_ready(self.ready_file)
            proc.send_signal(signal.SIGKILL)
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
            proc.wait()
            raise

        time.sleep(0.1)
        lease_manager.recover(self.tmp_dir)

        # A new owner must be able to acquire the lease immediately.
        acquired = lease_manager.acquire(self.tmp_dir, owner="replacement-owner", ttl_secs=5.0)
        self.assertTrue(acquired, "Replacement owner should be able to acquire the lease after recovery")

        state = lease_manager.inspect(self.tmp_dir)
        self.assertEqual(state.status, "held")
        self.assertEqual(state.owner, "replacement-owner")

    # ── Test 5: Dead owner without recovery still allows takeover ─────────────

    def test_dead_owner_allows_direct_takeover(self):
        """
        A new acquire() call detects the dead PID inline and takes over without
        needing an explicit recover() call first.
        """
        proc = self._start_owner(owner="dying-owner")
        try:
            _wait_for_ready(self.ready_file)
            proc.send_signal(signal.SIGKILL)
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
            proc.wait()
            raise

        time.sleep(0.1)

        # No recover() call — acquire() itself should detect the dead PID.
        acquired = lease_manager.acquire(self.tmp_dir, owner="new-owner", ttl_secs=5.0)
        self.assertTrue(acquired, "acquire() should succeed when the previous owner's PID is dead")

        state = lease_manager.inspect(self.tmp_dir)
        self.assertEqual(state.owner, "new-owner")
        self.assertEqual(state.status, "held")

    # ── Test 6: Heartbeat expiry detected without a dead PID ─────────────────

    def test_expired_heartbeat_reported_as_expired(self):
        """
        If the lease holder stops heartbeating but the PID remains alive (e.g.
        a hung process), inspect() reports status='expired' once the TTL passes.
        """
        # Use a very short TTL so the test doesn't take long.
        proc = self._start_owner(ttl=0.3, heartbeat_interval=0.05, max_heartbeats=2)
        try:
            _wait_for_ready(self.ready_file)
            proc.wait(timeout=5)  # let it finish naturally after max_heartbeats
        except Exception:
            proc.kill()
            proc.wait()
            raise

        # The process exited cleanly (SIGTERM-style exit via finally), so the
        # lease should be "released".  Manually reset it to "held" with a stale
        # heartbeat to test the expiry path independently.
        import json
        lease_path = os.path.join(self.tmp_dir, lease_manager.LEASE_FILE)
        with open(lease_path) as f:
            data = json.load(f)

        data["status"] = "held"
        data["pid"] = os.getpid()  # live PID so dead-PID path won't trigger
        data["last_heartbeat"] = time.time() - 10.0  # far in the past
        data["ttl_secs"] = 0.3

        import json as _json
        with open(lease_path, "w") as f:
            _json.dump(data, f)

        state = lease_manager.inspect(self.tmp_dir)
        self.assertEqual(state.status, "expired",
                         f"Expected 'expired' but got {state.status!r}: {state.crash_reason}")
        self.assertIn("heartbeat expired", state.crash_reason)

    # ── Test 7: Live owner with valid heartbeat is NOT a crash ────────────────

    def test_live_owner_not_reported_as_crash(self):
        proc = self._start_owner()
        try:
            _wait_for_ready(self.ready_file)
            state = lease_manager.inspect(self.tmp_dir)
            self.assertEqual(state.status, "held",
                             f"Expected 'held' while owner is live, got {state.status!r}")
            self.assertFalse(state.is_expired)
        finally:
            proc.kill()
            proc.wait()

    # ── Test 8: Second owner cannot acquire while first is alive ──────────────

    def test_second_owner_blocked_while_first_alive(self):
        proc = self._start_owner(owner="first-owner")
        try:
            _wait_for_ready(self.ready_file)
            # Try to acquire from the same process (different owner name).
            acquired = lease_manager.acquire(self.tmp_dir, owner="second-owner", ttl_secs=5.0)
            self.assertFalse(acquired, "Second owner must not acquire a lease held by a live process")
        finally:
            proc.kill()
            proc.wait()


if __name__ == "__main__":
    unittest.main()
