export type ReplicaStatus = "healthy" | "degraded" | "open";

export interface ReplicaConfig {
  id: string;
  /** Failures before circuit opens */
  failureThreshold?: number;
  /** Milliseconds the circuit stays open before going half-open */
  cooldownMs?: number;
}

export interface DispatchResult<T> {
  value: T;
  replicaId: string;
  latencyMs: number;
  failures: Record<string, Error>;
}

export class AllReplicasFailedError extends Error {
  constructor(readonly errors: Record<string, Error>) {
    super(`All replicas failed: ${Object.keys(errors).join(", ")}`);
    this.name = "AllReplicasFailedError";
  }
}

interface ReplicaState {
  config: Required<ReplicaConfig>;
  failureCount: number;
  status: ReplicaStatus;
  openSince: number | null;
}

export type ReplicaHandler<T> = (replicaId: string) => Promise<T>;

/**
 * Dispatches a request to 3 replicas concurrently and returns the first
 * successful response. Each replica has an independent circuit breaker that
 * opens after repeated failures and resets after a cooldown period.
 */
export class ReplicaDispatcher<T = unknown> {
  private replicas: ReplicaState[];

  constructor(configs: [ReplicaConfig, ReplicaConfig, ReplicaConfig]) {
    this.replicas = configs.map((config) => ({
      config: {
        id: config.id,
        failureThreshold: config.failureThreshold ?? 3,
        cooldownMs: config.cooldownMs ?? 10_000,
      },
      failureCount: 0,
      status: "healthy" as ReplicaStatus,
      openSince: null,
    }));
  }

  private effectiveStatus(replica: ReplicaState): ReplicaStatus {
    if (replica.status !== "open") return replica.status;
    const elapsed = Date.now() - (replica.openSince ?? 0);
    if (elapsed >= replica.config.cooldownMs) {
      replica.status = "degraded";
      replica.openSince = null;
    }
    return replica.status;
  }

  private onSuccess(replica: ReplicaState): void {
    replica.failureCount = 0;
    replica.status = "healthy";
    replica.openSince = null;
  }

  private onFailure(replica: ReplicaState): void {
    replica.failureCount++;
    if (replica.failureCount >= replica.config.failureThreshold) {
      replica.status = "open";
      replica.openSince = Date.now();
    } else {
      replica.status = "degraded";
    }
  }

  /**
   * Sends `handler` to all available replicas simultaneously.
   * Returns the result from whichever replica responds first successfully.
   * Throws `AllReplicasFailedError` if every replica fails.
   */
  async dispatch(handler: ReplicaHandler<T>): Promise<DispatchResult<T>> {
    const failures: Record<string, Error> = {};
    const start = Date.now();

    const candidates = this.replicas.filter(
      (r) => this.effectiveStatus(r) !== "open"
    );

    if (candidates.length === 0) {
      const err = new Error("Circuit open");
      for (const r of this.replicas) failures[r.config.id] = err;
      throw new AllReplicasFailedError(failures);
    }

    return new Promise<DispatchResult<T>>((resolve, reject) => {
      let settled = false;
      let remaining = candidates.length;

      for (const replica of candidates) {
        const replicaStart = Date.now();
        handler(replica.config.id).then(
          (value) => {
            this.onSuccess(replica);
            if (!settled) {
              settled = true;
              resolve({
                value,
                replicaId: replica.config.id,
                latencyMs: Date.now() - replicaStart,
                failures,
              });
            }
          },
          (err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            this.onFailure(replica);
            failures[replica.config.id] = error;
            remaining--;
            if (!settled && remaining === 0) {
              settled = true;
              reject(new AllReplicasFailedError({ ...failures }));
            }
          }
        );
      }
    });
  }

  /** Returns a snapshot of each replica's current status. */
  status(): Array<{ id: string; status: ReplicaStatus; failureCount: number }> {
    return this.replicas.map((r) => ({
      id: r.config.id,
      status: this.effectiveStatus(r),
      failureCount: r.failureCount,
    }));
  }

  /** Resets all circuit breakers to healthy. */
  reset(): void {
    for (const r of this.replicas) {
      r.failureCount = 0;
      r.status = "healthy";
      r.openSince = null;
    }
  }
}

/** Convenience factory — creates a dispatcher with three default replicas. */
export function createDispatcher<T>(
  options?: { failureThreshold?: number; cooldownMs?: number }
): ReplicaDispatcher<T> {
  const base: ReplicaConfig = {
    id: "",
    failureThreshold: options?.failureThreshold,
    cooldownMs: options?.cooldownMs,
  };
  return new ReplicaDispatcher<T>([
    { ...base, id: "replica-0" },
    { ...base, id: "replica-1" },
    { ...base, id: "replica-2" },
  ]);
}
