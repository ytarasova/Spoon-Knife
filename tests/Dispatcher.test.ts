import { describe, test, expect } from "bun:test";
import { Dispatcher } from "../src/Dispatcher.js";
import { AllReplicasFailedError, DispatchError } from "../src/types.js";

describe("Dispatcher – happy path", () => {
  test("dispatches and returns result with metadata", async () => {
    const d = new Dispatcher(async (x: number) => x * 3);
    const res = await d.dispatch({ payload: 4 });
    expect(res.result).toBe(12);
    expect(res.replicaId).toMatch(/^replica-/);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("all 3 replicas serve requests", async () => {
    const seen = new Set<string>();
    const d = new Dispatcher(async (x: string) => x);
    for (let i = 0; i < 9; i++) {
      const res = await d.dispatch({ payload: `msg-${i}` });
      seen.add(res.replicaId);
    }
    expect(seen.size).toBe(3);
  });

  test("status() returns info for all 3 replicas", async () => {
    const d = new Dispatcher(async (x: number) => x);
    await d.dispatch({ payload: 1 });
    const statuses = d.status();
    expect(statuses.length).toBe(3);
    expect(statuses.every((s) => s.status === "healthy")).toBe(true);
  });

  test("healthyCount starts at 3", () => {
    const d = new Dispatcher(async (x: number) => x);
    expect(d.healthyCount()).toBe(3);
  });
});

describe("Dispatcher – failover", () => {
  test("fails over to next replica when first fails", async () => {
    let callCount = 0;
    const d = new Dispatcher(async (x: number) => {
      callCount++;
      if (callCount === 1) throw new Error("first call fails");
      return x * 2;
    }, { replicaOptions: { circuitBreaker: { failureThreshold: 5 } } });

    const res = await d.dispatch({ payload: 5 });
    expect(res.result).toBe(10);
    expect(callCount).toBe(2);
  });

  test("succeeds when only one replica is healthy", async () => {
    // Fail the first 2 calls, succeed on 3rd
    let callCount = 0;
    const d = new Dispatcher(async (x: string) => {
      callCount++;
      if (callCount <= 2) throw new Error("down");
      return `ok:${x}`;
    }, { replicaOptions: { circuitBreaker: { failureThreshold: 5 } } });

    const res = await d.dispatch({ payload: "hello" });
    expect(res.result).toBe("ok:hello");
  });

  test("throws AllReplicasFailedError when all replicas fail", async () => {
    const d = new Dispatcher(async () => {
      throw new Error("always fails");
    });

    const err = await d.dispatch({ payload: null }).catch((e) => e);
    expect(err).toBeInstanceOf(AllReplicasFailedError);
    expect(err.errors.length).toBe(3);
  });

  test("AllReplicasFailedError has per-replica errors", async () => {
    let i = 0;
    const d = new Dispatcher(async () => {
      throw new Error(`replica-error-${++i}`);
    });

    const err = await d.dispatch({ payload: null }).catch((e) => e);
    expect(err).toBeInstanceOf(AllReplicasFailedError);
    const msgs = err.errors.map((e: { error: Error }) => e.error.message);
    expect(msgs.length).toBe(3);
  });

  test("does not retry when retryOnFailure=false", async () => {
    let callCount = 0;
    const d = new Dispatcher(async () => {
      callCount++;
      throw new Error("fail");
    });

    await d.dispatch({ payload: null }, { retryOnFailure: false }).catch(() => {});
    expect(callCount).toBe(1);
  });
});

describe("Dispatcher – circuit breaker integration", () => {
  test("opens circuit after repeated failures, reducing healthy count", async () => {
    const d = new Dispatcher(async () => {
      throw new Error("fail");
    }, {
      replicaOptions: { circuitBreaker: { failureThreshold: 2 } },
    });

    // Trigger failures on all replicas (2 per replica to open circuit)
    for (let i = 0; i < 6; i++) {
      await d.dispatch({ payload: null }).catch(() => {});
    }

    expect(d.healthyCount()).toBe(0);
  });

  test("AllReplicasFailedError when all circuits open and no available replicas", async () => {
    const d = new Dispatcher(async () => {
      throw new Error("fail");
    }, {
      replicaOptions: { circuitBreaker: { failureThreshold: 1 } },
    });

    // Open all circuits
    for (let i = 0; i < 3; i++) {
      await d.dispatch({ payload: null }).catch(() => {});
    }

    const err = await d.dispatch({ payload: null }).catch((e) => e);
    expect(err).toBeInstanceOf(AllReplicasFailedError);
    // No replicas available — errors list is empty
    expect(err.errors.length).toBe(0);
  });
});

describe("Dispatcher – timeout", () => {
  test("respects per-request timeout", async () => {
    const d = new Dispatcher(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return "late";
    });

    const err = await d.dispatch({ payload: null }, { timeoutMs: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(AllReplicasFailedError);
    expect(err.errors[0].error.message).toContain("Timed out");
  });

  test("respects default timeout from constructor", async () => {
    const d = new Dispatcher(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return "late";
    }, { defaultTimeoutMs: 50 });

    const err = await d.dispatch({ payload: null }).catch((e) => e);
    expect(err).toBeInstanceOf(AllReplicasFailedError);
  });
});

describe("Dispatcher – dispatchTo", () => {
  test("dispatchTo sends to a specific replica", async () => {
    const d = new Dispatcher(async (x: number) => x + 1);
    const res = await d.dispatchTo("replica-2", { payload: 10 });
    expect(res.result).toBe(11);
    expect(res.replicaId).toBe("replica-2");
  });

  test("dispatchTo throws DispatchError for unknown replica id", async () => {
    const d = new Dispatcher(async (x: number) => x);
    await expect(d.dispatchTo("unknown", { payload: 1 })).rejects.toThrow(DispatchError);
  });
});

describe("Dispatcher – maxAttempts", () => {
  test("limits retries to maxAttempts", async () => {
    let callCount = 0;
    const d = new Dispatcher(async () => {
      callCount++;
      throw new Error("fail");
    }, { maxAttempts: 2 });

    await d.dispatch({ payload: null }).catch(() => {});
    expect(callCount).toBe(2);
  });
});
