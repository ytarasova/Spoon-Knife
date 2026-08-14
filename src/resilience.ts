export type RollStrategy = "before" | "after";

export interface ResilienceOptions {
  roll?: RollStrategy;
  maxCheckpoints?: number;
}

export interface ExecuteResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  rolledBack?: unknown;
  checkpoint: Checkpoint<unknown>;
}

export class Checkpoint<S> {
  readonly state: S;
  readonly timestamp: number;
  readonly id: string;

  constructor(state: S) {
    this.state = structuredClone(state);
    this.timestamp = Date.now();
    this.id = `cp_${this.timestamp}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

export class ResilienceManager<S> {
  private checkpoints: Checkpoint<S>[] = [];
  private readonly rollStrategy: RollStrategy;
  private readonly maxCheckpoints: number;

  constructor(options: ResilienceOptions = {}) {
    this.rollStrategy = options.roll ?? "after";
    this.maxCheckpoints = options.maxCheckpoints ?? 10;
  }

  cp(state: S): Checkpoint<S> {
    const checkpoint = new Checkpoint(state);
    this.checkpoints.push(checkpoint);
    if (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints.shift();
    }
    return checkpoint;
  }

  rollback(checkpoint?: Checkpoint<S>): S | null {
    const target = checkpoint ?? this.checkpoints[this.checkpoints.length - 1];
    return target ? structuredClone(target.state) : null;
  }

  async execute<T>(
    operation: (state: S) => Promise<T>,
    state: S
  ): Promise<ExecuteResult<T>> {
    if (this.rollStrategy === "before") {
      return this.executeRollBefore(operation, state);
    }
    return this.executeRollAfter(operation, state);
  }

  private async executeRollAfter<T>(
    operation: (state: S) => Promise<T>,
    state: S
  ): Promise<ExecuteResult<T>> {
    const checkpoint = this.cp(state);
    try {
      const result = await operation(structuredClone(state));
      return { success: true, result, checkpoint };
    } catch (error) {
      const rolledBack = this.rollback(checkpoint);
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        rolledBack,
        checkpoint,
      };
    }
  }

  private async executeRollBefore<T>(
    operation: (state: S) => Promise<T>,
    state: S
  ): Promise<ExecuteResult<T>> {
    const latest = this.checkpoints[this.checkpoints.length - 1];
    if (latest) {
      // Already failed before — skip the operation and roll back immediately
      const rolledBack = this.rollback(latest);
      return {
        success: false,
        error: new Error("Skipped: previous checkpoint indicates failure"),
        rolledBack,
        checkpoint: latest,
      };
    }
    return this.executeRollAfter(operation, state);
  }

  get latestCheckpoint(): Checkpoint<S> | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  get checkpointCount(): number {
    return this.checkpoints.length;
  }

  clearCheckpoints(): void {
    this.checkpoints = [];
  }
}

export function resilience<S>(options: ResilienceOptions = {}): ResilienceManager<S> {
  return new ResilienceManager<S>(options);
}
