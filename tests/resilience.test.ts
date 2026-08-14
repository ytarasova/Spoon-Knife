import { describe, it, expect } from "bun:test";
import { CheckpointStore } from "../src/checkpoint";
import { InFlightTracker } from "../src/in-flight";
import { withCheckpointedRetry, withInFlightCheckpointedRetry } from "../src/resilience";

interface AppState {
  balance: number;
  transactions: string[];
}

function makeState(): AppState {
  return { balance: 100, transactions: [] };
}

describe("withCheckpointedRetry — after-rollback state", () => {
  it("succeeds on first attempt with no rollback", async () => {
    const store = new CheckpointStore<AppState>();
    let state = makeState();

    const result = await withCheckpointedRetry(
      store,
      () => state,
      (s) => { state = s; },
      async () => {
        state.balance -= 30;
        state.transactions.push("debit-30");
        return state.balance;
      },
      { maxAttempts: 3 }
    );

    expect(result.value).toBe(70);
    expect(result.attempts).toBe(1);
    expect(result.rolledBack).toBe(false);
    expect(state.balance).toBe(70);
    expect(state.transactions).toEqual(["debit-30"]);
  });

  it("rolls back after one failure then succeeds — verifies after state", async () => {
    const store = new CheckpointStore<AppState>();
    let state = makeState();
    let callCount = 0;

    const result = await withCheckpointedRetry(
      store,
      () => state,
      (s) => { state = s; },
      async () => {
        callCount++;
        if (callCount === 1) {
          state.balance -= 50;
          state.transactions.push("partial-debit");
          throw new Error("transient failure");
        }
        state.balance -= 10;
        state.transactions.push("debit-10");
        return state.balance;
      },
      { maxAttempts: 3 }
    );

    expect(result.value).toBe(90);
    expect(result.attempts).toBe(2);
    expect(result.rolledBack).toBe(true);
    expect(state.balance).toBe(90);
    expect(state.transactions).toEqual(["debit-10"]);
  });

  it("throws after exhausting all attempts; state is rolled back to pre-last-attempt", async () => {
    const store = new CheckpointStore<AppState>();
    let state = makeState();

    await expect(
      withCheckpointedRetry(
        store,
        () => state,
        (s) => { state = s; },
        async () => {
          state.balance -= 999;
          state.transactions.push("bad-op");
          throw new Error("always fails");
        },
        { maxAttempts: 2 }
      )
    ).rejects.toThrow("Operation failed after 2 attempt(s)");

    expect(state.balance).toBe(100);
    expect(state.transactions).toEqual([]);
  });

  it("checkpoint history after multiple retries reflects only committed checkpoints", async () => {
    const store = new CheckpointStore<AppState>();
    let state = makeState();
    let call = 0;

    await withCheckpointedRetry(
      store,
      () => state,
      (s) => { state = s; },
      async () => {
        call++;
        if (call < 3) throw new Error("not yet");
        state.transactions.push("ok");
        return "done";
      },
      { maxAttempts: 5 }
    );

    expect(store.all().length).toBe(3);
    expect(state.transactions).toEqual(["ok"]);
  });
});

describe("withInFlightCheckpointedRetry — in-flight state during checkpoint roll", () => {
  it("succeeds on first attempt; no ops cancelled", async () => {
    const tracker = new InFlightTracker();
    const store = new CheckpointStore<AppState>(tracker);
    let state = makeState();

    const result = await withInFlightCheckpointedRetry(
      store,
      tracker,
      () => state,
      (s) => { state = s; },
      async (t) => {
        const opId = t.begin("debit-op");
        state.balance -= 20;
        state.transactions.push("debit-20");
        t.end(opId);
        return state.balance;
      },
      { maxAttempts: 3 }
    );

    expect(result.value).toBe(80);
    expect(result.rolledBack).toBe(false);
    expect(result.cancelledOps).toHaveLength(0);
  });

  it("cancels in-flight ops captured at checkpoint time when a failure triggers rollback", async () => {
    const tracker = new InFlightTracker();
    const store = new CheckpointStore<AppState>(tracker);
    let state = makeState();
    const cancelLog: string[] = [];
    let call = 0;

    await withInFlightCheckpointedRetry(
      store,
      tracker,
      () => state,
      (s) => { state = s; },
      async (t) => {
        call++;
        const opId = t.begin(`write-attempt-${call}`);
        t.onCancel(opId, () => cancelLog.push(opId));

        if (call === 1) {
          state.balance -= 50;
          state.transactions.push("partial");
          // op is still in-flight when failure occurs — rollback should cancel it
          throw new Error("transient");
        }

        state.balance -= 15;
        state.transactions.push("debit-15");
        t.end(opId); // clean completion on retry
        return state.balance;
      },
      { maxAttempts: 3 }
    );

    // The in-flight op from attempt 1 was cancelled during rollback
    expect(cancelLog).toHaveLength(1);
    expect(cancelLog[0]).toBe("op-1");
    // State reflects only the successful retry
    expect(state.balance).toBe(85);
    expect(state.transactions).toEqual(["debit-15"]);
  });

  it("checkpoint inFlight snapshot reflects ops running at save time", async () => {
    const tracker = new InFlightTracker();
    const store = new CheckpointStore<AppState>(tracker);
    let state = makeState();

    // Start a background op before the checkpoint is taken
    const bgOp = tracker.begin("background-sync");

    const result = await withInFlightCheckpointedRetry(
      store,
      tracker,
      () => state,
      (s) => { state = s; },
      async (t) => {
        // bgOp is still running; it should appear in the checkpoint inFlight snapshot
        state.transactions.push("main-op");
        t.end(bgOp); // finishes during operation
        return "ok";
      },
      { maxAttempts: 1 }
    );

    expect(result.value).toBe("ok");
    // The first (and only) checkpoint should have captured bgOp as in-flight
    const cp = store.get(result.checkpointId!);
    const inFlightIds = cp?.inFlight?.operations.map((o) => o.id) ?? [];
    expect(inFlightIds).toContain(bgOp);
  });

  it("all in-flight ops are cancelled when all attempts are exhausted", async () => {
    const tracker = new InFlightTracker();
    const store = new CheckpointStore<AppState>(tracker);
    let state = makeState();
    const cancelLog: string[] = [];

    await expect(
      withInFlightCheckpointedRetry(
        store,
        tracker,
        () => state,
        (s) => { state = s; },
        async (t) => {
          const opId = t.begin("failing-write");
          t.onCancel(opId, () => cancelLog.push(opId));
          state.balance -= 999;
          throw new Error("always fails");
        },
        { maxAttempts: 2 }
      )
    ).rejects.toThrow("Operation failed after 2 attempt(s)");

    // Both attempts had their in-flight ops cancelled on rollback
    expect(cancelLog.length).toBe(2);
    // State is rolled back to baseline
    expect(state.balance).toBe(100);
    expect(state.transactions).toEqual([]);
  });

  it("in-flight ops started and ended cleanly within an attempt are not cancelled on retry", async () => {
    const tracker = new InFlightTracker();
    const store = new CheckpointStore<AppState>(tracker);
    let state = makeState();
    const cancelLog: string[] = [];
    let call = 0;

    await withInFlightCheckpointedRetry(
      store,
      tracker,
      () => state,
      (s) => { state = s; },
      async (t) => {
        call++;
        // Start and immediately complete an op
        const opId = t.begin("quick-read");
        t.onCancel(opId, () => cancelLog.push(opId));
        t.end(opId); // completes before throw

        if (call === 1) throw new Error("first attempt fails");
        state.transactions.push("ok");
        return "done";
      },
      { maxAttempts: 2 }
    );

    // quick-read completed before any rollback — should not be cancelled
    expect(cancelLog).toHaveLength(0);
    expect(state.transactions).toEqual(["ok"]);
  });
});
