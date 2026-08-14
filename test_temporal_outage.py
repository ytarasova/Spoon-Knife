"""
Tests for temporal outage resilience.

Covers:
  1. ExponentialBackoff — delay growth, jitter, reset.
  2. CircuitBreaker — state transitions (CLOSED → OPEN → HALF_OPEN → CLOSED).
  3. OutageTracker — atomic persistence of outage events.
  4. OutageAwareWorker — full lifecycle: healthy, degraded, outage, recovery.
  5. detect_outage / recover_from_outage — module-level helpers.
"""

import json
import os
import shutil
import tempfile
import time
import unittest
from unittest.mock import MagicMock, call, patch

from temporal_outage import (
    BackoffConfig,
    CircuitBreaker,
    CircuitBreakerConfig,
    CircuitOpenError,
    CircuitState,
    ExponentialBackoff,
    OutageAwareWorker,
    OutagePhase,
    OutageReport,
    OutageTracker,
    WorkerConfig,
    detect_outage,
    recover_from_outage,
)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _make_dir() -> str:
    return tempfile.mkdtemp(prefix="temporal_outage_test_")


def _read_outage(state_dir: str) -> dict:
    path = os.path.join(state_dir, "outage_state.json")
    with open(path) as f:
        return json.load(f)


def _read_worker(state_dir: str) -> dict:
    path = os.path.join(state_dir, "worker_state.json")
    with open(path) as f:
        return json.load(f)


def _failing_task():
    raise RuntimeError("service unavailable")


def _always_ok():
    return "ok"


# ─────────────────────────────────────────────────────────────────────────────
# 1. ExponentialBackoff
# ─────────────────────────────────────────────────────────────────────────────

class TestExponentialBackoff(unittest.TestCase):

    def test_delays_grow_geometrically(self):
        cfg = BackoffConfig(base=1.0, multiplier=2.0, max_delay=100.0, jitter=0.0)
        bo = ExponentialBackoff(cfg)
        delays = [bo.next_delay() for _ in range(4)]
        self.assertAlmostEqual(delays[0], 1.0, places=5)
        self.assertAlmostEqual(delays[1], 2.0, places=5)
        self.assertAlmostEqual(delays[2], 4.0, places=5)
        self.assertAlmostEqual(delays[3], 8.0, places=5)

    def test_delay_capped_at_max(self):
        cfg = BackoffConfig(base=10.0, multiplier=10.0, max_delay=25.0, jitter=0.0)
        bo = ExponentialBackoff(cfg)
        bo.next_delay()   # 10
        bo.next_delay()   # 25 (capped)
        self.assertAlmostEqual(bo.next_delay(), 25.0, places=5)

    def test_jitter_within_bounds(self):
        cfg = BackoffConfig(base=1.0, multiplier=1.0, max_delay=10.0, jitter=0.5)
        bo = ExponentialBackoff(cfg)
        for _ in range(20):
            delay = bo.next_delay()
            bo.reset()
            self.assertGreaterEqual(delay, 1.0)
            self.assertLessEqual(delay, 1.5 + 1e-9)

    def test_reset_restarts_from_base(self):
        cfg = BackoffConfig(base=1.0, multiplier=3.0, max_delay=100.0, jitter=0.0)
        bo = ExponentialBackoff(cfg)
        bo.next_delay()   # 1
        bo.next_delay()   # 3
        bo.reset()
        self.assertAlmostEqual(bo.next_delay(), 1.0, places=5)

    def test_attempt_counter_increments(self):
        bo = ExponentialBackoff()
        self.assertEqual(bo.attempt, 0)
        bo.next_delay()
        self.assertEqual(bo.attempt, 1)
        bo.next_delay()
        self.assertEqual(bo.attempt, 2)


# ─────────────────────────────────────────────────────────────────────────────
# 2. CircuitBreaker
# ─────────────────────────────────────────────────────────────────────────────

class TestCircuitBreaker(unittest.TestCase):

    def _breaker(self, threshold=3, cooldown=0.05, success_threshold=1):
        cfg = CircuitBreakerConfig(
            failure_threshold=threshold,
            cooldown=cooldown,
            success_threshold=success_threshold,
        )
        return CircuitBreaker(cfg)

    # ── Initial state ─────────────────────────────────────────────────────────

    def test_starts_closed(self):
        cb = self._breaker()
        self.assertEqual(cb.state, CircuitState.CLOSED)

    def test_allows_requests_when_closed(self):
        cb = self._breaker()
        self.assertTrue(cb.allow_request())

    # ── CLOSED → OPEN ─────────────────────────────────────────────────────────

    def test_opens_after_failure_threshold(self):
        cb = self._breaker(threshold=3)
        for _ in range(3):
            cb.record_failure()
        self.assertEqual(cb.state, CircuitState.OPEN)

    def test_blocks_requests_when_open(self):
        cb = self._breaker(threshold=1)
        cb.record_failure()
        self.assertFalse(cb.allow_request())

    def test_success_resets_failure_count(self):
        cb = self._breaker(threshold=3)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        cb.record_failure()   # back to 1, not 3
        self.assertEqual(cb.state, CircuitState.CLOSED)

    # ── OPEN → HALF_OPEN ──────────────────────────────────────────────────────

    def test_transitions_to_half_open_after_cooldown(self):
        cb = self._breaker(threshold=1, cooldown=0.05)
        cb.record_failure()
        self.assertEqual(cb.state, CircuitState.OPEN)
        time.sleep(0.1)
        self.assertEqual(cb.state, CircuitState.HALF_OPEN)

    def test_half_open_allows_one_request(self):
        cb = self._breaker(threshold=1, cooldown=0.05)
        cb.record_failure()
        time.sleep(0.1)
        self.assertTrue(cb.allow_request())  # HALF_OPEN

    # ── HALF_OPEN → CLOSED (recovery) ────────────────────────────────────────

    def test_closes_after_success_in_half_open(self):
        cb = self._breaker(threshold=1, cooldown=0.05, success_threshold=1)
        cb.record_failure()
        time.sleep(0.1)
        cb.record_success()  # probe succeeded
        self.assertEqual(cb.state, CircuitState.CLOSED)

    # ── HALF_OPEN → OPEN (probe failed) ──────────────────────────────────────

    def test_reopens_on_failure_in_half_open(self):
        cb = self._breaker(threshold=1, cooldown=0.05)
        cb.record_failure()
        time.sleep(0.1)
        # Now in HALF_OPEN; a failure re-opens
        cb.record_failure()
        self.assertEqual(cb.state, CircuitState.OPEN)

    # ── call() integration ───────────────────────────────────────────────────

    def test_call_propagates_return_value(self):
        cb = self._breaker()
        result = cb.call(lambda: 42)
        self.assertEqual(result, 42)

    def test_call_raises_on_open(self):
        cb = self._breaker(threshold=1)
        cb.record_failure()
        with self.assertRaises(CircuitOpenError):
            cb.call(lambda: None)

    def test_call_records_failure_on_exception(self):
        cb = self._breaker(threshold=2)
        with self.assertRaises(ValueError):
            cb.call(lambda: (_ for _ in ()).throw(ValueError("boom")))
        self.assertEqual(cb._consecutive_failures, 1)

    def test_call_records_success(self):
        cb = self._breaker()
        cb.call(lambda: None)
        self.assertEqual(cb._consecutive_failures, 0)


# ─────────────────────────────────────────────────────────────────────────────
# 3. OutageTracker
# ─────────────────────────────────────────────────────────────────────────────

class TestOutageTracker(unittest.TestCase):

    def setUp(self):
        self.tmp = _make_dir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_initial_phase_is_healthy(self):
        tracker = OutageTracker(self.tmp)
        self.assertEqual(tracker.phase, OutagePhase.HEALTHY)

    def test_record_persists_phase(self):
        tracker = OutageTracker(self.tmp)
        tracker.record(OutagePhase.OUTAGE, "dependency down")
        raw = _read_outage(self.tmp)
        self.assertEqual(raw["phase"], "outage")

    def test_history_accumulates(self):
        tracker = OutageTracker(self.tmp)
        tracker.record(OutagePhase.DEGRADED, "first failure")
        tracker.record(OutagePhase.OUTAGE, "circuit opened")
        raw = _read_outage(self.tmp)
        self.assertEqual(len(raw["history"]), 2)
        self.assertEqual(raw["history"][0]["phase"], "degraded")
        self.assertEqual(raw["history"][1]["phase"], "outage")

    def test_reload_restores_phase(self):
        tracker1 = OutageTracker(self.tmp)
        tracker1.record(OutagePhase.OUTAGE, "down")
        tracker2 = OutageTracker(self.tmp)  # fresh instance, same dir
        self.assertEqual(tracker2.phase, OutagePhase.OUTAGE)

    def test_atomic_write_produces_valid_json(self):
        tracker = OutageTracker(self.tmp)
        tracker.record(OutagePhase.RECOVERING, "probing")
        path = os.path.join(self.tmp, "outage_state.json")
        with open(path) as f:
            data = json.load(f)  # must not raise
        self.assertIn("phase", data)
        self.assertIn("history", data)

    def test_extra_fields_stored(self):
        tracker = OutageTracker(self.tmp)
        tracker.record(OutagePhase.OUTAGE, "manual override", {"ticket": "INC-42"})
        raw = _read_outage(self.tmp)
        self.assertEqual(raw["history"][0].get("ticket"), "INC-42")


# ─────────────────────────────────────────────────────────────────────────────
# 4. OutageAwareWorker
# ─────────────────────────────────────────────────────────────────────────────

class TestOutageAwareWorker(unittest.TestCase):

    def setUp(self):
        self.tmp = _make_dir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _config(self, threshold=3, cooldown=0.05, retries=0):
        return WorkerConfig(
            tick_interval=0.0,
            backoff=BackoffConfig(base=0.0, multiplier=1.0, max_delay=0.0, jitter=0.0),
            circuit=CircuitBreakerConfig(
                failure_threshold=threshold,
                cooldown=cooldown,
                success_threshold=1,
            ),
            max_retries_per_tick=retries,
        )

    # ── Healthy operation ─────────────────────────────────────────────────────

    def test_healthy_worker_records_ticks(self):
        cfg = self._config()
        cfg.max_ticks = 5
        worker = OutageAwareWorker(_always_ok, self.tmp, cfg)
        worker.run()

        state = _read_worker(self.tmp)
        self.assertEqual(state["ticks"], 5)
        self.assertEqual(state["status"], "stopped")

    def test_healthy_worker_stays_healthy(self):
        cfg = self._config()
        cfg.max_ticks = 5
        worker = OutageAwareWorker(_always_ok, self.tmp, cfg)
        worker.run()

        # Outage state file may not exist if phase never changed from HEALTHY.
        # Use detect_outage() which handles the missing-file case gracefully.
        report = detect_outage(self.tmp)
        self.assertFalse(report.in_outage)

    # ── Outage detection ──────────────────────────────────────────────────────

    def test_failing_tasks_open_circuit(self):
        cfg = self._config(threshold=3, retries=0)
        cfg.max_ticks = 5
        worker = OutageAwareWorker(_failing_task, self.tmp, cfg)
        worker.run()

        state = _read_worker(self.tmp)
        self.assertEqual(state["phase"], "outage")

    def test_outage_increments_failed_ticks(self):
        cfg = self._config(threshold=2, retries=0)
        cfg.max_ticks = 3
        worker = OutageAwareWorker(_failing_task, self.tmp, cfg)
        worker.run()

        state = _read_worker(self.tmp)
        self.assertGreater(state["failed_ticks"], 0)

    def test_open_circuit_skips_tasks(self):
        call_count = 0

        def counting_fail():
            nonlocal call_count
            call_count += 1
            raise RuntimeError("down")

        cfg = self._config(threshold=2, retries=0, cooldown=100.0)
        cfg.max_ticks = 10
        worker = OutageAwareWorker(counting_fail, self.tmp, cfg)
        worker.run()

        # Task should be called only until the circuit opens (2 failures),
        # then skipped for the remaining ticks.
        self.assertLessEqual(call_count, cfg.circuit.failure_threshold + 1)

    def test_skipped_ticks_counted(self):
        cfg = self._config(threshold=2, retries=0, cooldown=100.0)
        cfg.max_ticks = 10
        worker = OutageAwareWorker(_failing_task, self.tmp, cfg)
        worker.run()

        state = _read_worker(self.tmp)
        self.assertGreater(state.get("skipped_ticks", 0), 0)

    # ── Recovery ──────────────────────────────────────────────────────────────

    def test_worker_recovers_after_transient_outage(self):
        """Fail for first N calls then succeed — circuit should close again."""
        call_count = 0
        fail_until = 3  # first 3 calls fail

        def transient_fail():
            nonlocal call_count
            call_count += 1
            if call_count <= fail_until:
                raise RuntimeError("transient error")

        # tick_interval=0.012s with cooldown=0.02s:
        # ticks 1-3 fail and open the circuit (~36ms elapsed).
        # tick 4 (~48ms): circuit OPEN, cooldown not elapsed → skipped.
        # tick 5 (~60ms): cooldown elapsed → HALF_OPEN; probe succeeds → CLOSED.
        # remaining ticks: succeed → phase stays HEALTHY.
        cfg = WorkerConfig(
            tick_interval=0.012,
            max_ticks=15,
            backoff=BackoffConfig(base=0.0, multiplier=1.0, max_delay=0.0, jitter=0.0),
            circuit=CircuitBreakerConfig(
                failure_threshold=3,
                cooldown=0.02,
                success_threshold=1,
            ),
            max_retries_per_tick=0,
        )
        worker = OutageAwareWorker(transient_fail, self.tmp, cfg)
        worker.run()

        state = _read_worker(self.tmp)
        self.assertEqual(state["phase"], "healthy",
                         f"Expected healthy but got {state['phase']}")

    # ── Retry logic ───────────────────────────────────────────────────────────

    def test_retry_succeeds_before_circuit_opens(self):
        attempt = 0

        def flaky():
            nonlocal attempt
            attempt += 1
            if attempt % 2 != 0:
                raise RuntimeError("flaky")

        cfg = self._config(threshold=3, retries=1)
        cfg.max_ticks = 6
        worker = OutageAwareWorker(flaky, self.tmp, cfg)
        worker.run()

        # With retries=1, each tick gets 2 attempts; the even attempt succeeds.
        # Circuit should stay closed (not enough net failures to open it).
        state = _read_worker(self.tmp)
        self.assertNotEqual(state["phase"], "outage")

    # ── Phase events ──────────────────────────────────────────────────────────

    def test_degraded_phase_recorded_before_outage(self):
        cfg = self._config(threshold=5, retries=0)
        cfg.max_ticks = 4
        worker = OutageAwareWorker(_failing_task, self.tmp, cfg)
        worker.run()

        raw = _read_outage(self.tmp)
        phases = [e["phase"] for e in raw.get("history", [])]
        self.assertIn("degraded", phases)

    def test_outage_phase_recorded(self):
        cfg = self._config(threshold=2, retries=0)
        cfg.max_ticks = 5
        worker = OutageAwareWorker(_failing_task, self.tmp, cfg)
        worker.run()

        raw = _read_outage(self.tmp)
        phases = [e["phase"] for e in raw.get("history", [])]
        self.assertIn("outage", phases)


# ─────────────────────────────────────────────────────────────────────────────
# 5. detect_outage / recover_from_outage
# ─────────────────────────────────────────────────────────────────────────────

class TestDetectAndRecover(unittest.TestCase):

    def setUp(self):
        self.tmp = _make_dir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_detect_outage_healthy_when_no_state_file(self):
        report = detect_outage(self.tmp)
        self.assertFalse(report.in_outage)
        self.assertEqual(report.phase, OutagePhase.HEALTHY)

    def test_detect_outage_reports_outage(self):
        tracker = OutageTracker(self.tmp)
        tracker.record(OutagePhase.OUTAGE, "circuit opened")

        report = detect_outage(self.tmp)
        self.assertTrue(report.in_outage)
        self.assertEqual(report.phase, OutagePhase.OUTAGE)

    def test_detect_outage_degraded_is_in_outage(self):
        tracker = OutageTracker(self.tmp)
        tracker.record(OutagePhase.DEGRADED, "first failures")

        report = detect_outage(self.tmp)
        self.assertTrue(report.in_outage)

    def test_detect_outage_recovering_is_in_outage(self):
        tracker = OutageTracker(self.tmp)
        tracker.record(OutagePhase.RECOVERING, "half-open probe")

        report = detect_outage(self.tmp)
        self.assertTrue(report.in_outage)

    def test_detect_outage_healthy_not_in_outage(self):
        tracker = OutageTracker(self.tmp)
        tracker.record(OutagePhase.OUTAGE, "circuit open")
        tracker.record(OutagePhase.HEALTHY, "recovered")

        report = detect_outage(self.tmp)
        self.assertFalse(report.in_outage)

    def test_recover_from_outage_stamps_healthy(self):
        tracker = OutageTracker(self.tmp)
        tracker.record(OutagePhase.OUTAGE, "circuit opened")

        report = recover_from_outage(self.tmp)
        self.assertTrue(report.in_outage)  # was in outage when called

        # After recover, phase is now HEALTHY
        fresh = detect_outage(self.tmp)
        self.assertFalse(fresh.in_outage)
        self.assertEqual(fresh.phase, OutagePhase.HEALTHY)

    def test_recover_from_healthy_is_noop(self):
        # No outage state file: recover_from_outage should be a no-op.
        report = recover_from_outage(self.tmp)
        self.assertFalse(report.in_outage)

    def test_report_includes_history(self):
        tracker = OutageTracker(self.tmp)
        tracker.record(OutagePhase.DEGRADED, "first")
        tracker.record(OutagePhase.OUTAGE, "second")

        report = detect_outage(self.tmp)
        self.assertEqual(len(report.history), 2)

    def test_report_reason_matches_last_event(self):
        tracker = OutageTracker(self.tmp)
        tracker.record(OutagePhase.OUTAGE, "circuit opened due to 3 failures")

        report = detect_outage(self.tmp)
        self.assertIn("3 failures", report.reason)


if __name__ == "__main__":
    unittest.main(verbosity=2)
