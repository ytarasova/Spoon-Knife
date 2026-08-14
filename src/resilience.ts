export type Handler<T, R> = (replica: T) => Promise<R>;

export interface Replica<T> {
  id: string;
  instance: T;
  healthy: boolean;
  failureCount: number;
  lastChecked: number;
}

export interface DispatchOptions {
  /** Max attempts per dispatch before giving up (default: 3) */
  maxAttempts?: number;
  /** Milliseconds before retrying a failed replica (default: 10000) */
  cooldownMs?: number;
}

export class ReplicaDispatcher<T> {
  private replicas: Replica<T>[];
  private maxAttempts: number;
  private cooldownMs: number;
  private nextIndex: number = 0;

  constructor(instances: [T, T, T], options: DispatchOptions = {}) {
    if (instances.length !== 3) {
      throw new Error("ReplicaDispatcher requires exactly 3 replicas");
    }
    this.maxAttempts = options.maxAttempts ?? 3;
    this.cooldownMs = options.cooldownMs ?? 10_000;
    this.replicas = instances.map((instance, i) => ({
      id: `replica-${i}`,
      instance,
      healthy: true,
      failureCount: 0,
      lastChecked: 0,
    }));
  }

  private isAvailable(replica: Replica<T>): boolean {
    if (replica.healthy) return true;
    // Allow retry after cooldown period
    return Date.now() - replica.lastChecked >= this.cooldownMs;
  }

  private markFailure(replica: Replica<T>): void {
    replica.failureCount += 1;
    replica.healthy = false;
    replica.lastChecked = Date.now();
  }

  private markSuccess(replica: Replica<T>): void {
    replica.healthy = true;
    replica.failureCount = 0;
  }

  /** Dispatch to the next available replica using round-robin with failover. */
  async dispatch<R>(handler: Handler<T, R>): Promise<R> {
    const tried = new Set<string>();
    let attempts = 0;
    let lastError: unknown;

    while (attempts < this.maxAttempts) {
      const replica = this.selectReplica(tried);
      if (!replica) {
        break;
      }

      tried.add(replica.id);
      attempts += 1;

      try {
        const result = await handler(replica.instance);
        this.markSuccess(replica);
        this.nextIndex = (this.replicas.indexOf(replica) + 1) % this.replicas.length;
        return result;
      } catch (err) {
        lastError = err;
        this.markFailure(replica);
      }
    }

    throw new DispatchError(
      `All ${this.maxAttempts} dispatch attempts failed`,
      lastError
    );
  }

  private selectReplica(tried: Set<string>): Replica<T> | null {
    const len = this.replicas.length;
    // Prefer round-robin starting from nextIndex; skip tried/unavailable
    for (let offset = 0; offset < len; offset++) {
      const candidate = this.replicas[(this.nextIndex + offset) % len];
      if (!tried.has(candidate.id) && this.isAvailable(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /** Return a snapshot of replica health status. */
  status(): Array<{ id: string; healthy: boolean; failureCount: number }> {
    return this.replicas.map(({ id, healthy, failureCount }) => ({
      id,
      healthy,
      failureCount,
    }));
  }

  /** Reset all replicas to healthy state. */
  reset(): void {
    for (const replica of this.replicas) {
      replica.healthy = true;
      replica.failureCount = 0;
      replica.lastChecked = 0;
    }
    this.nextIndex = 0;
  }
}

export class DispatchError extends Error {
  public readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DispatchError";
    this.cause = cause;
  }
}
