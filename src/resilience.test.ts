import { describe, it, expect, beforeEach } from "bun:test";
import { Checkpoint, ResilienceManager, resilience } from "./resilience";

type AppState = {
  value: number;
  items: string[];
};

function makeState(value = 0, items: string[] = []): AppState {
  return { value, items };
}

describe("Checkpoint", () => {
  it("deep-copies the state on creation", () => {
    const original = makeState(1, ["a", "b"]);
    const cp = new Checkpoint(original);
    original.value = 99;
    original.items.push("mutated");
    expect(cp.state.value).toBe(1);
    expect(cp.state.items).toEqual(["a", "b"]);
  });

  it("assigns a unique id and timestamp", () => {
    const cp1 = new Checkpoint(makeState());
    const cp2 = new Checkpoint(makeState());
    expect(cp1.id).toMatch(/^cp_\d+_/);
    expect(cp1.id).not.toBe(cp2.id);
    expect(cp1.timestamp).toBeGreaterThan(0);
  });
});

describe("ResilienceManager — roll: after (default)", () => {
  let mgr: ResilienceManager<AppState>;

  beforeEach(() => {
    mgr = resilience<AppState>({ roll: "after" });
  });

  it("returns success result when operation succeeds", async () => {
    const state = makeState(10, ["x"]);
    const result = await mgr.execute(async (s) => s.value * 2, state);
    expect(result.success).toBe(true);
    expect(result.result).toBe(20);
    expect(result.error).toBeUndefined();
  });

  it("creates a checkpoint before executing", async () => {
    const state = makeState(5);
    await mgr.execute(async (s) => s.value, state);
    expect(mgr.checkpointCount).toBe(1);
    expect(mgr.latestCheckpoint?.state.value).toBe(5);
  });

  it("rolls back to checkpoint state after operation fails", async () => {
    const state = makeState(42, ["original"]);
    const result = await mgr.execute(async (_s) => {
      throw new Error("operation failed");
    }, state);
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe("operation failed");
    expect(result.rolledBack).toEqual(makeState(42, ["original"]));
  });

  it("rolled-back state is a deep copy, not a reference", async () => {
    const state = makeState(1, ["item"]);
    const result = await mgr.execute(async (_s) => {
      throw new Error("fail");
    }, state);
    (result.rolledBack as AppState).value = 999;
    expect(mgr.latestCheckpoint?.state.value).toBe(1);
  });

  it("operation receives a deep copy of state, not the original", async () => {
    const state = makeState(7, ["original"]);
    let capturedState: AppState | null = null;
    await mgr.execute(async (s) => {
      capturedState = s;
      s.value = 1000;
      return s;
    }, state);
    expect(state.value).toBe(7);
    expect(capturedState?.value).toBe(1000);
  });

  it("accumulates multiple checkpoints", async () => {
    for (let i = 0; i < 3; i++) {
      await mgr.execute(async (s) => s.value, makeState(i));
    }
    expect(mgr.checkpointCount).toBe(3);
  });

  it("caps checkpoints at maxCheckpoints", async () => {
    const limited = resilience<AppState>({ roll: "after", maxCheckpoints: 3 });
    for (let i = 0; i < 5; i++) {
      await limited.execute(async (s) => s.value, makeState(i));
    }
    expect(limited.checkpointCount).toBe(3);
    expect(limited.latestCheckpoint?.state.value).toBe(4);
  });

  it("clearCheckpoints resets the store", async () => {
    await mgr.execute(async (s) => s.value, makeState(1));
    mgr.clearCheckpoints();
    expect(mgr.checkpointCount).toBe(0);
    expect(mgr.latestCheckpoint).toBeUndefined();
  });
});

describe("ResilienceManager — manual cp / rollback", () => {
  it("cp() stores a checkpoint and rollback() restores state", () => {
    const mgr = resilience<AppState>();
    const state = makeState(5, ["hello"]);
    const cp = mgr.cp(state);
    expect(cp.state).toEqual(state);
    const restored = mgr.rollback(cp);
    expect(restored).toEqual(state);
  });

  it("rollback() with no argument uses the latest checkpoint", () => {
    const mgr = resilience<AppState>();
    mgr.cp(makeState(1));
    mgr.cp(makeState(99));
    const restored = mgr.rollback();
    expect(restored?.value).toBe(99);
  });

  it("rollback() returns null when no checkpoints exist", () => {
    const mgr = resilience<AppState>();
    expect(mgr.rollback()).toBeNull();
  });
});

describe("ResilienceManager — roll: before", () => {
  it("skips operation and rolls back immediately when prior checkpoint exists", async () => {
    const mgr = resilience<AppState>({ roll: "before" });
    const saved = makeState(10, ["saved"]);
    mgr.cp(saved);

    let operationCalled = false;
    const result = await mgr.execute(async (s) => {
      operationCalled = true;
      return s.value;
    }, makeState(99));

    expect(operationCalled).toBe(false);
    expect(result.success).toBe(false);
    expect((result.rolledBack as AppState).value).toBe(10);
  });

  it("executes normally when no prior checkpoint exists", async () => {
    const mgr = resilience<AppState>({ roll: "before" });
    const result = await mgr.execute(async (s) => s.value * 3, makeState(4));
    expect(result.success).toBe(true);
    expect(result.result).toBe(12);
  });
});

describe("ResilienceManager — roll: in-flight", () => {
  it("succeeds when operation completes before abort", async () => {
    const mgr = resilience<AppState>({ roll: "in-flight" });
    const result = await mgr.execute(
      async (s, _signal) => s.value * 2,
      makeState(5)
    );
    expect(result.success).toBe(true);
    expect(result.result).toBe(10);
    expect(result.abortedInFlight).toBeUndefined();
  });

  it("creates a checkpoint before executing", async () => {
    const mgr = resilience<AppState>({ roll: "in-flight" });
    await mgr.execute(async (s, _signal) => s.value, makeState(7));
    expect(mgr.checkpointCount).toBe(1);
    expect(mgr.latestCheckpoint?.state.value).toBe(7);
  });

  it("isInflight is true while operation is running, false after", async () => {
    const mgr = resilience<AppState>({ roll: "in-flight" });
    let seenInflight = false;
    await mgr.execute(async (s, _signal) => {
      seenInflight = mgr.isInflight;
      return s.value;
    }, makeState(1));
    expect(seenInflight).toBe(true);
    expect(mgr.isInflight).toBe(false);
  });

  it("rolls back state and sets abortedInFlight when abort() is called during operation", async () => {
    const mgr = resilience<AppState>({ roll: "in-flight" });
    const initialState = makeState(42, ["before"]);

    // Operation that waits for the signal to be aborted
    const executePromise = mgr.execute(async (_s, signal) => {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
      return 0;
    }, initialState);

    // Give the operation time to start
    await new Promise((r) => setTimeout(r, 5));

    // Abort while in-flight
    const rolledBackState = mgr.abort();

    const result = await executePromise;

    expect(result.success).toBe(false);
    expect(result.abortedInFlight).toBe(true);
    expect(result.rolledBack).toEqual(initialState);
    expect(rolledBackState).toEqual(initialState);
  });

  it("rolls back to pre-operation checkpoint when operation throws AbortError", async () => {
    const mgr = resilience<AppState>({ roll: "in-flight" });
    const savedState = makeState(99, ["checkpoint-value"]);

    const result = await mgr.execute(async (_s, _signal) => {
      throw new DOMException("Operation cancelled", "AbortError");
    }, savedState);

    expect(result.success).toBe(false);
    expect(result.abortedInFlight).toBe(true);
    expect(result.rolledBack).toEqual(savedState);
  });

  it("operation receives abort signal that starts non-aborted", async () => {
    const mgr = resilience<AppState>({ roll: "in-flight" });
    let signalWasAbortedAtStart = true;
    await mgr.execute(async (_s, signal) => {
      signalWasAbortedAtStart = signal.aborted;
      return 1;
    }, makeState(1));
    expect(signalWasAbortedAtStart).toBe(false);
  });

  it("abort() returns null when no checkpoints exist", () => {
    const mgr = resilience<AppState>({ roll: "in-flight" });
    expect(mgr.abort()).toBeNull();
  });

  it("abort() returns latest checkpoint state when no operation is running", () => {
    const mgr = resilience<AppState>({ roll: "in-flight" });
    mgr.cp(makeState(55, ["saved"]));
    const state = mgr.abort();
    expect(state).toEqual(makeState(55, ["saved"]));
  });

  it("rolled-back state is a deep copy, not a reference to the checkpoint", async () => {
    const mgr = resilience<AppState>({ roll: "in-flight" });
    const initialState = makeState(10, ["item"]);

    const executePromise = mgr.execute(async (_s, signal) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      });
      return 0;
    }, initialState);

    await new Promise((r) => setTimeout(r, 5));
    mgr.abort();
    const result = await executePromise;

    // Mutating the rolled-back state should not affect the checkpoint
    (result.rolledBack as AppState).value = 9999;
    expect(mgr.latestCheckpoint?.state.value).toBe(10);
  });

  it("non-abort errors are marked as not aborted in-flight", async () => {
    const mgr = resilience<AppState>({ roll: "in-flight" });
    const result = await mgr.execute(async (_s, _signal) => {
      throw new Error("disk I/O error");
    }, makeState(1));
    expect(result.success).toBe(false);
    expect(result.abortedInFlight).toBe(false);
    expect(result.error?.message).toBe("disk I/O error");
    expect(result.rolledBack).toEqual(makeState(1));
  });

  it("isInflight is false after a failed in-flight operation", async () => {
    const mgr = resilience<AppState>({ roll: "in-flight" });
    await mgr.execute(async () => {
      throw new Error("fail");
    }, makeState(1));
    expect(mgr.isInflight).toBe(false);
  });

  it("sequential in-flight executions each get their own abort controller", async () => {
    const mgr = resilience<AppState>({ roll: "in-flight" });

    // First operation: succeeds
    const r1 = await mgr.execute(async (s, _signal) => s.value + 1, makeState(1));
    expect(r1.success).toBe(true);

    // Second operation: succeeds too (first abort controller is cleared)
    const r2 = await mgr.execute(async (s, _signal) => s.value + 10, makeState(5));
    expect(r2.success).toBe(true);
    expect(r2.result).toBe(15);
  });
});
