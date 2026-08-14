import { describe, it, expect } from "bun:test";
import { CheckpointStore } from "../src/checkpoint";
import { withCheckpointedRetry } from "../src/resilience";

interface AppState {
  balance: number;
  transactions: string[];
}

function makeState(): AppState {
  return { balance: 100, transactions: [] };
}

describe("withCheckpointedRetry — roll: after", () => {
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

  it("checkpointId in result points to the saved checkpoint before the successful attempt", async () => {
    const store = new CheckpointStore<AppState>();
    let state = makeState();

    const result = await withCheckpointedRetry(
      store,
      () => state,
      (s) => { state = s; },
      async () => "ok",
      { maxAttempts: 1 }
    );

    expect(result.checkpointId).toBeDefined();
    expect(store.get(result.checkpointId!)).toBeDefined();
  });
});
