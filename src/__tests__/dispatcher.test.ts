import { describe, expect, it } from "bun:test";
import { ReplicaDispatcher } from "../dispatcher.js";
import { AllReplicasFailedError, DispatchTimeoutError, ReplicaCountError } from "../errors.js";
import type { Replica } from "../types.js";

function makeReplica<TRes>(
  id: string,
  behavior: () => Promise<TRes>,
): Replica<string, TRes> {
  return { id, call: behavior };
}

function successReplica(id: string, value: string, delayMs = 0): Replica<string, string> {
  return makeReplica(id, () =>
    delayMs > 0
      ? new Promise((resolve) => setTimeout(() => resolve(value), delayMs))
      : Promise.resolve(value),
  );
}

function failReplica(id: string, message = "error", delayMs = 0): Replica<string, string> {
  return makeReplica(id, () =>
    delayMs > 0
      ? new Promise((_, reject) => setTimeout(() => reject(new Error(message)), delayMs))
      : Promise.reject(new Error(message)),
  );
}

function hangingReplica(id: string): Replica<string, string> {
  return makeReplica(id, () => new Promise(() => {}));
}

describe("ReplicaDispatcher constructor", () => {
  it("throws when given fewer than 3 replicas", () => {
    const replicas = [successReplica("r1", "a"), successReplica("r2", "b")];
    expect(() => new ReplicaDispatcher(replicas)).toThrow(ReplicaCountError);
    expect(() => new ReplicaDispatcher(replicas)).toThrow(
      "Dispatcher requires exactly 3 replicas, got 2",
    );
  });

  it("throws when given more than 3 replicas", () => {
    const replicas = [
      successReplica("r1", "a"),
      successReplica("r2", "b"),
      successReplica("r3", "c"),
      successReplica("r4", "d"),
    ];
    expect(() => new ReplicaDispatcher(replicas)).toThrow(ReplicaCountError);
  });

  it("accepts exactly 3 replicas", () => {
    const replicas = [
      successReplica("r1", "a"),
      successReplica("r2", "b"),
      successReplica("r3", "c"),
    ];
    expect(() => new ReplicaDispatcher(replicas)).not.toThrow();
  });
});

describe("first-success strategy", () => {
  it("returns the first successful response when all replicas succeed", async () => {
    const replicas = [
      successReplica("r1", "from-r1"),
      successReplica("r2", "from-r2"),
      successReplica("r3", "from-r3"),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    const result = await dispatcher.dispatch("req");
    expect(result.response).toBe("from-r1");
    expect(result.replicaId).toBe("r1");
  });

  it("returns response from fastest replica when replicas have different latencies", async () => {
    const replicas = [
      successReplica("r1", "slow", 100),
      successReplica("r2", "fast", 10),
      successReplica("r3", "medium", 50),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    const result = await dispatcher.dispatch("req");
    expect(result.response).toBe("fast");
    expect(result.replicaId).toBe("r2");
  });

  it("falls back to next replica when primary fails", async () => {
    const replicas = [
      failReplica("r1", "r1-down"),
      successReplica("r2", "from-r2"),
      successReplica("r3", "from-r3"),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    const result = await dispatcher.dispatch("req");
    expect(result.response).toBe("from-r2");
  });

  it("succeeds when only the last replica is healthy", async () => {
    const replicas = [
      failReplica("r1", "down"),
      failReplica("r2", "down"),
      successReplica("r3", "from-r3"),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    const result = await dispatcher.dispatch("req");
    expect(result.response).toBe("from-r3");
    expect(result.replicaId).toBe("r3");
  });

  it("throws AllReplicasFailedError when all replicas fail", async () => {
    const replicas = [
      failReplica("r1", "err-1"),
      failReplica("r2", "err-2"),
      failReplica("r3", "err-3"),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    const error = await dispatcher.dispatch("req").catch((e) => e);
    expect(error).toBeInstanceOf(AllReplicasFailedError);
    expect((error as AllReplicasFailedError).errors).toHaveLength(3);
  });

  it("includes all replica errors in AllReplicasFailedError", async () => {
    const replicas = [
      failReplica("r1", "err-one"),
      failReplica("r2", "err-two"),
      failReplica("r3", "err-three"),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    try {
      await dispatcher.dispatch("req");
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(AllReplicasFailedError);
      const failed = e as AllReplicasFailedError;
      const ids = failed.errors.map((f) => f.replicaId);
      expect(ids).toContain("r1");
      expect(ids).toContain("r2");
      expect(ids).toContain("r3");
    }
  });

  it("times out slow replicas and uses a faster one", async () => {
    const replicas = [
      hangingReplica("r1"),
      hangingReplica("r2"),
      successReplica("r3", "from-r3", 50),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    const result = await dispatcher.dispatch("req", { timeoutMs: 200 });
    expect(result.response).toBe("from-r3");
    expect(result.replicaId).toBe("r3");
  });

  it("throws DispatchTimeoutError when all replicas hang", async () => {
    const replicas = [hangingReplica("r1"), hangingReplica("r2"), hangingReplica("r3")];
    const dispatcher = new ReplicaDispatcher(replicas);
    const error = await dispatcher.dispatch("req", { timeoutMs: 50 }).catch((e) => e);
    expect(error).toBeInstanceOf(AllReplicasFailedError);
    const failed = error as AllReplicasFailedError;
    expect(failed.errors.every((e) => e.error instanceof DispatchTimeoutError)).toBe(true);
  });

  it("tracks attempted replicas in result", async () => {
    const replicas = [
      successReplica("r1", "val", 10),
      successReplica("r2", "val", 20),
      successReplica("r3", "val", 30),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    const result = await dispatcher.dispatch("req");
    expect(result.attemptedReplicas).toContain("r1");
    expect(result.attemptedReplicas).toContain("r2");
    expect(result.attemptedReplicas).toContain("r3");
  });
});

describe("primary-failover strategy", () => {
  it("returns primary response when primary succeeds", async () => {
    const replicas = [
      successReplica("r1", "primary"),
      successReplica("r2", "secondary"),
      successReplica("r3", "tertiary"),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    const result = await dispatcher.dispatch("req", { strategy: "primary-failover" });
    expect(result.response).toBe("primary");
    expect(result.replicaId).toBe("r1");
    expect(result.attemptedReplicas).toEqual(["r1"]);
  });

  it("fails over to secondary when primary fails", async () => {
    const replicas = [
      failReplica("r1", "down"),
      successReplica("r2", "secondary"),
      successReplica("r3", "tertiary"),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    const result = await dispatcher.dispatch("req", { strategy: "primary-failover" });
    expect(result.response).toBe("secondary");
    expect(result.replicaId).toBe("r2");
    expect(result.attemptedReplicas).toEqual(["r1", "r2"]);
  });

  it("fails over to tertiary when primary and secondary fail", async () => {
    const replicas = [
      failReplica("r1", "down"),
      failReplica("r2", "down"),
      successReplica("r3", "tertiary"),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    const result = await dispatcher.dispatch("req", { strategy: "primary-failover" });
    expect(result.response).toBe("tertiary");
    expect(result.replicaId).toBe("r3");
    expect(result.attemptedReplicas).toEqual(["r1", "r2", "r3"]);
  });

  it("throws when all replicas fail in failover mode", async () => {
    const replicas = [failReplica("r1"), failReplica("r2"), failReplica("r3")];
    const dispatcher = new ReplicaDispatcher(replicas);
    const error = await dispatcher
      .dispatch("req", { strategy: "primary-failover" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(AllReplicasFailedError);
  });

  it("handles timeout in failover mode", async () => {
    const replicas = [
      hangingReplica("r1"),
      failReplica("r2", "secondary-down"),
      successReplica("r3", "tertiary"),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    const result = await dispatcher.dispatch("req", {
      strategy: "primary-failover",
      timeoutMs: 100,
    });
    expect(result.response).toBe("tertiary");
    expect(result.replicaId).toBe("r3");
  });
});

describe("health tracking", () => {
  it("initializes all replicas as healthy", () => {
    const replicas = [
      successReplica("r1", "a"),
      successReplica("r2", "b"),
      successReplica("r3", "c"),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    const health = dispatcher.getHealth();
    expect(health).toHaveLength(3);
    expect(health.every((h) => h.status === "healthy")).toBe(true);
    expect(health.every((h) => h.consecutiveFailures === 0)).toBe(true);
  });

  it("records successful calls", async () => {
    const replicas = [
      successReplica("r1", "a"),
      successReplica("r2", "b"),
      successReplica("r3", "c"),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    await dispatcher.dispatch("req");
    const r1Health = dispatcher.getHealthById("r1");
    expect(r1Health?.lastSuccess).not.toBeNull();
    expect(r1Health?.status).toBe("healthy");
  });

  it("marks replica as degraded after 1-2 consecutive failures", async () => {
    const replicas = [
      failReplica("r1"),
      successReplica("r2", "b"),
      successReplica("r3", "c"),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    await dispatcher.dispatch("req").catch(() => {});
    const r1Health = dispatcher.getHealthById("r1");
    expect(r1Health?.status).toBe("degraded");
    expect(r1Health?.consecutiveFailures).toBe(1);
  });

  it("marks replica as down after 3 consecutive failures", async () => {
    const replicas = [
      failReplica("r1"),
      failReplica("r2"),
      failReplica("r3"),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    // Each dispatch fails all 3 replicas
    await dispatcher.dispatch("req").catch(() => {});
    await dispatcher.dispatch("req").catch(() => {});
    await dispatcher.dispatch("req").catch(() => {});

    const r1Health = dispatcher.getHealthById("r1");
    expect(r1Health?.status).toBe("down");
    expect(r1Health?.consecutiveFailures).toBeGreaterThanOrEqual(3);
  });

  it("resets consecutive failures on success", async () => {
    let failCount = 0;
    const r1 = makeReplica<string>("r1", () => {
      failCount++;
      if (failCount < 3) return Promise.reject(new Error("down"));
      return Promise.resolve("recovered");
    });
    const replicas = [r1, successReplica("r2", "b"), successReplica("r3", "c")];
    const dispatcher = new ReplicaDispatcher(replicas);

    await dispatcher.dispatch("req").catch(() => {});
    await dispatcher.dispatch("req").catch(() => {});
    await dispatcher.dispatch("req");

    const r1Health = dispatcher.getHealthById("r1");
    expect(r1Health?.consecutiveFailures).toBe(0);
    expect(r1Health?.status).toBe("healthy");
  });

  it("getHealthById returns undefined for unknown replica", () => {
    const replicas = [
      successReplica("r1", "a"),
      successReplica("r2", "b"),
      successReplica("r3", "c"),
    ];
    const dispatcher = new ReplicaDispatcher(replicas);
    expect(dispatcher.getHealthById("unknown")).toBeUndefined();
  });
});

describe("error types", () => {
  it("AllReplicasFailedError has correct name", () => {
    const err = new AllReplicasFailedError([]);
    expect(err.name).toBe("AllReplicasFailedError");
  });

  it("DispatchTimeoutError has correct name and properties", () => {
    const err = new DispatchTimeoutError("r1", 1000);
    expect(err.name).toBe("DispatchTimeoutError");
    expect(err.replicaId).toBe("r1");
    expect(err.timeoutMs).toBe(1000);
    expect(err.message).toContain("r1");
    expect(err.message).toContain("1000");
  });

  it("ReplicaCountError has correct name", () => {
    const err = new ReplicaCountError(5);
    expect(err.name).toBe("ReplicaCountError");
    expect(err.message).toContain("5");
  });
});
