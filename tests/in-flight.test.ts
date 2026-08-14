import { describe, it, expect, beforeEach } from "bun:test";
import { InFlightTracker } from "../src/in-flight";

describe("InFlightTracker", () => {
  let tracker: InFlightTracker;

  beforeEach(() => {
    tracker = new InFlightTracker();
  });

  it("begins and tracks an operation", () => {
    const id = tracker.begin("write-op");
    expect(tracker.count()).toBe(1);
    const snap = tracker.snapshot();
    expect(snap.operations).toHaveLength(1);
    expect(snap.operations[0]?.id).toBe(id);
    expect(snap.operations[0]?.label).toBe("write-op");
  });

  it("ending an operation removes it from tracking", () => {
    const id = tracker.begin("transient");
    expect(tracker.count()).toBe(1);
    tracker.end(id);
    expect(tracker.count()).toBe(0);
  });

  it("snapshot is immutable — later mutations don't retroactively change it", () => {
    const id = tracker.begin("op-a");
    const snap = tracker.snapshot();
    tracker.begin("op-b");
    // snapshot was taken when only op-a was in flight
    expect(snap.operations).toHaveLength(1);
    expect(snap.operations[0]?.id).toBe(id);
  });

  it("cancelAll triggers cancel callbacks and clears ops", () => {
    const log: string[] = [];
    const id1 = tracker.begin("op-1");
    const id2 = tracker.begin("op-2");
    tracker.onCancel(id1, () => log.push("cancelled-op-1"));
    tracker.onCancel(id2, () => log.push("cancelled-op-2"));

    const cancelled = tracker.cancelAll();

    expect(cancelled).toContain(id1);
    expect(cancelled).toContain(id2);
    expect(log).toContain("cancelled-op-1");
    expect(log).toContain("cancelled-op-2");
    expect(tracker.count()).toBe(0);
  });

  it("cancelAll with no registered callbacks still clears ops", () => {
    tracker.begin("silent-op");
    expect(tracker.count()).toBe(1);
    const cancelled = tracker.cancelAll();
    expect(cancelled).toHaveLength(0); // no cancel callbacks registered
    expect(tracker.count()).toBe(0);
  });

  it("onCancel callback is not called after end()", () => {
    const log: string[] = [];
    const id = tracker.begin("op");
    tracker.onCancel(id, () => log.push("cancelled"));
    tracker.end(id); // clean completion removes cancel hook
    tracker.cancelAll();
    expect(log).toHaveLength(0);
  });
});
