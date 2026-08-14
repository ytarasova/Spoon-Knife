import { CircuitBreaker, type CircuitBreakerOptions } from "./CircuitBreaker.js";
import type { ReplicaHandler, ReplicaId, ReplicaInfo, ReplicaStatus } from "./types.js";
import { DispatchError } from "./types.js";

export interface ReplicaOptions {
  circuitBreaker?: CircuitBreakerOptions;
}

export class Replica<T = unknown, R = unknown> {
  readonly id: ReplicaId;
  private readonly handler: ReplicaHandler<T, R>;
  private readonly circuit: CircuitBreaker;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureAt: number | null = null;

  constructor(id: ReplicaId, handler: ReplicaHandler<T, R>, options: ReplicaOptions = {}) {
    this.id = id;
    this.handler = handler;
    this.circuit = new CircuitBreaker(options.circuitBreaker);
  }

  get status(): ReplicaStatus {
    const state = this.circuit.currentState;
    if (state === "open") return "down";
    if (state === "half-open") return "degraded";
    return "healthy";
  }

  get info(): ReplicaInfo {
    return {
      id: this.id,
      status: this.status,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureAt: this.lastFailureAt,
    };
  }

  isAvailable(): boolean {
    return this.circuit.allowRequest();
  }

  async dispatch(payload: T, timeoutMs?: number): Promise<R> {
    if (!this.circuit.allowRequest()) {
      throw new DispatchError(
        `Replica ${this.id} circuit is open`,
        this.id,
      );
    }

    const start = Date.now();

    try {
      let result: R;
      if (timeoutMs !== undefined) {
        result = await this.withTimeout(this.handler(payload), timeoutMs);
      } else {
        result = await this.handler(payload);
      }

      this.circuit.recordSuccess();
      this.successCount++;
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.circuit.recordFailure();
      this.failureCount++;
      this.lastFailureAt = Date.now();
      throw new DispatchError(
        `Replica ${this.id} failed after ${Date.now() - start}ms: ${error.message}`,
        this.id,
        error,
      );
    }
  }

  private withTimeout<V>(promise: Promise<V>, ms: number): Promise<V> {
    return Promise.race([
      promise,
      new Promise<V>((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
      ),
    ]);
  }
}
