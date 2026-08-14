import { ReplicaPool, type ReplicaPoolOptions } from "./ReplicaPool.js";
import type { DispatchOptions, DispatchRequest, DispatchResult, ReplicaHandler, ReplicaInfo } from "./types.js";
import { AllReplicasFailedError, DispatchError } from "./types.js";

export interface DispatcherOptions extends ReplicaPoolOptions {
  /** Default timeout per dispatch attempt in ms */
  defaultTimeoutMs?: number;
  /** Maximum number of replicas to try before failing */
  maxAttempts?: number;
}

/**
 * Resilient dispatcher that distributes work across a fixed pool of 3 replicas.
 *
 * On failure it automatically tries the next available replica, tracking errors
 * from each attempt. If every replica fails, it throws AllReplicasFailedError
 * with the full per-replica error list.
 */
export class Dispatcher<T = unknown, R = unknown> {
  private readonly pool: ReplicaPool<T, R>;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly maxAttempts: number;

  constructor(handler: ReplicaHandler<T, R>, options: DispatcherOptions = {}) {
    this.pool = new ReplicaPool<T, R>(handler, options);
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.maxAttempts = options.maxAttempts ?? this.pool.size;
  }

  /** Dispatch a request, failing over to other replicas on error. */
  async dispatch(request: DispatchRequest<T>, options: DispatchOptions = {}): Promise<DispatchResult<R>> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const retryOnFailure = options.retryOnFailure ?? true;

    const candidates = retryOnFailure
      ? this.pool.failoverOrder()
      : (() => {
          const r = this.pool.nextAvailable();
          return r ? [r] : [];
        })();

    if (candidates.length === 0) {
      throw new AllReplicasFailedError([]);
    }

    const errors: Array<{ replicaId: string; error: Error }> = [];
    const attemptsAllowed = Math.min(candidates.length, this.maxAttempts);

    for (let i = 0; i < attemptsAllowed; i++) {
      const replica = candidates[i];
      const start = Date.now();

      try {
        const result = await replica.dispatch(request.payload, timeoutMs);
        return {
          replicaId: replica.id,
          result,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push({ replicaId: replica.id, error });

        if (!retryOnFailure) break;
      }
    }

    throw new AllReplicasFailedError(errors);
  }

  /** Dispatch to a specific replica by id (no failover). */
  async dispatchTo(replicaId: string, request: DispatchRequest<T>, options: DispatchOptions = {}): Promise<DispatchResult<R>> {
    const replica = this.pool.getById(replicaId);
    if (!replica) {
      throw new DispatchError(`Unknown replica: ${replicaId}`, replicaId);
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const start = Date.now();
    const result = await replica.dispatch(request.payload, timeoutMs);
    return { replicaId: replica.id, result, durationMs: Date.now() - start };
  }

  /** Returns current status info for all replicas. */
  status(): ReplicaInfo[] {
    return this.pool.getInfo();
  }

  /** Returns the count of healthy (available) replicas. */
  healthyCount(): number {
    return this.pool.healthyReplicas().length;
  }
}
