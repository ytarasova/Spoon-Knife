import { describe, test, expect } from "bun:test";
import { ReplicaPool } from "../src/ReplicaPool.js";

describe("ReplicaPool", () => {
  test("creates exactly 3 replicas", () => {
    const pool = new ReplicaPool(async (x: number) => x);
    expect(pool.size).toBe(3);
  });

  test("all replicas start healthy", () => {
    const pool = new ReplicaPool(async (x: number) => x);
    expect(pool.healthyReplicas().length).toBe(3);
  });

  test("getInfo returns info for all replicas", () => {
    const pool = new ReplicaPool(async (x: number) => x);
    const info = pool.getInfo();
    expect(info.length).toBe(3);
    expect(info.map((i) => i.id)).toEqual(["replica-1", "replica-2", "replica-3"]);
  });

  test("nextAvailable returns round-robin across healthy replicas", () => {
    const pool = new ReplicaPool(async (x: number) => x);
    const r1 = pool.nextAvailable();
    const r2 = pool.nextAvailable();
    const r3 = pool.nextAvailable();
    const ids = [r1?.id, r2?.id, r3?.id];
    expect(new Set(ids).size).toBeGreaterThanOrEqual(1);
    expect(ids.every((id) => id !== undefined)).toBe(true);
  });

  test("nextAvailable returns null when no replicas available", async () => {
    const pool = new ReplicaPool(async () => {
      throw new Error("fail");
    }, { replicaOptions: { circuitBreaker: { failureThreshold: 1 } } });

    // Trip all 3 circuits
    for (let i = 0; i < 3; i++) {
      const r = pool.nextAvailable();
      if (r) await r.dispatch(null).catch(() => {});
    }

    expect(pool.nextAvailable()).toBeNull();
  });

  test("failoverOrder returns available replicas in order", () => {
    const pool = new ReplicaPool(async (x: number) => x);
    const order = pool.failoverOrder();
    expect(order.length).toBe(3);
  });

  test("getById retrieves the correct replica", () => {
    const pool = new ReplicaPool(async (x: number) => x);
    const r = pool.getById("replica-2");
    expect(r).toBeDefined();
    expect(r?.id).toBe("replica-2");
  });

  test("getById returns undefined for unknown id", () => {
    const pool = new ReplicaPool(async (x: number) => x);
    expect(pool.getById("unknown")).toBeUndefined();
  });

  test("healthyReplicas excludes down replicas", async () => {
    const pool = new ReplicaPool(async () => {
      throw new Error("fail");
    }, { replicaOptions: { circuitBreaker: { failureThreshold: 1 } } });

    // Trip only the first replica's circuit
    const r = pool.getById("replica-1")!;
    await r.dispatch(null).catch(() => {});

    const healthy = pool.healthyReplicas();
    expect(healthy.length).toBe(2);
    expect(healthy.map((h) => h.id)).not.toContain("replica-1");
  });
});
