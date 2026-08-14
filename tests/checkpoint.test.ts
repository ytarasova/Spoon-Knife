import { describe, it, expect, beforeEach } from "bun:test";
import { CheckpointStore } from "../src/checkpoint";
import { InFlightTracker } from "../src/in-flight";

describe("CheckpointStore (without tracker)", () => {
  let store: CheckpointStore<{ count: number }>;

  beforeEach(() => {
    store = new CheckpointStore();
  });

  it("saves and retrieves a checkpoint", () => {
    const id = store.save({ count: 1 });
    const cp = store.get(id);
    expect(cp?.state).toEqual({ count: 1 });
  });

  it("snapshot is independent of subsequent mutations", () => {
    const state = { count: 5 };
    const id = store.save(state);
    state.count = 99;
    expect(store.get(id)?.state.count).toBe(5);
  });

  it("latest() returns the most recent checkpoint", () => {
    store.save({ count: 1 }, "first");
    store.save({ count: 2 }, "second");
    expect(store.latest()?.label).toBe("second");
    expect(store.latest()?.state.count).toBe(2);
  });

  describe("rollbackTo — after state", () => {
    it("restores state to checkpoint and discards later ones", () => {
      const id1 = store.save({ count: 10 }, "baseline");
      store.save({ count: 20 }, "mid");
      store.save({ count: 30 }, "latest");

      const restored = store.rollbackTo(id1);

      expect(restored).toEqual({ count: 10 });
      expect(store.all().length).toBe(1);
      expect(store.latest()?.label).toBe("baseline");
    });

    it("restored value is independent of further checkpoint mutations", () => {
      const id = store.save({ count: 42 });
      const restored = store.rollbackTo(id);
      restored.count = 0;
      expect(store.get(id)?.state.count).toBe(42);
    });

    it("throws when the checkpoint id does not exist", () => {
      expect(() => store.rollbackTo("nonexistent")).toThrow("Checkpoint nonexistent not found");
    });

    it("rollbackToLatest() after saving multiple checkpoints", () => {
      store.save({ count: 1 });
      store.save({ count: 2 });
      const id = store.save({ count: 3 }, "target");
      store.save({ count: 4 });

      const restored = store.rollbackTo(id);
      expect(restored.count).toBe(3);
      expect(store.all().length).toBe(3);
    });

    it("throws rollbackToLatest when store is empty", () => {
      expect(() => store.rollbackToLatest()).toThrow("No checkpoints available");
    });
  });
});

describe("CheckpointStore — in-flight snapshot", () => {
  it("checkpoint captures in-flight operations at save time", () => {
    const tracker = new InFlightTracker();
    const store = new CheckpointStore<{ v: number }>(tracker);

    const op1 = tracker.begin("write-A");
    const op2 = tracker.begin("write-B");

    const id = store.save({ v: 1 }, "with-ops");
    const cp = store.get(id);

    expect(cp?.inFlight).toBeDefined();
    const ids = cp!.inFlight!.operations.map((o) => o.id);
    expect(ids).toContain(op1);
    expect(ids).toContain(op2);
  });

  it("checkpoint captures empty in-flight when no ops are running", () => {
    const tracker = new InFlightTracker();
    const store = new CheckpointStore<{ v: number }>(tracker);

    const id = store.save({ v: 1 }, "no-ops");
    const cp = store.get(id);

    expect(cp?.inFlight?.operations).toHaveLength(0);
  });

  it("in-flight snapshot is frozen at save time — later ops don't appear in it", () => {
    const tracker = new InFlightTracker();
    const store = new CheckpointStore<{ v: number }>(tracker);

    const id = store.save({ v: 0 });
    tracker.begin("late-op"); // started AFTER the checkpoint

    const cp = store.get(id);
    expect(cp?.inFlight?.operations).toHaveLength(0);
  });

  it("rollbackTo cancels all in-flight operations via the tracker", () => {
    const tracker = new InFlightTracker();
    const store = new CheckpointStore<{ v: number }>(tracker);
    const cancelled: string[] = [];

    const op1 = tracker.begin("risky-write");
    tracker.onCancel(op1, () => cancelled.push(op1));

    const id = store.save({ v: 1 });
    store.rollbackTo(id);

    expect(cancelled).toContain(op1);
    expect(tracker.count()).toBe(0);
  });

  it("operations completed before rollback are not in the cancelled list", () => {
    const tracker = new InFlightTracker();
    const store = new CheckpointStore<{ v: number }>(tracker);
    const cancelled: string[] = [];

    const op1 = tracker.begin("safe-op");
    tracker.onCancel(op1, () => cancelled.push(op1));
    tracker.end(op1); // completes cleanly before any rollback

    const id = store.save({ v: 1 });
    store.rollbackTo(id);

    expect(cancelled).toHaveLength(0);
  });
});
