import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { LeaseManager } from "./lease";

describe("LeaseManager", () => {
  let mgr: LeaseManager;

  beforeEach(() => {
    mgr = new LeaseManager({ heartbeatIntervalMs: 50 });
  });

  afterEach(() => {
    mgr.dispose();
  });

  describe("acquire", () => {
    it("grants a lease on a free resource", () => {
      const lease = mgr.acquire("db/primary", "owner-1");
      expect(lease).not.toBeNull();
      expect(lease!.ownerId).toBe("owner-1");
      expect(lease!.status).toBe("held");
    });

    it("denies a lease when a live owner holds it", () => {
      // acquire auto-heartbeats at time of acquisition; deny happens immediately after
      mgr.acquire("db/primary", "owner-1");

      const denied = mgr.acquire("db/primary", "owner-2");
      expect(denied).toBeNull();
    });

    it("grants a lease after the previous owner explicitly releases it", () => {
      mgr.acquire("db/primary", "owner-1");
      mgr.release("db/primary", "owner-1");

      const lease = mgr.acquire("db/primary", "owner-2");
      expect(lease).not.toBeNull();
      expect(lease!.ownerId).toBe("owner-2");
    });
  });

  describe("crash — owner dies", () => {
    it("marks the lease as crashed when the owner crashes", () => {
      const lease = mgr.acquire("db/primary", "owner-1")!;

      mgr.crash("owner-1");

      expect(lease.status).toBe("crashed");
    });

    it("allows another owner to acquire after a crash", () => {
      mgr.acquire("db/primary", "owner-1");
      mgr.crash("owner-1");

      const newLease = mgr.acquire("db/primary", "owner-2");
      expect(newLease).not.toBeNull();
      expect(newLease!.status).toBe("held");
    });

    it("fires the onCrash callback for every crashed lease", () => {
      const crashed: string[] = [];
      mgr = new LeaseManager({
        heartbeatIntervalMs: 50,
        onCrash: (l) => crashed.push(l.resource),
      });

      mgr.acquire("db/primary", "owner-1");
      mgr.acquire("queue/jobs", "owner-1");

      mgr.crash("owner-1");

      expect(crashed).toContain("db/primary");
      expect(crashed).toContain("queue/jobs");
    });

    it("does not crash leases held by other owners", () => {
      mgr.acquire("db/primary", "owner-1");
      const safe = mgr.acquire("queue/jobs", "owner-2")!;

      mgr.crash("owner-1");

      expect(safe.status).toBe("held");
    });

    it("detects death automatically when heartbeats stop", async () => {
      const crashed: string[] = [];
      mgr = new LeaseManager({
        heartbeatIntervalMs: 30,
        onCrash: (l) => crashed.push(l.resource),
      });

      mgr.heartbeat("owner-1");
      mgr.acquire("db/primary", "owner-1");

      // Stop heartbeating — owner is now "dead"
      // Wait for the watcher to fire
      await new Promise((r) => setTimeout(r, 120));

      expect(crashed).toContain("db/primary");
    });

    it("does NOT crash a lease while heartbeats continue", async () => {
      const crashed: string[] = [];
      mgr = new LeaseManager({
        heartbeatIntervalMs: 30,
        onCrash: (l) => crashed.push(l.resource),
      });

      mgr.heartbeat("owner-1");
      const lease = mgr.acquire("db/primary", "owner-1")!;

      // Keep heartbeating
      const interval = setInterval(() => mgr.heartbeat("owner-1"), 20);
      await new Promise((r) => setTimeout(r, 120));
      clearInterval(interval);

      expect(crashed).not.toContain("db/primary");
      expect(lease.status).toBe("held");
    });
  });

  describe("renew", () => {
    it("extends the lease expiry", () => {
      const lease = mgr.acquire("db/primary", "owner-1", { ttlMs: 100 })!;
      const before = lease.expiresAt;

      const renewed = mgr.renew("db/primary", "owner-1", { ttlMs: 5_000 });
      expect(renewed).not.toBeNull();
      expect(renewed!.expiresAt).toBeGreaterThan(before);
    });

    it("returns null if a different owner tries to renew", () => {
      mgr.acquire("db/primary", "owner-1");

      const result = mgr.renew("db/primary", "owner-2");
      expect(result).toBeNull();
    });
  });

  describe("release", () => {
    it("marks lease as expired", () => {
      const lease = mgr.acquire("db/primary", "owner-1")!;
      mgr.release("db/primary", "owner-1");
      expect(lease.status).toBe("expired");
    });

    it("returns false if the caller is not the owner", () => {
      mgr.acquire("db/primary", "owner-1");
      expect(mgr.release("db/primary", "intruder")).toBe(false);
    });
  });
});
