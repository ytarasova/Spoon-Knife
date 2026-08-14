export type RollStrategy = "before" | "after" | "in-flight";

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
  abortedInFlight?: boolean;
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

  // Tracks the AbortController for any currently-executing in-flight operation
  private inflightController: AbortController | null = null;

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

  /**
   * Abort an in-flight operation and roll back to the pre-operation checkpoint.
   * No-op if no operation is currently executing.
   * Returns the rolled-back state, or null if there is no checkpoint.
   */
  abort(): S | null {
    if (this.inflightController) {
      this.inflightController.abort();
    }
    return this.rollback();
  }

  async execute<T>(
    operation:
      | ((state: S) => Promise<T>)
      | ((state: S, signal: AbortSignal) => Promise<T>),
    state: S
  ): Promise<ExecuteResult<T>> {
    if (this.rollStrategy === "before") {
      return this.executeRollBefore(
        operation as (state: S) => Promise<T>,
        state
      );
    }
    if (this.rollStrategy === "in-flight") {
      return this.executeRollInFlight(
        operation as (state: S, signal: AbortSignal) => Promise<T>,
        state
      );
    }
    return this.executeRollAfter(
      operation as (state: S) => Promise<T>,
      state
    );
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

  private async executeRollInFlight<T>(
    operation: (state: S, signal: AbortSignal) => Promise<T>,
    state: S
  ): Promise<ExecuteResult<T>> {
    const checkpoint = this.cp(state);
    const controller = new AbortController();
    this.inflightController = controller;

    try {
      const result = await operation(structuredClone(state), controller.signal);
      // Operation completed before any abort
      this.inflightController = null;
      if (controller.signal.aborted) {
        // Completed but signal was aborted concurrently — treat as aborted
        const rolledBack = this.rollback(checkpoint);
        return {
          success: false,
          error: new Error("Operation aborted in-flight"),
          rolledBack,
          checkpoint,
          abortedInFlight: true,
        };
      }
      return { success: true, result, checkpoint };
    } catch (error) {
      this.inflightController = null;
      const rolledBack = this.rollback(checkpoint);
      const isAbort =
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError");
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        rolledBack,
        checkpoint,
        abortedInFlight: isAbort,
      };
    }
  }

  get latestCheckpoint(): Checkpoint<S> | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  get checkpointCount(): number {
    return this.checkpoints.length;
  }

  get isInflight(): boolean {
    return this.inflightController !== null;
  }

  clearCheckpoints(): void {
    this.checkpoints = [];
  }
}

export function resilience<S>(options: ResilienceOptions = {}): ResilienceManager<S> {
  return new ResilienceManager<S>(options);
}
