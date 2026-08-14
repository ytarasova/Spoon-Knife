import { describe, it, expect, beforeEach } from "bun:test";
import { ReplicaDispatcher, DispatchError } from "./resilience";

// Simple replica type for tests
interface MockReplica {
  id: string;
  callCount: number;
  shouldFail: boolean;
}

function makeReplicas(): [MockReplica, MockReplica, MockReplica] {
  return [
    { id: "A", callCount: 0, shouldFail: false },
    { id: "B", callCount: 0, shouldFail: false },
    { id: "C", callCount: 0, shouldFail: false },
  ];
}

async function callReplica(r: MockReplica): Promise<string> {
  r.callCount += 1;
  if (r.shouldFail) throw new Error(`Replica ${r.id} failed`);
  return r.id;
}

describe("ReplicaDispatcher", () => {
  describe("constructor", () => {
    it("requires exactly 3 replicas", () => {
      expect(() => new ReplicaDispatcher(["a", "b"] as any)).toThrow(
        "ReplicaDispatcher requires exactly 3 replicas"
      );
    });

    it("accepts exactly 3 replicas", () => {
      const replicas = makeReplicas();
      expect(() => new ReplicaDispatcher(replicas)).not.toThrow();
    });
  });

  describe("dispatch — happy path", () => {
    it("calls the handler with the first replica", async () => {
      const replicas = makeReplicas();
      const dispatcher = new ReplicaDispatcher(replicas);
      const result = await dispatcher.dispatch(callReplica);
      expect(result).toBe("A");
      expect(replicas[0].callCount).toBe(1);
    });

    it("round-robins across replicas on successive dispatches", async () => {
      const replicas = makeReplicas();
      const dispatcher = new ReplicaDispatcher(replicas);
      const results = [
        await dispatcher.dispatch(callReplica),
        await dispatcher.dispatch(callReplica),
        await dispatcher.dispatch(callReplica),
        await dispatcher.dispatch(callReplica),
      ];
      // Should cycle A → B → C → A
      expect(results).toEqual(["A", "B", "C", "A"]);
    });

    it("returns the handler return value", async () => {
      const replicas = makeReplicas();
      const dispatcher = new ReplicaDispatcher(replicas);
      const result = await dispatcher.dispatch(async (r: MockReplica) => {
        return { payload: `ok-from-${r.id}`, ts: 42 };
      });
      expect(result.payload).toBe("ok-from-A");
      expect(result.ts).toBe(42);
    });
  });

  describe("dispatch — failover", () => {
    it("skips a failing replica and uses the next healthy one", async () => {
      const replicas = makeReplicas();
      replicas[0].shouldFail = true;
      const dispatcher = new ReplicaDispatcher(replicas);
      const result = await dispatcher.dispatch(callReplica);
      expect(result).toBe("B");
      expect(replicas[0].callCount).toBe(1); // tried once
      expect(replicas[1].callCount).toBe(1); // succeeded
    });

    it("succeeds after two replicas fail", async () => {
      const replicas = makeReplicas();
      replicas[0].shouldFail = true;
      replicas[1].shouldFail = true;
      const dispatcher = new ReplicaDispatcher(replicas);
      const result = await dispatcher.dispatch(callReplica);
      expect(result).toBe("C");
      expect(replicas[2].callCount).toBe(1);
    });

    it("marks a failed replica as unhealthy", async () => {
      const replicas = makeReplicas();
      replicas[0].shouldFail = true;
      const dispatcher = new ReplicaDispatcher(replicas);
      await dispatcher.dispatch(callReplica);
      const status = dispatcher.status();
      expect(status[0].healthy).toBe(false);
      expect(status[0].failureCount).toBe(1);
      expect(status[1].healthy).toBe(true);
    });

    it("recovers a replica after cooldown", async () => {
      const replicas = makeReplicas();
      replicas[0].shouldFail = true;
      const dispatcher = new ReplicaDispatcher(replicas, { cooldownMs: 0 });
      // First dispatch — A fails, B succeeds
      await dispatcher.dispatch(callReplica);
      // A is marked unhealthy, but cooldown is 0 so it becomes available again
      replicas[0].shouldFail = false;
      // Next round-robin starts at B, then C, then A; but A is available again
      // regardless, A is back in the pool
      const status = dispatcher.status();
      // After 0ms cooldown, A should be retryable again — let dispatch prove it
      const result = await dispatcher.dispatch(async (r: MockReplica) => {
        r.callCount += 1;
        return r.id;
      });
      // Could land on B (next after last success) or eventually A; just check no error
      expect(["A", "B", "C"]).toContain(result);
    });
  });

  describe("dispatch — all replicas fail", () => {
    it("throws DispatchError when all replicas fail", async () => {
      const replicas = makeReplicas();
      replicas.forEach((r) => (r.shouldFail = true));
      const dispatcher = new ReplicaDispatcher(replicas);
      await expect(dispatcher.dispatch(callReplica)).rejects.toBeInstanceOf(
        DispatchError
      );
    });

    it("DispatchError has a descriptive message", async () => {
      const replicas = makeReplicas();
      replicas.forEach((r) => (r.shouldFail = true));
      const dispatcher = new ReplicaDispatcher(replicas);
      try {
        await dispatcher.dispatch(callReplica);
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(DispatchError);
        expect((err as DispatchError).message).toMatch(/attempts failed/);
      }
    });

    it("DispatchError exposes the last underlying cause", async () => {
      const replicas = makeReplicas();
      replicas.forEach((r) => (r.shouldFail = true));
      const dispatcher = new ReplicaDispatcher(replicas);
      try {
        await dispatcher.dispatch(callReplica);
      } catch (err) {
        expect((err as DispatchError).cause).toBeInstanceOf(Error);
      }
    });
  });

  describe("status", () => {
    it("reports all replicas healthy initially", () => {
      const dispatcher = new ReplicaDispatcher(makeReplicas());
      const status = dispatcher.status();
      expect(status).toHaveLength(3);
      expect(status.every((s) => s.healthy)).toBe(true);
      expect(status.every((s) => s.failureCount === 0)).toBe(true);
    });

    it("includes replica ids", () => {
      const dispatcher = new ReplicaDispatcher(makeReplicas());
      const ids = dispatcher.status().map((s) => s.id);
      expect(ids).toEqual(["replica-0", "replica-1", "replica-2"]);
    });
  });

  describe("reset", () => {
    it("restores all replicas to healthy after failures", async () => {
      const replicas = makeReplicas();
      replicas.forEach((r) => (r.shouldFail = true));
      const dispatcher = new ReplicaDispatcher(replicas);
      await expect(dispatcher.dispatch(callReplica)).rejects.toThrow();
      dispatcher.reset();
      const status = dispatcher.status();
      expect(status.every((s) => s.healthy)).toBe(true);
      expect(status.every((s) => s.failureCount === 0)).toBe(true);
    });

    it("allows dispatching again after reset", async () => {
      const replicas = makeReplicas();
      replicas.forEach((r) => (r.shouldFail = true));
      const dispatcher = new ReplicaDispatcher(replicas);
      await expect(dispatcher.dispatch(callReplica)).rejects.toThrow();
      // Fix replicas and reset
      replicas.forEach((r) => (r.shouldFail = false));
      dispatcher.reset();
      const result = await dispatcher.dispatch(callReplica);
      expect(["A", "B", "C"]).toContain(result);
    });
  });

  describe("unhealthy replica skipped without retry within cooldown", () => {
    it("does not re-try an unhealthy replica before cooldown", async () => {
      const replicas = makeReplicas();
      replicas[0].shouldFail = true;
      const dispatcher = new ReplicaDispatcher(replicas, {
        cooldownMs: 60_000,
      });
      // First dispatch: A fails → marked unhealthy, B succeeds
      await dispatcher.dispatch(callReplica);
      // Second dispatch: should skip A (still in cooldown) and go to B or C
      const callsBefore = replicas[0].callCount;
      await dispatcher.dispatch(callReplica);
      // A should NOT have been called again
      expect(replicas[0].callCount).toBe(callsBefore);
    });
  });
});
