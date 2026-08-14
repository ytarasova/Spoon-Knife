import { describe, test, expect, beforeEach } from "bun:test";
import { Replica } from "../src/Replica.js";
import { DispatchError } from "../src/types.js";

describe("Replica", () => {
  test("dispatches successfully and returns result", async () => {
    const replica = new Replica("r1", async (x: number) => x * 2);
    const result = await replica.dispatch(5);
    expect(result).toBe(10);
  });

  test("tracks success count", async () => {
    const replica = new Replica("r1", async (x: number) => x);
    await replica.dispatch(1);
    await replica.dispatch(2);
    expect(replica.info.successCount).toBe(2);
    expect(replica.info.failureCount).toBe(0);
  });

  test("tracks failure count and lastFailureAt on error", async () => {
    const before = Date.now();
    const replica = new Replica("r1", async () => {
      throw new Error("boom");
    });

    await expect(replica.dispatch(null)).rejects.toThrow(DispatchError);
    expect(replica.info.failureCount).toBe(1);
    expect(replica.info.lastFailureAt).toBeGreaterThanOrEqual(before);
  });

  test("wraps handler errors in DispatchError", async () => {
    const replica = new Replica("r1", async () => {
      throw new Error("handler error");
    });

    const err = await replica.dispatch(null).catch((e) => e);
    expect(err).toBeInstanceOf(DispatchError);
    expect(err.replicaId).toBe("r1");
    expect(err.cause?.message).toBe("handler error");
  });

  test("reports healthy status when circuit is closed", () => {
    const replica = new Replica("r1", async () => "ok");
    expect(replica.status).toBe("healthy");
    expect(replica.isAvailable()).toBe(true);
  });

  test("reports down status when circuit is open", async () => {
    const replica = new Replica("r1", async () => {
      throw new Error("fail");
    }, { circuitBreaker: { failureThreshold: 2 } });

    await expect(replica.dispatch(null)).rejects.toThrow();
    await expect(replica.dispatch(null)).rejects.toThrow();

    expect(replica.status).toBe("down");
    expect(replica.isAvailable()).toBe(false);
  });

  test("throws DispatchError when circuit is open", async () => {
    const replica = new Replica("r1", async () => {
      throw new Error("fail");
    }, { circuitBreaker: { failureThreshold: 1 } });

    await expect(replica.dispatch(null)).rejects.toThrow();
    // Circuit is now open
    const err = await replica.dispatch(null).catch((e) => e);
    expect(err).toBeInstanceOf(DispatchError);
    expect(err.message).toContain("circuit is open");
  });

  test("enforces timeout", async () => {
    const replica = new Replica("r1", async () => {
      await new Promise((r) => setTimeout(r, 200));
      return "late";
    });

    await expect(replica.dispatch(null, 50)).rejects.toThrow(/Timed out/);
  });

  test("id is reflected in info", () => {
    const replica = new Replica("my-replica", async () => "x");
    expect(replica.info.id).toBe("my-replica");
  });
});
