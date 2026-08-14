import { CircuitBreaker, CircuitOpenError, type CircuitBreakerOptions } from "./circuit-breaker.js";

export const REPLICA_COUNT = 3;

export interface Replica<TRequest, TResponse> {
  name: string;
  call: (request: TRequest) => Promise<TResponse>;
}

export interface DispatcherOptions {
  circuitBreaker?: CircuitBreakerOptions;
  /**
   * Strategy for selecting a response when multiple replicas succeed.
   * "first" (default): return first successful response (fastest wins).
   * "majority": wait for majority (2/3) and return if they agree.
   */
  strategy?: "first" | "majority";
}

export interface DispatchResult<TResponse> {
  response: TResponse;
  replica: string;
  attemptedReplicas: string[];
}

type ReplicaOutcome<TResponse> =
  | { ok: true; replica: string; value: TResponse }
  | { ok: false; replica: string; error: unknown };

export class ReplicaDispatcher<TRequest, TResponse> {
  private readonly replicas: Replica<TRequest, TResponse>[];
  private readonly breakers: Map<string, CircuitBreaker>;
  private readonly strategy: "first" | "majority";

  constructor(
    replicas: [Replica<TRequest, TResponse>, Replica<TRequest, TResponse>, Replica<TRequest, TResponse>],
    options: DispatcherOptions = {}
  ) {
    if (replicas.length !== REPLICA_COUNT) {
      throw new Error(`ReplicaDispatcher requires exactly ${REPLICA_COUNT} replicas`);
    }
    this.replicas = replicas;
    this.strategy = options.strategy ?? "first";
    this.breakers = new Map(
      replicas.map((r) => [r.name, new CircuitBreaker(options.circuitBreaker)])
    );
  }

  /** Returns the circuit breaker for a named replica (for testing/observability). */
  getBreakerFor(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  /** Returns the names of replicas whose circuit is currently available. */
  availableReplicas(): string[] {
    return this.replicas.filter((r) => this.breakers.get(r.name)!.isAvailable()).map((r) => r.name);
  }

  async dispatch(request: TRequest): Promise<DispatchResult<TResponse>> {
    const available = this.replicas.filter((r) => this.breakers.get(r.name)!.isAvailable());

    if (available.length === 0) {
      throw new AllReplicasUnavailableError("All replicas are unavailable (circuits open)");
    }

    if (this.strategy === "first") {
      return this.dispatchFirst(request, available);
    }
    return this.dispatchMajority(request, available);
  }

  /** Race all available replicas; return the first to succeed. */
  private async dispatchFirst(
    request: TRequest,
    available: Replica<TRequest, TResponse>[]
  ): Promise<DispatchResult<TResponse>> {
    const attempted = available.map((r) => r.name);

    return new Promise<DispatchResult<TResponse>>((resolve, reject) => {
      let remaining = available.length;
      const errors: unknown[] = [];

      for (const replica of available) {
        const breaker = this.breakers.get(replica.name)!;
        breaker
          .execute(() => replica.call(request))
          .then((value) => {
            resolve({ response: value, replica: replica.name, attemptedReplicas: attempted });
          })
          .catch((err) => {
            errors.push(err);
            remaining--;
            if (remaining === 0) {
              reject(new AllReplicasFailedError("All replicas failed", errors));
            }
          });
      }
    });
  }

  /** Fan out to all available replicas; require majority (ceil(n/2)) agreement. */
  private async dispatchMajority(
    request: TRequest,
    available: Replica<TRequest, TResponse>[]
  ): Promise<DispatchResult<TResponse>> {
    const attempted = available.map((r) => r.name);
    const quorum = Math.ceil(available.length / 2);

    const outcomes = await Promise.allSettled(
      available.map((replica) => {
        const breaker = this.breakers.get(replica.name)!;
        return breaker
          .execute(() => replica.call(request))
          .then((value): ReplicaOutcome<TResponse> => ({ ok: true, replica: replica.name, value }))
          .catch((err): ReplicaOutcome<TResponse> => ({ ok: false, replica: replica.name, error: err }));
      })
    );

    const successes = outcomes
      .map((o) => (o.status === "fulfilled" ? o.value : null))
      .filter((o): o is Extract<ReplicaOutcome<TResponse>, { ok: true }> => o !== null && o.ok);

    const failures = outcomes
      .map((o) => (o.status === "fulfilled" ? o.value : null))
      .filter((o): o is Extract<ReplicaOutcome<TResponse>, { ok: false }> => o !== null && !o.ok);

    if (successes.length < quorum) {
      throw new AllReplicasFailedError(
        `Majority quorum not reached (${successes.length}/${available.length})`,
        failures.map((f) => f.error)
      );
    }

    // Return the first success (quorum is satisfied)
    const winner = successes[0];
    return { response: winner.value, replica: winner.replica, attemptedReplicas: attempted };
  }
}

export class AllReplicasUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllReplicasUnavailableError";
  }
}

export class AllReplicasFailedError extends Error {
  readonly causes: unknown[];
  constructor(message: string, causes: unknown[] = []) {
    super(message);
    this.name = "AllReplicasFailedError";
    this.causes = causes;
  }
}
