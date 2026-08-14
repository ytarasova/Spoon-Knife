import { describe, test, expect, beforeEach } from "bun:test";
import { CircuitBreaker } from "../src/CircuitBreaker.js";

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100, successThreshold: 2 });
  });

  test("starts closed", () => {
    expect(cb.currentState).toBe("closed");
    expect(cb.allowRequest()).toBe(true);
    expect(cb.isOpen()).toBe(false);
  });

  test("opens after reaching failure threshold", () => {
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe("closed");

    cb.recordFailure();
    expect(cb.currentState).toBe("open");
    expect(cb.allowRequest()).toBe(false);
    expect(cb.isOpen()).toBe(true);
  });

  test("resets failure count on success", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    // Only 2 failures since last success, threshold is 3 — still closed
    expect(cb.currentState).toBe("closed");
  });

  test("transitions to half-open after recovery window", async () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe("open");

    await new Promise((r) => setTimeout(r, 110));
    expect(cb.currentState).toBe("half-open");
    expect(cb.allowRequest()).toBe(true);
  });

  test("closes after enough successes in half-open state", async () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 110));
    expect(cb.currentState).toBe("half-open");

    cb.recordSuccess();
    expect(cb.currentState).toBe("half-open");
    cb.recordSuccess();
    expect(cb.currentState).toBe("closed");
  });

  test("re-opens on failure in half-open state", async () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 110));
    expect(cb.currentState).toBe("half-open");

    cb.recordFailure();
    expect(cb.currentState).toBe("open");
  });

  test("reset returns circuit to closed state", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe("open");

    cb.reset();
    expect(cb.currentState).toBe("closed");
    expect(cb.allowRequest()).toBe(true);
  });

  test("uses default options when none provided", () => {
    const defaultCb = new CircuitBreaker();
    expect(defaultCb.failureThreshold).toBe(3);
    expect(defaultCb.recoveryTimeMs).toBe(5000);
    expect(defaultCb.successThreshold).toBe(2);
  });
});
