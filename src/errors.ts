export class AllReplicasFailedError extends Error {
  constructor(
    public readonly errors: Array<{ replicaId: string; error: Error }>,
  ) {
    const summary = errors.map((e) => `${e.replicaId}: ${e.error.message}`).join("; ");
    super(`All 3 replicas failed: ${summary}`);
    this.name = "AllReplicasFailedError";
  }
}

export class DispatchTimeoutError extends Error {
  constructor(public readonly replicaId: string, public readonly timeoutMs: number) {
    super(`Replica ${replicaId} timed out after ${timeoutMs}ms`);
    this.name = "DispatchTimeoutError";
  }
}

export class ReplicaCountError extends Error {
  constructor(actual: number) {
    super(`Dispatcher requires exactly 3 replicas, got ${actual}`);
    this.name = "ReplicaCountError";
  }
}
