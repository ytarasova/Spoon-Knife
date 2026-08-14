export type LeaseStatus = "held" | "expired" | "crashed";

export interface Lease {
  id: string;
  resource: string;
  ownerId: string;
  acquiredAt: number;
  expiresAt: number;
  status: LeaseStatus;
}

export interface LeaseOptions {
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 30_000;

export class LeaseManager {
  private leases = new Map<string, Lease>();
  /** last heartbeat timestamp per owner; absence means owner was never registered */
  private lastHeartbeat = new Map<string, number>();
  private heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private heartbeatIntervalMs: number;
  private onCrash?: (lease: Lease) => void;

  constructor(opts: { heartbeatIntervalMs?: number; onCrash?: (lease: Lease) => void } = {}) {
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 1_000;
    this.onCrash = opts.onCrash;
  }

  /** Register an owner as alive. Call this repeatedly (heartbeat) to keep ownership valid. */
  heartbeat(ownerId: string): void {
    this.lastHeartbeat.set(ownerId, Date.now());
  }

  /**
   * Acquire a lease on a resource. Returns the lease if granted, or null if the
   * resource is already held by another live owner.
   */
  acquire(resource: string, ownerId: string, opts: LeaseOptions = {}): Lease | null {
    const existing = this.leases.get(resource);

    if (existing && existing.status === "held") {
      const isExpired = Date.now() >= existing.expiresAt;
      const ownerAlive = this.isOwnerAlive(existing.ownerId);

      if (!isExpired && ownerAlive) {
        return null; // resource is actively held
      }

      if (!ownerAlive && !isExpired) {
        this.markCrashed(existing);
      } else {
        existing.status = "expired";
      }
    }

    const now = Date.now();
    const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
    const lease: Lease = {
      id: `${resource}:${ownerId}:${now}`,
      resource,
      ownerId,
      acquiredAt: now,
      expiresAt: now + ttl,
      status: "held",
    };

    this.leases.set(resource, lease);
    this.heartbeat(ownerId);
    this.startOwnerWatcher(ownerId);
    return lease;
  }

  /** Renew an existing lease, extending its TTL. */
  renew(resource: string, ownerId: string, opts: LeaseOptions = {}): Lease | null {
    const lease = this.leases.get(resource);
    if (!lease || lease.ownerId !== ownerId || lease.status !== "held") return null;

    const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
    lease.expiresAt = Date.now() + ttl;
    return lease;
  }

  /** Explicitly release a lease held by ownerId. */
  release(resource: string, ownerId: string): boolean {
    const lease = this.leases.get(resource);
    if (!lease || lease.ownerId !== ownerId || lease.status !== "held") return false;

    lease.status = "expired";
    this.stopOwnerWatcher(ownerId);
    this.lastHeartbeat.delete(ownerId);
    return true;
  }

  /** Signal that an owner has crashed (died). All its leases are marked crashed immediately. */
  crash(ownerId: string): void {
    this.lastHeartbeat.delete(ownerId);
    this.stopOwnerWatcher(ownerId);

    for (const lease of this.leases.values()) {
      if (lease.ownerId === ownerId && lease.status === "held") {
        this.markCrashed(lease);
      }
    }
  }

  get(resource: string): Lease | undefined {
    return this.leases.get(resource);
  }

  dispose(): void {
    for (const timer of this.heartbeatTimers.values()) clearInterval(timer);
    this.heartbeatTimers.clear();
  }

  /** An owner is alive if it sent a heartbeat within the last 2× heartbeat interval. */
  private isOwnerAlive(ownerId: string): boolean {
    const last = this.lastHeartbeat.get(ownerId);
    if (last === undefined) return false;
    return Date.now() - last < this.heartbeatIntervalMs * 2;
  }

  private markCrashed(lease: Lease): void {
    lease.status = "crashed";
    this.onCrash?.(lease);
  }

  /**
   * Start a periodic watcher for an owner. If the watcher fires and the owner
   * has missed too many heartbeats, all their held leases are marked as crashed.
   */
  private startOwnerWatcher(ownerId: string): void {
    if (this.heartbeatTimers.has(ownerId)) return;

    const timer = setInterval(() => {
      if (!this.isOwnerAlive(ownerId)) {
        this.stopOwnerWatcher(ownerId);
        for (const lease of this.leases.values()) {
          if (lease.ownerId === ownerId && lease.status === "held") {
            this.markCrashed(lease);
          }
        }
      }
    }, this.heartbeatIntervalMs);

    this.heartbeatTimers.set(ownerId, timer);
  }

  private stopOwnerWatcher(ownerId: string): void {
    const timer = this.heartbeatTimers.get(ownerId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(ownerId);
    }
  }
}
