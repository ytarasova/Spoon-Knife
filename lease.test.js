const { describe, it, expect, beforeEach } = require("bun:test");
const { LeaseManager } = require("./lease");

/**
 * Controllable clock so tests don't rely on real time passing.
 */
function makeClock(startMs = 1000) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

// ---------------------------------------------------------------------------
// Basic acquisition
// ---------------------------------------------------------------------------

describe("LeaseManager — basic acquisition", () => {
  let clock;
  let manager;

  beforeEach(() => {
    clock = makeClock();
    manager = new LeaseManager(clock);
  });

  it("grants a lease when none exists", () => {
    expect(manager.acquire("db", "node-1", 5000)).toBe(true);
    expect(manager.getOwner("db")).toBe("node-1");
  });

  it("denies a second acquire while the first lease is live", () => {
    manager.acquire("db", "node-1", 5000);
    expect(manager.acquire("db", "node-2", 5000)).toBe(false);
    expect(manager.getOwner("db")).toBe("node-1");
  });

  it("releases a lease voluntarily and lets another owner in", () => {
    manager.acquire("db", "node-1", 5000);
    expect(manager.release("db", "node-1")).toBe(true);
    expect(manager.acquire("db", "node-2", 5000)).toBe(true);
    expect(manager.getOwner("db")).toBe("node-2");
  });

  it("refuses release from a non-owner", () => {
    manager.acquire("db", "node-1", 5000);
    expect(manager.release("db", "node-2")).toBe(false);
    expect(manager.getOwner("db")).toBe("node-1");
  });

  it("getOwner returns null when no lease exists", () => {
    expect(manager.getOwner("db")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// @crash: lease owner dies
//
// When a node that holds a lease crashes, it never calls release().
// The only recovery path is TTL expiry.  These tests verify that after
// the TTL elapses a new owner can acquire the resource.
// ---------------------------------------------------------------------------

describe("@crash: lease owner dies", () => {
  let clock;
  let manager;

  beforeEach(() => {
    clock = makeClock();
    manager = new LeaseManager(clock);
  });

  it("getOwner returns null once TTL expires after owner crash", () => {
    // node-1 acquires then crashes (never calls release)
    manager.acquire("shard-0", "node-1", 1000 /* 1 s TTL */);
    expect(manager.getOwner("shard-0")).toBe("node-1");

    // Simulated crash: time advances past TTL
    clock.advance(1001);

    expect(manager.getOwner("shard-0")).toBeNull();
  });

  it("new owner can acquire after previous owner crash and TTL expiry", () => {
    const TTL = 500;

    // node-1 acquires and then crashes
    expect(manager.acquire("shard-0", "node-1", TTL)).toBe(true);
    clock.advance(TTL - 1);  // just before expiry — still locked

    expect(manager.acquire("shard-0", "node-2", TTL)).toBe(false);

    clock.advance(1);       // TTL boundary reached — lease is expired

    // node-2 can now take over
    expect(manager.acquire("shard-0", "node-2", TTL)).toBe(true);
    expect(manager.getOwner("shard-0")).toBe("node-2");
  });

  it("crashed owner can no longer release after TTL", () => {
    manager.acquire("shard-1", "node-1", 200);
    clock.advance(201);

    // Even if a delayed release arrives from the dead node, it must be a no-op
    expect(manager.release("shard-1", "node-1")).toBe(false);
    // The new acquire from a different node should still succeed
    expect(manager.acquire("shard-1", "node-2", 200)).toBe(true);
  });

  it("multiple independent resources are isolated during a crash", () => {
    const TTL = 300;
    manager.acquire("res-A", "node-1", TTL);
    manager.acquire("res-B", "node-2", TTL);

    // node-1 crashes; advance time past its TTL
    clock.advance(TTL + 1);

    // res-A is now free
    expect(manager.getOwner("res-A")).toBeNull();
    // res-B is also expired since both had the same TTL — both nodes crashed
    expect(manager.getOwner("res-B")).toBeNull();

    // A new node can take both
    expect(manager.acquire("res-A", "node-3", TTL)).toBe(true);
    expect(manager.acquire("res-B", "node-3", TTL)).toBe(true);
  });

  it("live owner renewing heartbeat stays alive while crashed neighbour does not", () => {
    const TTL = 500;
    manager.acquire("shard-X", "node-live", TTL);
    manager.acquire("shard-Y", "node-dead", TTL);

    // Advance to just before TTL
    clock.advance(TTL - 10);

    // node-live sends a heartbeat (renew)
    expect(manager.renew("shard-X", "node-live", TTL)).toBe(true);

    // Advance past original TTL — node-dead's lease expires
    clock.advance(20);

    expect(manager.getOwner("shard-X")).toBe("node-live");  // still alive due to renew
    expect(manager.getOwner("shard-Y")).toBeNull();           // dead node expired
  });
});

// ---------------------------------------------------------------------------
// Lease renewal
// ---------------------------------------------------------------------------

describe("LeaseManager — renewal", () => {
  let clock;
  let manager;

  beforeEach(() => {
    clock = makeClock();
    manager = new LeaseManager(clock);
  });

  it("allows owner to renew before expiry", () => {
    manager.acquire("x", "owner", 100);
    clock.advance(50);
    expect(manager.renew("x", "owner", 100)).toBe(true);
    clock.advance(99);
    expect(manager.getOwner("x")).toBe("owner");
  });

  it("denies renewal after expiry", () => {
    manager.acquire("x", "owner", 100);
    clock.advance(101);
    expect(manager.renew("x", "owner", 100)).toBe(false);
  });

  it("denies renewal by non-owner", () => {
    manager.acquire("x", "owner-a", 100);
    expect(manager.renew("x", "owner-b", 100)).toBe(false);
  });
});
