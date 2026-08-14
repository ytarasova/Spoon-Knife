export type ReplicaId = string;

export type ReplicaStatus = "healthy" | "degraded" | "down";

export interface DispatchRequest<T = unknown> {
  payload: T;
  timeoutMs?: number;
}

export interface DispatchResult<R = unknown> {
  replicaId: ReplicaId;
  result: R;
  durationMs: number;
}

export interface ReplicaHandler<T = unknown, R = unknown> {
  (payload: T): Promise<R>;
}

export interface ReplicaInfo {
  id: ReplicaId;
  status: ReplicaStatus;
  failureCount: number;
  successCount: number;
  lastFailureAt: number | null;
}

export interface DispatchOptions {
  timeoutMs?: number;
  retryOnFailure?: boolean;
}

export class DispatchError extends Error {
  constructor(
    message: string,
    public readonly replicaId: ReplicaId | null,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "DispatchError";
  }
}

export class AllReplicasFailedError extends Error {
  constructor(
    public readonly errors: Array<{ replicaId: ReplicaId; error: Error }>,
  ) {
    super(
      `All replicas failed: ${errors.map((e) => `${e.replicaId}: ${e.error.message}`).join("; ")}`,
    );
    this.name = "AllReplicasFailedError";
  }
}
