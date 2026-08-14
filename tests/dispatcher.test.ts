import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  ReplicaDispatcher,
  AllReplicasUnavailableError,
  AllReplicasFailedError,
  type Replica,
} from "../src/dispatcher.js";

type Req = { id: number };
type Res = { data: string };

function makeReplica(name: string, fn: (req: Req) => Promise<Res>): Replica<Req, Res> {
  return { name, call: fn };
}

function success(data: string): (req: Req) => Promise<Res> {
  return () => Promise.resolve({ data });
}

function failure(msg: string): (req: Req) => Promise<Res> {
  return () => Promise.reject(new Error(msg));
}

describe("ReplicaDispatcher – first strategy", () => {
  it("returns first successful response", async () => {
    const dispatcher = new ReplicaDispatcher(
      [
        makeReplica("r1", success("from-r1")),
        makeReplica("r2", success("from-r2")),
        makeReplica("r3", success("from-r3")),
      ],
      { strategy: "first" }
    );
    const result = await dispatcher.dispatch({ id: 1 });
    expect(["from-r1", "from-r2", "from-r3"]).toContain(result.response.data);
    expect(result.attemptedReplicas).toHaveLength(3);
  });

  it("succeeds when only one replica works", async () => {
    const dispatcher = new ReplicaDispatcher(
      [
        makeReplica("r1", failure("r1-down")),
        makeReplica("r2", failure("r2-down")),
        makeReplica("r3", success("from-r3")),
      ],
      { strategy: "first" }
    );
    const result = await dispatcher.dispatch({ id: 1 });
    expect(result.response.data).toBe("from-r3");
    expect(result.replica).toBe("r3");
  });

  it("throws AllReplicasFailedError when all fail", async () => {
    const dispatcher = new ReplicaDispatcher(
      [
        makeReplica("r1", failure("e1")),
        makeReplica("r2", failure("e2")),
        makeReplica("r3", failure("e3")),
      ],
      { strategy: "first" }
    );
    await expect(dispatcher.dispatch({ id: 1 })).rejects.toThrow(AllReplicasFailedError);
  });

  it("reports failed replicas in causes", async () => {
    const dispatcher = new ReplicaDispatcher(
      [
        makeReplica("r1", failure("e1")),
        makeReplica("r2", failure("e2")),
        makeReplica("r3", failure("e3")),
      ],
      { strategy: "first" }
    );
    const err = await dispatcher.dispatch({ id: 1 }).catch((e) => e) as AllReplicasFailedError;
    expect(err.causes).toHaveLength(3);
  });

  it("skips replicas with open circuits", async () => {
    const dispatcher = new ReplicaDispatcher(
      [
        makeReplica("r1", success("r1")),
        makeReplica("r2", success("r2")),
        makeReplica("r3", success("r3")),
      ],
      { strategy: "first", circuitBreaker: { failureThreshold: 1 } }
    );
    // Open r1 and r2 circuits
    dispatcher.getBreakerFor("r1")!.recordFailure();
    dispatcher.getBreakerFor("r2")!.recordFailure();

    const result = await dispatcher.dispatch({ id: 1 });
    expect(result.replica).toBe("r3");
    expect(result.attemptedReplicas).toEqual(["r3"]);
  });

  it("throws AllReplicasUnavailableError when all circuits are open", async () => {
    const dispatcher = new ReplicaDispatcher(
      [
        makeReplica("r1", success("r1")),
        makeReplica("r2", success("r2")),
        makeReplica("r3", success("r3")),
      ],
      { strategy: "first", circuitBreaker: { failureThreshold: 1 } }
    );
    dispatcher.getBreakerFor("r1")!.recordFailure();
    dispatcher.getBreakerFor("r2")!.recordFailure();
    dispatcher.getBreakerFor("r3")!.recordFailure();

    await expect(dispatcher.dispatch({ id: 1 })).rejects.toThrow(AllReplicasUnavailableError);
  });

  it("opens circuit after repeated failures from execute", async () => {
    const dispatcher = new ReplicaDispatcher(
      [
        makeReplica("r1", failure("always-fail")),
        makeReplica("r2", failure("always-fail")),
        makeReplica("r3", success("r3")),
      ],
      { strategy: "first", circuitBreaker: { failureThreshold: 2 } }
    );
    // r1 & r2 fail each call; after 2 dispatches their circuits open
    for (let i = 0; i < 2; i++) {
      await dispatcher.dispatch({ id: i });
    }
    expect(dispatcher.getBreakerFor("r1")!.isAvailable()).toBe(false);
    expect(dispatcher.getBreakerFor("r2")!.isAvailable()).toBe(false);
    expect(dispatcher.getBreakerFor("r3")!.isAvailable()).toBe(true);
  });

  it("availableReplicas returns only non-open replicas", () => {
    const dispatcher = new ReplicaDispatcher(
      [makeReplica("r1", success("")), makeReplica("r2", success("")), makeReplica("r3", success(""))],
      { circuitBreaker: { failureThreshold: 1 } }
    );
    dispatcher.getBreakerFor("r1")!.recordFailure();
    expect(dispatcher.availableReplicas()).toEqual(["r2", "r3"]);
  });
});

describe("ReplicaDispatcher – majority strategy", () => {
  it("returns result when all replicas succeed", async () => {
    const dispatcher = new ReplicaDispatcher(
      [
        makeReplica("r1", success("ok")),
        makeReplica("r2", success("ok")),
        makeReplica("r3", success("ok")),
      ],
      { strategy: "majority" }
    );
    const result = await dispatcher.dispatch({ id: 1 });
    expect(result.response.data).toBe("ok");
  });

  it("succeeds with 2 of 3 replicas", async () => {
    const dispatcher = new ReplicaDispatcher(
      [
        makeReplica("r1", success("ok")),
        makeReplica("r2", failure("down")),
        makeReplica("r3", success("ok")),
      ],
      { strategy: "majority" }
    );
    const result = await dispatcher.dispatch({ id: 1 });
    expect(result.response.data).toBe("ok");
    expect(result.attemptedReplicas).toHaveLength(3);
  });

  it("fails when only 1 of 3 succeeds", async () => {
    const dispatcher = new ReplicaDispatcher(
      [
        makeReplica("r1", success("ok")),
        makeReplica("r2", failure("down")),
        makeReplica("r3", failure("down")),
      ],
      { strategy: "majority" }
    );
    await expect(dispatcher.dispatch({ id: 1 })).rejects.toThrow(AllReplicasFailedError);
  });

  it("skips open-circuited replicas and uses quorum of available ones", async () => {
    const dispatcher = new ReplicaDispatcher(
      [
        makeReplica("r1", success("r1")),
        makeReplica("r2", success("r2")),
        makeReplica("r3", success("r3")),
      ],
      { strategy: "majority", circuitBreaker: { failureThreshold: 1 } }
    );
    // Open r3; 2 remain, quorum = 1
    dispatcher.getBreakerFor("r3")!.recordFailure();
    const result = await dispatcher.dispatch({ id: 1 });
    expect(["r1", "r2"]).toContain(result.response.data);
  });
});

describe("ReplicaDispatcher – constructor validation", () => {
  it("requires exactly 3 replicas", () => {
    expect(
      () =>
        new ReplicaDispatcher(
          // @ts-expect-error intentionally passing wrong number
          [makeReplica("r1", success(""))],
          {}
        )
    ).toThrow("exactly 3 replicas");
  });
});
