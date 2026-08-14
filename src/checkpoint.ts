export type CheckpointId = string;

export interface Checkpoint<T> {
  id: CheckpointId;
  state: T;
  timestamp: number;
  label?: string;
}

export class CheckpointStore<T> {
  private checkpoints: Checkpoint<T>[] = [];
  private idCounter = 0;

  save(state: T, label?: string): CheckpointId {
    const id = `cp-${++this.idCounter}`;
    const snapshot = structuredClone(state);
    this.checkpoints.push({ id, state: snapshot, timestamp: Date.now(), label });
    return id;
  }

  latest(): Checkpoint<T> | undefined {
    return this.checkpoints.at(-1);
  }

  get(id: CheckpointId): Checkpoint<T> | undefined {
    return this.checkpoints.find((cp) => cp.id === id);
  }

  rollbackTo(id: CheckpointId): T {
    const cp = this.get(id);
    if (!cp) throw new Error(`Checkpoint ${id} not found`);
    const idx = this.checkpoints.indexOf(cp);
    this.checkpoints = this.checkpoints.slice(0, idx + 1);
    return structuredClone(cp.state);
  }

  rollbackToLatest(): T {
    const cp = this.latest();
    if (!cp) throw new Error("No checkpoints available for rollback");
    return this.rollbackTo(cp.id);
  }

  all(): Readonly<Checkpoint<T>[]> {
    return this.checkpoints;
  }

  clear(): void {
    this.checkpoints = [];
    this.idCounter = 0;
  }
}
