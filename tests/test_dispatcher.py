"""Tests for the Dispatcher lifecycle and fault handling."""

import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.dispatcher import Dispatcher, DispatcherFault, Task, TaskState


def ok_worker(payload):
    return f"processed:{payload}"


def failing_worker(payload):
    raise RuntimeError("worker exploded")


def make_task(tid="t1", payload="data") -> Task:
    return Task(task_id=tid, payload=payload)


class TestBasicDispatch(unittest.TestCase):
    def test_pending_after_enqueue(self):
        d = Dispatcher()
        task = make_task()
        d.enqueue(task)
        self.assertEqual(task.state, TaskState.PENDING)

    def test_completed_after_successful_dispatch(self):
        d = Dispatcher()
        d.register_worker("w1", ok_worker)
        task = make_task()
        d.enqueue(task)
        d.dispatch("t1", "w1")
        self.assertEqual(task.state, TaskState.COMPLETED)
        self.assertEqual(task.result, "processed:data")

    def test_dispatched_at_and_completed_at_set(self):
        d = Dispatcher()
        d.register_worker("w1", ok_worker)
        task = make_task()
        d.enqueue(task)
        d.dispatch("t1", "w1")
        self.assertIsNotNone(task.dispatched_at)
        self.assertIsNotNone(task.completed_at)
        self.assertGreaterEqual(task.completed_at, task.dispatched_at)

    def test_dispatch_unknown_task_raises(self):
        d = Dispatcher()
        d.register_worker("w1", ok_worker)
        with self.assertRaises(KeyError):
            d.dispatch("nonexistent", "w1")

    def test_dispatch_unknown_worker_raises(self):
        d = Dispatcher()
        task = make_task()
        d.enqueue(task)
        with self.assertRaises(KeyError):
            d.dispatch("t1", "ghost")

    def test_dispatch_non_pending_task_raises(self):
        d = Dispatcher()
        d.register_worker("w1", ok_worker)
        task = make_task()
        d.enqueue(task)
        d.dispatch("t1", "w1")
        with self.assertRaises(ValueError):
            d.dispatch("t1", "w1")


class TestFaultHandling(unittest.TestCase):
    def test_failing_worker_sets_faulted(self):
        d = Dispatcher()
        d.register_worker("w1", failing_worker)
        task = make_task()
        d.enqueue(task)
        with self.assertRaises(DispatcherFault):
            d.dispatch("t1", "w1")
        self.assertTrue(d.faulted)

    def test_failing_worker_leaves_task_failed(self):
        d = Dispatcher()
        d.register_worker("w1", failing_worker)
        task = make_task()
        d.enqueue(task)
        with self.assertRaises(DispatcherFault):
            d.dispatch("t1", "w1")
        self.assertEqual(task.state, TaskState.FAILED)
        self.assertIn("worker exploded", task.error)

    def test_inject_fault_marks_dispatcher_faulted(self):
        d = Dispatcher()
        self.assertFalse(d.faulted)
        d.inject_fault("simulated crash")
        self.assertTrue(d.faulted)

    def test_faulted_dispatcher_rejects_new_dispatches(self):
        d = Dispatcher()
        d.register_worker("w1", ok_worker)
        d.inject_fault("crash")
        task = make_task()
        d.enqueue(task)
        with self.assertRaises(DispatcherFault):
            d.dispatch("t1", "w1")

    def test_tasks_in_state_returns_dispatched(self):
        d = Dispatcher()
        tasks = [Task(task_id=f"t{i}", payload=f"p{i}") for i in range(3)]
        for t in tasks:
            d.enqueue(t)
            t.state = TaskState.DISPATCHED
        d.inject_fault("crash while processing")
        in_flight = d.tasks_in_state(TaskState.DISPATCHED)
        self.assertEqual(len(in_flight), 3)

    def test_snapshot_reflects_fault_state(self):
        d = Dispatcher()
        d.inject_fault("boom")
        snap = d.snapshot()
        self.assertTrue(snap["faulted"])
        self.assertEqual(snap["fault_reason"], "boom")

    def test_snapshot_counts_tasks_by_state(self):
        d = Dispatcher()
        d.register_worker("w1", ok_worker)
        for i in range(3):
            task = Task(task_id=f"t{i}", payload=f"p{i}")
            d.enqueue(task)
        d.dispatch("t0", "w1")
        d.dispatch("t1", "w1")
        snap = d.snapshot()
        self.assertEqual(snap["task_counts"]["PENDING"], 1)
        self.assertEqual(snap["task_counts"]["COMPLETED"], 2)

    def test_deregister_worker(self):
        d = Dispatcher()
        d.register_worker("w1", ok_worker)
        d.deregister_worker("w1")
        task = make_task()
        d.enqueue(task)
        with self.assertRaises(KeyError):
            d.dispatch("t1", "w1")


if __name__ == "__main__":
    unittest.main()
