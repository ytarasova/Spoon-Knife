export interface Replica<TReq, TRes> {
  id: string;
  call(request: TReq): Promise<TRes>;
}

export interface DispatchOptions {
  timeoutMs?: number;
  strategy?: "first-success" | "primary-failover";
}

export interface DispatchResult<TRes> {
  response: TRes;
  replicaId: string;
  attemptedReplicas: string[];
}

export type ReplicaStatus = "healthy" | "degraded" | "down";

export interface ReplicaHealth {
  id: string;
  status: ReplicaStatus;
  consecutiveFailures: number;
  lastSuccess: number | null;
  lastFailure: number | null;
}
