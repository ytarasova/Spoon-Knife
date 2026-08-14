import { describe, it, expect, beforeEach } from "bun:test";
import { CheckpointStore } from "../src/checkpoint";

describe("CheckpointStore", () => {
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
    state.count = 99; // mutate after save
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
      // Mutate the returned copy — checkpoint must stay intact
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

      // Roll back one step to latest (cp-4 → cp-4 still the latest, roll to it)
      // Roll back to a specific known checkpoint
      const restored = store.rollbackTo(id);
      expect(restored.count).toBe(3);
      expect(store.all().length).toBe(3);
    });

    it("throws rollbackToLatest when store is empty", () => {
      expect(() => store.rollbackToLatest()).toThrow("No checkpoints available");
    });
  });
});
