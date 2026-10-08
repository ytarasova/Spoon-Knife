"""Tests for the post-fault dispatch probe."""

import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.dispatcher import Dispatcher, Task, TaskState
from src.probe import probe


def ok_worker(payload):
    return f"ok:{payload}"


def failing_worker(payload):
    raise RuntimeError(f"recovery failed for {payload}")


def make_in_flight_dispatcher(n: int = 3) -> Dispatcher:
    d = Dispatcher()
    tasks = [Task(task_id=f"t{i}", payload=f"p{i}") for i in range(n)]
    for t in tasks:
        d.enqueue(t)
        t.state = TaskState.DISPATCHED
    d.inject_fault("simulated crash")
    return d


class TestProbeUnfaulted(unittest.TestCase):
    def test_probe_unfaulted_dispatcher(self):
        d = Dispatcher()
        task = Task(task_id="t1", payload="data")
        d.enqueue(task)
        d.register_worker("w1", ok_worker)
        d.dispatch("t1", "w1")
        report = probe(d, workers={"w1": ok_worker})
        self.assertFalse(report.was_faulted)
        self.assertEqual(report.recovered, 0)
        self.assertEqual(report.failed_recovery, 0)

    def test_probe_empty_dispatcher_no_crash(self):
        d = Dispatcher()
        report = probe(d, workers={"w1": ok_worker})
        self.assertFalse(report.was_faulted)
        self.assertEqual(report.total_in_flight, 0)


class TestProbeRecovery(unittest.TestCase):
    def test_recovers_all_in_flight_tasks(self):
        d = make_in_flight_dispatcher(3)
        report = probe(d, workers={"w1": ok_worker})
        self.assertTrue(report.was_faulted)
        self.assertEqual(report.recovered, 3)
        self.assertEqual(report.failed_recovery, 0)

    def test_report_details_have_one_entry_per_task(self):
        d = make_in_flight_dispatcher(4)
        report = probe(d, workers={"w1": ok_worker})
        self.assertEqual(len(report.details), 4)

    def test_report_details_contain_outcome(self):
        d = make_in_flight_dispatcher(2)
        report = probe(d, workers={"w1": ok_worker})
        for detail in report.details:
            self.assertEqual(detail["outcome"], "recovered")
            self.assertIn("result", detail)

    def test_report_details_link_original_to_recovery_task(self):
        d = make_in_flight_dispatcher(1)
        report = probe(d, workers={"w1": ok_worker})
        detail = report.details[0]
        self.assertEqual(detail["original_task_id"], "t0")
        self.assertEqual(detail["recovery_task_id"], "t0__recovery")

    def test_fault_reason_captured(self):
        d = make_in_flight_dispatcher(1)
        report = probe(d, workers={"w1": ok_worker})
        self.assertEqual(report.fault_reason, "simulated crash")

    def test_snapshot_before_populated(self):
        d = make_in_flight_dispatcher(2)
        report = probe(d, workers={"w1": ok_worker})
        self.assertTrue(report.snapshot_before["faulted"])
        self.assertEqual(report.snapshot_before["task_counts"]["DISPATCHED"], 2)

    def test_probe_success_true_when_all_recovered(self):
        d = make_in_flight_dispatcher(2)
        report = probe(d, workers={"w1": ok_worker})
        self.assertTrue(report.success)

    def test_probe_no_in_flight_tasks_after_fault(self):
        d = Dispatcher()
        d.inject_fault("instant crash before dispatch")
        report = probe(d, workers={"w1": ok_worker})
        self.assertTrue(report.was_faulted)
        self.assertEqual(report.recovered, 0)
        self.assertEqual(report.total_in_flight, 0)

    def test_round_robin_across_multiple_workers(self):
        d = make_in_flight_dispatcher(6)
        workers = {"w1": ok_worker, "w2": ok_worker, "w3": ok_worker}
        report = probe(d, workers=workers)
        self.assertEqual(report.recovered, 6)
        used_workers = {detail["worker_id"] for detail in report.details}
        self.assertEqual(len(used_workers), 3)

    def test_skipped_counts_terminal_tasks(self):
        d = Dispatcher()
        d.register_worker("w1", ok_worker)
        t_ok = Task(task_id="t_done", payload="done")
        d.enqueue(t_ok)
        d.dispatch("t_done", "w1")  # COMPLETED

        t_inf = Task(task_id="t_fly", payload="fly")
        d.enqueue(t_inf)
        t_inf.state = TaskState.DISPATCHED

        d.inject_fault("crash")
        report = probe(d, workers={"w1": ok_worker})
        self.assertEqual(report.skipped, 1)
        self.assertEqual(report.recovered, 1)


class TestProbeFailedRecovery(unittest.TestCase):
    def test_failed_recovery_counted(self):
        d = make_in_flight_dispatcher(2)
        report = probe(d, workers={"w1": failing_worker})
        self.assertEqual(report.failed_recovery, 2)
        self.assertEqual(report.recovered, 0)

    def test_failed_recovery_details_have_error(self):
        d = make_in_flight_dispatcher(1)
        report = probe(d, workers={"w1": failing_worker})
        self.assertEqual(report.details[0]["outcome"], "failed")
        self.assertIn("error", report.details[0])

    def test_probe_success_false_when_recovery_fails(self):
        d = make_in_flight_dispatcher(1)
        report = probe(d, workers={"w1": failing_worker})
        self.assertFalse(report.success)

    def test_partial_recovery(self):
        calls = [0]

        def selective_worker(payload):
            calls[0] += 1
            if calls[0] % 2 == 0:
                raise RuntimeError("even tasks fail")
            return f"ok:{payload}"

        d = make_in_flight_dispatcher(4)
        report = probe(d, workers={"w1": selective_worker})
        self.assertEqual(report.recovered + report.failed_recovery, 4)
        self.assertGreater(report.recovered, 0)
        self.assertGreater(report.failed_recovery, 0)


if __name__ == "__main__":
    unittest.main()
