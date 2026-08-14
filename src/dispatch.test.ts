import { describe, it, expect, beforeEach } from "bun:test";
import {
  ReplicaDispatcher,
  AllReplicasFailedError,
  createDispatcher,
  type ReplicaHandler,
} from "./dispatch";

function makeDispatcher(
  failureThreshold = 3,
  cooldownMs = 10_000
): ReplicaDispatcher<string> {
  return new ReplicaDispatcher([
    { id: "r0", failureThreshold, cooldownMs },
    { id: "r1", failureThreshold, cooldownMs },
    { id: "r2", failureThreshold, cooldownMs },
  ]);
}

/** Handler that always returns the replica id as the result. */
const echoId: ReplicaHandler<string> = (id) => Promise.resolve(id);

/** Handler that always fails. */
const alwaysFail: ReplicaHandler<string> = (_id) =>
  Promise.reject(new Error("replica error"));

describe("ReplicaDispatcher — successful dispatch", () => {
  let dispatcher: ReplicaDispatcher<string>;

  beforeEach(() => {
    dispatcher = makeDispatcher();
  });

  it("returns a result when all replicas succeed", async () => {
    const result = await dispatcher.dispatch(echoId);
    expect(["r0", "r1", "r2"]).toContain(result.replicaId);
    expect(result.value).toBe(result.replicaId);
  });

  it("includes latencyMs and failures map on success", async () => {
    const result = await dispatcher.dispatch(echoId);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.failures).toEqual({});
  });

  it("returns the value produced by the handler", async () => {
    const result = await dispatcher.dispatch((_id) =>
      Promise.resolve("hello")
    );
    expect(result.value).toBe("hello");
  });

  it("accepts promises that resolve after a short delay", async () => {
    const slow: ReplicaHandler<number> = (_id) =>
      new Promise((res) => setTimeout(() => res(42), 10));
    const d = new ReplicaDispatcher<number>([
      { id: "r0" },
      { id: "r1" },
      { id: "r2" },
    ]);
    const result = await d.dispatch(slow);
    expect(result.value).toBe(42);
  });
});

describe("ReplicaDispatcher — race (fastest replica wins)", () => {
  it("resolves with the fastest replica when speeds differ", async () => {
    const delays: Record<string, number> = { r0: 50, r1: 5, r2: 30 };
    const dispatcher = makeDispatcher();
    const timed: ReplicaHandler<string> = (id) =>
      new Promise((res) => setTimeout(() => res(id), delays[id] ?? 0));

    const result = await dispatcher.dispatch(timed);
    expect(result.replicaId).toBe("r1");
    expect(result.value).toBe("r1");
  });
});

describe("ReplicaDispatcher — partial failures", () => {
  it("succeeds when one replica fails and two succeed", async () => {
    const dispatcher = makeDispatcher();
    const handler: ReplicaHandler<string> = (id) =>
      id === "r0"
        ? Promise.reject(new Error("r0 down"))
        : Promise.resolve(id);

    const result = await dispatcher.dispatch(handler);
    expect(["r1", "r2"]).toContain(result.replicaId);
    expect(result.failures).toHaveProperty("r0");
  });

  it("succeeds when two replicas fail and one succeeds", async () => {
    const dispatcher = makeDispatcher();
    const handler: ReplicaHandler<string> = (id) =>
      id === "r2"
        ? Promise.resolve("survivor")
        : Promise.reject(new Error("down"));

    const result = await dispatcher.dispatch(handler);
    expect(result.value).toBe("survivor");
    expect(result.replicaId).toBe("r2");
    expect(Object.keys(result.failures).length).toBe(2);
  });
});

describe("ReplicaDispatcher — all replicas fail", () => {
  it("throws AllReplicasFailedError when every replica fails", async () => {
    const dispatcher = makeDispatcher();
    await expect(dispatcher.dispatch(alwaysFail)).rejects.toBeInstanceOf(
      AllReplicasFailedError
    );
  });

  it("AllReplicasFailedError.errors contains an entry per replica", async () => {
    const dispatcher = makeDispatcher();
    try {
      await dispatcher.dispatch(alwaysFail);
    } catch (err) {
      expect(err).toBeInstanceOf(AllReplicasFailedError);
      const { errors } = err as AllReplicasFailedError;
      expect(Object.keys(errors)).toEqual(expect.arrayContaining(["r0", "r1", "r2"]));
    }
  });

  it("AllReplicasFailedError has a descriptive message", async () => {
    const dispatcher = makeDispatcher();
    try {
      await dispatcher.dispatch(alwaysFail);
    } catch (err) {
      expect((err as Error).message).toMatch(/All replicas failed/);
    }
  });
});

describe("ReplicaDispatcher — circuit breaker", () => {
  it("status() reports healthy initially for all replicas", () => {
    const dispatcher = makeDispatcher();
    const statuses = dispatcher.status();
    expect(statuses).toHaveLength(3);
    for (const s of statuses) {
      expect(s.status).toBe("healthy");
      expect(s.failureCount).toBe(0);
    }
  });

  it("increments failureCount and degrades replica on failure", async () => {
    const dispatcher = makeDispatcher(3);
    const handler: ReplicaHandler<string> = (id) =>
      id === "r0"
        ? Promise.reject(new Error("bad"))
        : Promise.resolve(id);

    await dispatcher.dispatch(handler);
    await dispatcher.dispatch(handler);

    const r0 = dispatcher.status().find((s) => s.id === "r0")!;
    expect(r0.failureCount).toBe(2);
    expect(r0.status).toBe("degraded");
  });

  it("opens circuit after reaching failureThreshold", async () => {
    const dispatcher = makeDispatcher(2);
    const handler: ReplicaHandler<string> = (id) =>
      id === "r0"
        ? Promise.reject(new Error("bad"))
        : Promise.resolve(id);

    await dispatcher.dispatch(handler);
    await dispatcher.dispatch(handler);

    const r0 = dispatcher.status().find((s) => s.id === "r0")!;
    expect(r0.status).toBe("open");
  });

  it("skips open-circuit replicas during dispatch", async () => {
    const dispatcher = makeDispatcher(1);
    const visited: string[] = [];

    const handler: ReplicaHandler<string> = (id) => {
      if (id === "r0") return Promise.reject(new Error("bad"));
      visited.push(id);
      return Promise.resolve(id);
    };

    // Open r0's circuit
    await dispatcher.dispatch(handler);
    visited.length = 0;

    // Next dispatch should not try r0
    await dispatcher.dispatch(handler);
    expect(visited).not.toContain("r0");
  });

  it("transitions open circuit to degraded after cooldown", async () => {
    const dispatcher = makeDispatcher(1, 50);
    const handler: ReplicaHandler<string> = (id) =>
      id !== "r2"
        ? Promise.reject(new Error("bad"))
        : Promise.resolve("ok");

    // Open r0 and r1
    await dispatcher.dispatch(handler);
    await dispatcher.dispatch(handler);

    const before = dispatcher.status().find((s) => s.id === "r0")!;
    expect(before.status).toBe("open");

    // Wait for cooldown
    await new Promise((res) => setTimeout(res, 60));

    const after = dispatcher.status().find((s) => s.id === "r0")!;
    expect(after.status).toBe("degraded");
  });

  it("throws AllReplicasFailedError when all circuits are open", async () => {
    const dispatcher = makeDispatcher(1, 100_000);
    // Open all circuits
    try { await dispatcher.dispatch(alwaysFail); } catch {}

    await expect(
      dispatcher.dispatch((_id) => Promise.resolve("ok"))
    ).rejects.toBeInstanceOf(AllReplicasFailedError);
  });

  it("reset() clears circuit state for all replicas", async () => {
    const dispatcher = makeDispatcher(1);
    try { await dispatcher.dispatch(alwaysFail); } catch {}

    dispatcher.reset();
    const statuses = dispatcher.status();
    for (const s of statuses) {
      expect(s.status).toBe("healthy");
      expect(s.failureCount).toBe(0);
    }
  });

  it("restores success path after reset", async () => {
    const dispatcher = makeDispatcher(1);
    try { await dispatcher.dispatch(alwaysFail); } catch {}

    dispatcher.reset();
    const result = await dispatcher.dispatch(echoId);
    expect(result.value).toBeDefined();
  });

  it("resets failureCount to zero on successful dispatch", async () => {
    const dispatcher = makeDispatcher(5);
    const failOnce: ReplicaHandler<string> = (() => {
      let calls = 0;
      return (id: string) => {
        if (id === "r0" && calls++ < 2) return Promise.reject(new Error("transient"));
        return Promise.resolve(id);
      };
    })();

    await dispatcher.dispatch(failOnce);
    await dispatcher.dispatch(failOnce);
    // r0 succeeds now
    await dispatcher.dispatch(failOnce);

    const r0 = dispatcher.status().find((s) => s.id === "r0")!;
    expect(r0.failureCount).toBe(0);
    expect(r0.status).toBe("healthy");
  });
});

describe("createDispatcher factory", () => {
  it("creates a dispatcher with 3 replicas named replica-0/1/2", async () => {
    const d = createDispatcher<string>();
    const result = await d.dispatch(echoId);
    expect(["replica-0", "replica-1", "replica-2"]).toContain(result.replicaId);
  });

  it("respects custom failureThreshold option", async () => {
    const d = createDispatcher<string>({ failureThreshold: 1, cooldownMs: 100_000 });
    const handler: ReplicaHandler<string> = (id) =>
      id === "replica-0"
        ? Promise.reject(new Error("bad"))
        : Promise.resolve(id);

    await d.dispatch(handler); // opens replica-0 after 1 failure
    const s = d.status().find((s) => s.id === "replica-0")!;
    expect(s.status).toBe("open");
  });
});

describe("AllReplicasFailedError", () => {
  it("name is AllReplicasFailedError", () => {
    const err = new AllReplicasFailedError({ r0: new Error("x") });
    expect(err.name).toBe("AllReplicasFailedError");
  });

  it("is an instance of Error", () => {
    const err = new AllReplicasFailedError({});
    expect(err).toBeInstanceOf(Error);
  });

  it("exposes the errors record", () => {
    const inner = new Error("boom");
    const err = new AllReplicasFailedError({ r0: inner });
    expect(err.errors.r0).toBe(inner);
  });
});
