"""Tests for post-fault dispatch probe (@crash scenario)."""

import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dispatch import Dispatcher, DispatchFault, PostFaultProbe, ProbeResult


class TestDispatcher(unittest.TestCase):
    def test_initial_state_is_healthy(self):
        d = Dispatcher()
        self.assertFalse(d.faulted)
        self.assertEqual(d.fault_count, 0)
        self.assertEqual(d.dispatch_count, 0)

    def test_register_and_dispatch(self):
        d = Dispatcher()
        d.register("ping", lambda p: "pong")
        result = d.dispatch("ping", None)
        self.assertEqual(result, "pong")
        self.assertEqual(d.dispatch_count, 1)

    def test_dispatch_unknown_event_raises_key_error(self):
        d = Dispatcher()
        with self.assertRaises(KeyError):
            d.dispatch("unknown", None)

    def test_inject_fault_transitions_to_faulted(self):
        d = Dispatcher()
        d.inject_fault()
        self.assertTrue(d.faulted)
        self.assertEqual(d.fault_count, 1)
        self.assertIsNotNone(d.last_fault_at)

    def test_dispatch_when_faulted_raises_dispatch_fault(self):
        d = Dispatcher()
        d.register("ev", lambda p: p)
        d.inject_fault()
        with self.assertRaises(DispatchFault) as ctx:
            d.dispatch("ev", {})
        self.assertEqual(ctx.exception.fault_count, 1)
        self.assertEqual(d.failed_dispatch_count, 1)

    def test_recover_clears_faulted_state(self):
        d = Dispatcher()
        d.inject_fault()
        d.recover()
        self.assertFalse(d.faulted)
        self.assertIsNotNone(d.recovered_at)

    def test_multiple_faults_accumulate(self):
        d = Dispatcher()
        d.inject_fault()
        d.recover()
        d.inject_fault()
        self.assertEqual(d.fault_count, 2)

    def test_stats_returns_expected_keys(self):
        d = Dispatcher()
        stats = d.stats()
        expected = {
            "faulted", "fault_count", "last_fault_at", "recovered_at",
            "dispatch_count", "failed_dispatch_count", "registered_handlers",
        }
        self.assertEqual(set(stats.keys()), expected)


class TestPostFaultProbe(unittest.TestCase):
    def test_probe_healthy_dispatcher(self):
        d = Dispatcher()
        probe = PostFaultProbe(d)
        result = probe.run()
        self.assertTrue(result.ok)
        self.assertFalse(result.faulted_before_probe)
        self.assertTrue(result.dispatch_ok)
        self.assertEqual(result.errors, [])

    def test_probe_after_fault_auto_recovers(self):
        d = Dispatcher()
        d.inject_fault()
        probe = PostFaultProbe(d, auto_recover=True)
        result = probe.run()
        self.assertTrue(result.faulted_before_probe)
        self.assertTrue(result.recovered)
        self.assertTrue(result.dispatch_ok)
        self.assertTrue(result.ok)

    def test_probe_after_fault_no_auto_recover_fails(self):
        d = Dispatcher()
        d.inject_fault()
        probe = PostFaultProbe(d, auto_recover=False)
        result = probe.run()
        self.assertTrue(result.faulted_before_probe)
        self.assertFalse(result.recovered)
        self.assertFalse(result.dispatch_ok)
        self.assertFalse(result.ok)
        self.assertTrue(any("faulted" in e for e in result.errors))

    def test_probe_does_not_leave_probe_handler_registered(self):
        d = Dispatcher()
        probe = PostFaultProbe(d)
        probe.run()
        self.assertNotIn("__dispatch_probe__", d.stats()["registered_handlers"])

    def test_probe_result_str_contains_status(self):
        d = Dispatcher()
        probe = PostFaultProbe(d)
        result = probe.run()
        self.assertIn("PASS", str(result))

    def test_probe_result_str_fail_on_faulted(self):
        d = Dispatcher()
        d.inject_fault()
        probe = PostFaultProbe(d, auto_recover=False)
        result = probe.run()
        self.assertIn("FAIL", str(result))

    def test_probe_records_fault_count(self):
        d = Dispatcher()
        d.inject_fault()
        d.recover()
        d.inject_fault()
        probe = PostFaultProbe(d, auto_recover=True)
        result = probe.run()
        self.assertEqual(result.fault_count, 2)

    def test_probe_latency_is_positive(self):
        d = Dispatcher()
        probe = PostFaultProbe(d)
        result = probe.run()
        self.assertGreater(result.latency_ms, 0)

    def test_existing_probe_handler_preserved(self):
        d = Dispatcher()
        sentinel = {}
        d.register("__dispatch_probe__", lambda p: sentinel)
        probe = PostFaultProbe(d)
        probe.run()
        # The pre-existing handler should still be there after probe
        self.assertIn("__dispatch_probe__", d.stats()["registered_handlers"])
        self.assertIs(d.dispatch("__dispatch_probe__", {}), sentinel)

    def test_probe_detail_includes_dispatcher_stats(self):
        d = Dispatcher()
        probe = PostFaultProbe(d)
        result = probe.run()
        self.assertIn("faulted", result.details)
        self.assertIn("fault_count", result.details)


if __name__ == "__main__":
    unittest.main()
