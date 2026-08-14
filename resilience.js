'use strict';

/**
 * Resilience: Checkpoint Roll-After
 *
 * Implements a checkpoint/roll pattern where:
 * - cp (checkpoint): captures system state at a known-good point
 * - roll:after: after a rolling operation completes, the checkpoint
 *   is saved so recovery can return to post-roll state
 */

class Checkpoint {
  constructor(name) {
    this.name = name;
    this.state = null;
    this.timestamp = null;
  }

  save(state) {
    this.state = JSON.parse(JSON.stringify(state));
    this.timestamp = Date.now();
    return this;
  }

  restore() {
    if (this.state === null) {
      throw new Error(`Checkpoint "${this.name}" has no saved state`);
    }
    return JSON.parse(JSON.stringify(this.state));
  }

  hasState() {
    return this.state !== null;
  }
}

/**
 * Wraps an async operation with checkpoint-roll-after resilience.
 *
 * The checkpoint is taken *after* the operation succeeds (roll:after
 * semantics). On failure, execution rolls back to the most recent
 * saved checkpoint.
 *
 * @param {Checkpoint} checkpoint - checkpoint to update on success / roll to on failure
 * @param {Function} operation - async function representing the rolling operation
 * @param {object} [options]
 * @param {number} [options.retries=0] - number of retry attempts on failure
 * @param {Function} [options.onRollback] - called when rolling back to checkpoint
 * @returns {Promise<{result: any, checkpoint: Checkpoint}>}
 */
async function withRollAfter(checkpoint, operation, options = {}) {
  const { retries = 0, onRollback } = options;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await operation();
      // roll:after — checkpoint saved only after successful completion
      checkpoint.save(result);
      return { result, checkpoint };
    } catch (err) {
      lastError = err;
      if (checkpoint.hasState() && onRollback) {
        onRollback(checkpoint.restore(), err);
      }
    }
  }

  const rolledBackState = checkpoint.hasState() ? checkpoint.restore() : null;
  const error = Object.assign(
    new Error(`Operation failed after ${retries + 1} attempt(s): ${lastError.message}`),
    { cause: lastError, rolledBackState }
  );
  throw error;
}

/**
 * Runs a sequence of operations as a rolling update with checkpoints.
 * Each step is checkpointed after it succeeds (roll:after).
 * On failure, the sequence stops and the last good checkpoint is available.
 *
 * @param {Array<{name: string, run: Function}>} steps
 * @returns {Promise<{completed: string[], lastCheckpoint: Checkpoint|null}>}
 */
async function rollingWithCheckpoints(steps) {
  const completed = [];
  let lastCheckpoint = null;

  for (const step of steps) {
    const cp = new Checkpoint(step.name);
    await withRollAfter(cp, step.run, {
      onRollback: (state, err) => {
        // surface rollback to caller via lastCheckpoint
        lastCheckpoint = cp;
      },
    });
    completed.push(step.name);
    lastCheckpoint = cp;
  }

  return { completed, lastCheckpoint };
}

module.exports = { Checkpoint, withRollAfter, rollingWithCheckpoints };
