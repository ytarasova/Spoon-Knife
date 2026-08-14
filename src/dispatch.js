/**
 * 3-replica dispatch: sends a request to N replicas in parallel and returns
 * the first successful response. Provides resilience against slow or failing nodes.
 */

const DEFAULT_REPLICAS = 3;

/**
 * Dispatch a request to multiple replicas and return the first success.
 *
 * @param {Function} fn - async factory: given a replica index, returns a Promise
 * @param {object} [options]
 * @param {number} [options.replicas=3] - number of parallel replicas to attempt
 * @param {number} [options.timeoutMs] - per-replica timeout in milliseconds
 * @returns {Promise<any>} - resolves with the first successful result
 * @throws {AggregateError} - if all replicas fail
 */
export async function dispatch(fn, { replicas = DEFAULT_REPLICAS, timeoutMs } = {}) {
  if (replicas < 1) throw new RangeError("replicas must be >= 1");

  let settled = 0;
  const errors = new Array(replicas);

  return new Promise((resolve, reject) => {
    for (let i = 0; i < replicas; i++) {
      let p = Promise.resolve().then(() => fn(i));

      if (timeoutMs != null) {
        p = Promise.race([p, rejectAfter(timeoutMs, `replica ${i} timed out`)]);
      }

      p.then(
        (value) => {
          resolve(value);
        },
        (err) => {
          errors[i] = err;
          settled++;
          if (settled === replicas) {
            reject(new AggregateError(errors, "all replicas failed"));
          }
        }
      );
    }
  });
}

function rejectAfter(ms, message) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(message)), ms)
  );
}
