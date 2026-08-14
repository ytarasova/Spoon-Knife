import { describe, it, expect } from "bun:test";
import { dispatch } from "./dispatch.js";

describe("dispatch", () => {
  it("resolves with the first successful replica result", async () => {
    const result = await dispatch(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("returns the fastest replica when all succeed", async () => {
    const delays = [50, 10, 30];
    const result = await dispatch(
      (i) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(`replica-${i}`), delays[i])
        ),
      { replicas: 3 }
    );
    expect(result).toBe("replica-1");
  });

  it("ignores failed replicas and returns a healthy one", async () => {
    const result = await dispatch((i) => {
      if (i === 0) return Promise.reject(new Error("replica 0 down"));
      if (i === 2) return Promise.reject(new Error("replica 2 down"));
      return Promise.resolve("replica-1-ok");
    });
    expect(result).toBe("replica-1-ok");
  });

  it("throws AggregateError when all 3 replicas fail", async () => {
    const err = await dispatch(() => Promise.reject(new Error("fail"))).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(AggregateError);
    expect(err.errors).toHaveLength(3);
    expect(err.message).toBe("all replicas failed");
  });

  it("succeeds when only the last replica responds", async () => {
    const result = await dispatch((i) => {
      if (i < 2) return Promise.reject(new Error(`replica ${i} failed`));
      return Promise.resolve("last-replica");
    });
    expect(result).toBe("last-replica");
  });

  it("respects the replicas option", async () => {
    let called = 0;
    const result = await dispatch(() => {
      called++;
      return Promise.resolve("x");
    }, { replicas: 1 });
    expect(result).toBe("x");
    expect(called).toBe(1);
  });

  it("rejects replica requests that exceed timeoutMs", async () => {
    const err = await dispatch(
      () => new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
      { replicas: 3, timeoutMs: 50 }
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect(err.errors.every((e) => /timed out/.test(e.message))).toBe(true);
  });

  it("resolves before timeout if a replica responds in time", async () => {
    const result = await dispatch(
      (i) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(`r${i}`), i === 1 ? 10 : 300)
        ),
      { replicas: 3, timeoutMs: 100 }
    );
    expect(result).toBe("r1");
  });

  it("throws RangeError for replicas < 1", async () => {
    expect(() => dispatch(() => Promise.resolve("ok"), { replicas: 0 })).toThrow(
      RangeError
    );
  });
});
