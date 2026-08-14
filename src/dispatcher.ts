import { AllReplicasFailedError, DispatchTimeoutError, ReplicaCountError } from "./errors.js";
import type { DispatchOptions, DispatchResult, Replica, ReplicaHealth } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5000;
const REPLICA_COUNT = 3;

export class ReplicaDispatcher<TReq, TRes> {
  private readonly replicas: Replica<TReq, TRes>[];
  private readonly health: Map<string, ReplicaHealth>;

  constructor(replicas: Replica<TReq, TRes>[]) {
    if (replicas.length !== REPLICA_COUNT) {
      throw new ReplicaCountError(replicas.length);
    }
    this.replicas = replicas;
    this.health = new Map(
      replicas.map((r) => [
        r.id,
        {
          id: r.id,
          status: "healthy",
          consecutiveFailures: 0,
          lastSuccess: null,
          lastFailure: null,
        } satisfies ReplicaHealth,
      ]),
    );
  }

  async dispatch(request: TReq, options: DispatchOptions = {}): Promise<DispatchResult<TRes>> {
    const strategy = options.strategy ?? "first-success";

    if (strategy === "primary-failover") {
      return this.dispatchPrimaryFailover(request, options);
    }
    return this.dispatchFirstSuccess(request, options);
  }

  private async dispatchFirstSuccess(
    request: TReq,
    options: DispatchOptions,
  ): Promise<DispatchResult<TRes>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const attempted: string[] = [];
    const errors: Array<{ replicaId: string; error: Error }> = [];

    return new Promise((resolve, reject) => {
      let settled = false;
      let pendingCount = this.replicas.length;

      for (const replica of this.replicas) {
        attempted.push(replica.id);
        this.callWithTimeout(replica, request, timeoutMs)
          .then((response) => {
            if (!settled) {
              settled = true;
              this.recordSuccess(replica.id);
              resolve({ response, replicaId: replica.id, attemptedReplicas: [...attempted] });
            }
          })
          .catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            this.recordFailure(replica.id);
            errors.push({ replicaId: replica.id, error });
            pendingCount--;
            if (!settled && pendingCount === 0) {
              settled = true;
              reject(new AllReplicasFailedError(errors));
            }
          });
      }
    });
  }

  private async dispatchPrimaryFailover(
    request: TReq,
    options: DispatchOptions,
  ): Promise<DispatchResult<TRes>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const attempted: string[] = [];
    const errors: Array<{ replicaId: string; error: Error }> = [];

    for (const replica of this.replicas) {
      attempted.push(replica.id);
      try {
        const response = await this.callWithTimeout(replica, request, timeoutMs);
        this.recordSuccess(replica.id);
        return { response, replicaId: replica.id, attemptedReplicas: [...attempted] };
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.recordFailure(replica.id);
        errors.push({ replicaId: replica.id, error });
      }
    }

    throw new AllReplicasFailedError(errors);
  }

  private callWithTimeout(
    replica: Replica<TReq, TRes>,
    request: TReq,
    timeoutMs: number,
  ): Promise<TRes> {
    const call = replica.call(request);
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new DispatchTimeoutError(replica.id, timeoutMs));
      }, timeoutMs);
      // Prevent timer from blocking process exit
      if (typeof timer === "object" && "unref" in timer) {
        (timer as ReturnType<typeof setTimeout>).unref();
      }
    });
    return Promise.race([call, timeout]);
  }

  private recordSuccess(replicaId: string): void {
    const h = this.health.get(replicaId)!;
    h.consecutiveFailures = 0;
    h.lastSuccess = Date.now();
    h.status = "healthy";
  }

  private recordFailure(replicaId: string): void {
    const h = this.health.get(replicaId)!;
    h.consecutiveFailures++;
    h.lastFailure = Date.now();
    h.status = h.consecutiveFailures >= 3 ? "down" : "degraded";
  }

  getHealth(): ReplicaHealth[] {
    return [...this.health.values()];
  }

  getHealthById(replicaId: string): ReplicaHealth | undefined {
    return this.health.get(replicaId);
  }
}
