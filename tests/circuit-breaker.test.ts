import { describe, it, expect, beforeEach } from "bun:test";
import { CircuitBreaker, CircuitOpenError } from "../src/circuit-breaker.js";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({ failureThreshold: 3, successThreshold: 1, halfOpenTimeout: 100 });
  });

  it("starts in closed state and allows calls", async () => {
    expect(breaker.currentState).toBe("closed");
    const result = await breaker.execute(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("opens after reaching failure threshold", async () => {
    for (let i = 0; i < 3; i++) {
      breaker.recordFailure();
    }
    expect(breaker.currentState).toBe("open");
    expect(breaker.isAvailable()).toBe(false);
  });

  it("throws CircuitOpenError when open", async () => {
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    await expect(breaker.execute(() => Promise.resolve(1))).rejects.toThrow(CircuitOpenError);
  });

  it("records failure when execute throws", async () => {
    const err = new Error("boom");
    await expect(breaker.execute(() => Promise.reject(err))).rejects.toThrow("boom");
    expect(breaker.currentState).toBe("closed");
    // After 2 more failures it should open
    await expect(breaker.execute(() => Promise.reject(err))).rejects.toThrow();
    await expect(breaker.execute(() => Promise.reject(err))).rejects.toThrow();
    expect(breaker.currentState).toBe("open");
  });

  it("transitions to half-open after timeout", async () => {
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.currentState).toBe("open");
    await new Promise((r) => setTimeout(r, 110));
    expect(breaker.currentState).toBe("half-open");
  });

  it("closes from half-open on success", async () => {
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    await new Promise((r) => setTimeout(r, 110));
    expect(breaker.currentState).toBe("half-open");
    breaker.recordSuccess();
    expect(breaker.currentState).toBe("closed");
  });

  it("returns to open from half-open on failure", async () => {
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    await new Promise((r) => setTimeout(r, 110));
    expect(breaker.currentState).toBe("half-open");
    breaker.recordFailure();
    expect(breaker.currentState).toBe("open");
  });

  it("fires onStateChange callback on transitions", () => {
    const transitions: Array<[string, string]> = [];
    const b = new CircuitBreaker({
      failureThreshold: 2,
      halfOpenTimeout: 50,
      onStateChange: (prev, next) => transitions.push([prev, next]),
    });
    b.recordFailure();
    b.recordFailure();
    expect(transitions).toEqual([["closed", "open"]]);
  });

  it("resets failure count on success in closed state", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    // Should need 3 more failures to open again
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.currentState).toBe("closed");
    breaker.recordFailure();
    expect(breaker.currentState).toBe("open");
  });
});
