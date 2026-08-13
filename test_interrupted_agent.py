"""
E2E test for interrupted agent behavior (PAI-43216).

Verifies that an agent interrupted mid-execution:
  - stops cleanly without data corruption
  - reports its partial state accurately
  - can be resumed or restarted without side effects
"""

import signal
import threading
import time
import unittest


class Agent:
    """Minimal agent that processes steps and can be interrupted."""

    def __init__(self):
        self.completed_steps = []
        self.interrupted = False
        self._lock = threading.Lock()

    def run(self, steps, step_duration=0.05):
        for step in steps:
            if self.interrupted:
                break
            time.sleep(step_duration)
            with self._lock:
                self.completed_steps.append(step)
        return not self.interrupted

    def interrupt(self):
        with self._lock:
            self.interrupted = True

    def reset(self):
        with self._lock:
            self.completed_steps = []
            self.interrupted = False


class TestInterruptedAgent(unittest.TestCase):

    def setUp(self):
        self.agent = Agent()

    # ------------------------------------------------------------------
    # Core interruption behaviour
    # ------------------------------------------------------------------

    def test_uninterrupted_run_completes_all_steps(self):
        steps = list(range(5))
        finished = self.agent.run(steps, step_duration=0)
        self.assertTrue(finished)
        self.assertEqual(self.agent.completed_steps, steps)

    def test_interrupt_stops_execution(self):
        steps = list(range(20))
        timer = threading.Timer(0.08, self.agent.interrupt)
        timer.start()
        finished = self.agent.run(steps, step_duration=0.05)
        timer.cancel()

        self.assertFalse(finished)
        self.assertLess(len(self.agent.completed_steps), len(steps))
        self.assertTrue(self.agent.interrupted)

    def test_interrupted_state_is_consistent(self):
        """Completed steps must form a prefix of the full step list."""
        steps = list(range(10))
        timer = threading.Timer(0.15, self.agent.interrupt)
        timer.start()
        self.agent.run(steps, step_duration=0.05)
        timer.cancel()

        completed = self.agent.completed_steps
        # Every completed step must appear at the correct index.
        self.assertEqual(completed, steps[: len(completed)])

    # ------------------------------------------------------------------
    # Reset / restart behaviour
    # ------------------------------------------------------------------

    def test_reset_clears_state(self):
        steps = list(range(5))
        self.agent.run(steps, step_duration=0)
        self.agent.reset()

        self.assertEqual(self.agent.completed_steps, [])
        self.assertFalse(self.agent.interrupted)

    def test_restart_after_interrupt_completes_full_run(self):
        steps = list(range(10))
        timer = threading.Timer(0.05, self.agent.interrupt)
        timer.start()
        self.agent.run(steps, step_duration=0.05)
        timer.cancel()

        self.agent.reset()
        finished = self.agent.run(steps, step_duration=0)
        self.assertTrue(finished)
        self.assertEqual(self.agent.completed_steps, steps)

    # ------------------------------------------------------------------
    # SIGTERM handling (Unix)
    # ------------------------------------------------------------------

    def test_sigterm_interrupts_agent(self):
        agent = Agent()
        steps = list(range(50))

        original_handler = signal.getsignal(signal.SIGTERM)

        def sigterm_handler(signum, frame):
            agent.interrupt()

        signal.signal(signal.SIGTERM, sigterm_handler)
        try:
            timer = threading.Timer(0.1, signal.raise_signal, [signal.SIGTERM])
            timer.start()
            finished = agent.run(steps, step_duration=0.05)
            timer.cancel()
        finally:
            signal.signal(signal.SIGTERM, original_handler)

        self.assertFalse(finished)
        self.assertLess(len(agent.completed_steps), len(steps))

    # ------------------------------------------------------------------
    # Edge cases
    # ------------------------------------------------------------------

    def test_interrupt_before_run_prevents_all_steps(self):
        self.agent.interrupt()
        finished = self.agent.run(list(range(5)), step_duration=0)
        self.assertFalse(finished)
        self.assertEqual(self.agent.completed_steps, [])

    def test_empty_step_list_always_finishes(self):
        finished = self.agent.run([])
        self.assertTrue(finished)
        self.assertEqual(self.agent.completed_steps, [])

    def test_multiple_interrupts_are_idempotent(self):
        for _ in range(3):
            self.agent.interrupt()
        self.assertTrue(self.agent.interrupted)
        finished = self.agent.run(list(range(5)), step_duration=0)
        self.assertFalse(finished)


if __name__ == "__main__":
    unittest.main()
