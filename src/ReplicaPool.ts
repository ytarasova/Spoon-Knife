import { Replica, type ReplicaOptions } from "./Replica.js";
import type { ReplicaHandler, ReplicaId, ReplicaInfo } from "./types.js";

const REPLICA_COUNT = 3;

export interface ReplicaPoolOptions {
  replicaOptions?: ReplicaOptions;
}

export class ReplicaPool<T = unknown, R = unknown> {
  private readonly replicas: Replica<T, R>[];
  private roundRobinIndex = 0;

  constructor(
    handler: ReplicaHandler<T, R>,
    options: ReplicaPoolOptions = {},
  ) {
    this.replicas = Array.from(
      { length: REPLICA_COUNT },
      (_, i) => new Replica<T, R>(`replica-${i + 1}`, handler, options.replicaOptions),
    );
  }

  get size(): number {
    return this.replicas.length;
  }

  getInfo(): ReplicaInfo[] {
    return this.replicas.map((r) => r.info);
  }

  healthyReplicas(): Replica<T, R>[] {
    return this.replicas.filter((r) => r.isAvailable());
  }

  /** Round-robin selection among available replicas. Returns null if none are available. */
  nextAvailable(): Replica<T, R> | null {
    const available = this.healthyReplicas();
    if (available.length === 0) return null;

    const replica = available[this.roundRobinIndex % available.length];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % available.length;
    return replica;
  }

  /** Returns all replicas ordered for failover: starts from current round-robin position and advances the index. */
  failoverOrder(): Replica<T, R>[] {
    const available = this.healthyReplicas();
    if (available.length === 0) return [];

    const startIdx = this.roundRobinIndex % available.length;
    this.roundRobinIndex = (this.roundRobinIndex + 1) % available.length;
    return [
      ...available.slice(startIdx),
      ...available.slice(0, startIdx),
    ];
  }

  getById(id: ReplicaId): Replica<T, R> | undefined {
    return this.replicas.find((r) => r.id === id);
  }
}
