import { CheckpointStore } from "./checkpoint";
import type { InFlightTracker, OperationId } from "./in-flight";

export interface RetryOptions {
  maxAttempts: number;
  delayMs?: number;
}

export interface ResilientOperationResult<T> {
  value: T;
  attempts: number;
  rolledBack: boolean;
  checkpointId?: string;
}

export interface InFlightResilientResult<T> extends ResilientOperationResult<T> {
  cancelledOps: OperationId[];
}

/**
 * Runs an operation with automatic checkpointing before each attempt.
 * On failure, rolls state back to the pre-attempt checkpoint and retries.
 * The returned result reflects the "after" state: final value + rollback history.
 */
export async function withCheckpointedRetry<S, T>(
  store: CheckpointStore<S>,
  getState: () => S,
  setState: (s: S) => void,
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<ResilientOperationResult<T>> {
  const { maxAttempts, delayMs = 0 } = options;
  let attempts = 0;
  let rolledBack = false;
  let lastCheckpointId: string | undefined;

  while (attempts < maxAttempts) {
    lastCheckpointId = store.save(getState(), `before-attempt-${attempts + 1}`);
    attempts++;

    try {
      const value = await operation();
      return { value, attempts, rolledBack, checkpointId: lastCheckpointId };
    } catch {
      rolledBack = true;
      const restored = store.rollbackTo(lastCheckpointId!);
      setState(restored);

      if (attempts < maxAttempts && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  throw new Error(`Operation failed after ${maxAttempts} attempt(s)`);
}

/**
 * Like withCheckpointedRetry but also manages in-flight async operations via an
 * InFlightTracker. Before each attempt the tracker's snapshot is captured in the
 * checkpoint; on rollback all outstanding operations are cancelled so the restored
 * state is consistent with no dangling side-effects from the failed attempt.
 */
export async function withInFlightCheckpointedRetry<S, T>(
  store: CheckpointStore<S>,
  tracker: InFlightTracker,
  getState: () => S,
  setState: (s: S) => void,
  operation: (tracker: InFlightTracker) => Promise<T>,
  options: RetryOptions
): Promise<InFlightResilientResult<T>> {
  const { maxAttempts, delayMs = 0 } = options;
  let attempts = 0;
  let rolledBack = false;
  let lastCheckpointId: string | undefined;
  const allCancelled: OperationId[] = [];

  while (attempts < maxAttempts) {
    // Checkpoint captures current state + in-flight snapshot via the tracker
    lastCheckpointId = store.save(getState(), `before-attempt-${attempts + 1}`);
    attempts++;

    try {
      const value = await operation(tracker);
      return { value, attempts, rolledBack, checkpointId: lastCheckpointId, cancelledOps: allCancelled };
    } catch {
      rolledBack = true;
      // rollbackTo also calls tracker.cancelAll() — collect the cancelled ids
      const cp = store.get(lastCheckpointId!);
      const inFlightAtCheckpoint = cp?.inFlight?.operations.map((o) => o.id) ?? [];
      allCancelled.push(...inFlightAtCheckpoint);

      const restored = store.rollbackTo(lastCheckpointId!);
      setState(restored);

      if (attempts < maxAttempts && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  throw new Error(`Operation failed after ${maxAttempts} attempt(s)`);
}
