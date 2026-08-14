export type OperationId = string;

export interface InFlightEntry {
  id: OperationId;
  startedAt: number;
  label?: string;
}

export interface InFlightSnapshot {
  operations: InFlightEntry[];
  capturedAt: number;
}

/**
 * Tracks async operations that are currently in progress.
 * Allows capturing a point-in-time snapshot of in-flight work and
 * cancelling outstanding operations when a checkpoint roll triggers rollback.
 */
export class InFlightTracker {
  private ops = new Map<OperationId, InFlightEntry>();
  private cancelCallbacks = new Map<OperationId, () => void>();
  private idCounter = 0;

  begin(label?: string): OperationId {
    const id = `op-${++this.idCounter}`;
    this.ops.set(id, { id, startedAt: Date.now(), label });
    return id;
  }

  end(id: OperationId): void {
    this.ops.delete(id);
    this.cancelCallbacks.delete(id);
  }

  onCancel(id: OperationId, cb: () => void): void {
    this.cancelCallbacks.set(id, cb);
  }

  cancelAll(): OperationId[] {
    const cancelled: OperationId[] = [...this.cancelCallbacks.keys()];
    for (const cb of this.cancelCallbacks.values()) cb();
    this.cancelCallbacks.clear();
    this.ops.clear();
    return cancelled;
  }

  snapshot(): InFlightSnapshot {
    return {
      operations: [...this.ops.values()].map((e) => ({ ...e })),
      capturedAt: Date.now(),
    };
  }

  count(): number {
    return this.ops.size;
  }
}
