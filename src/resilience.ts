import { CheckpointStore } from "./checkpoint";

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

/**
 * Runs an operation with automatic checkpointing before each attempt.
 * On failure, rolls state back to the pre-attempt checkpoint ("roll: after")
 * and retries up to maxAttempts times.
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
