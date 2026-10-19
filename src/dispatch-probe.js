'use strict';

/**
 * Post-fault dispatch probe: registers named probe functions that are
 * dispatched automatically when a fault is recorded, allowing callers
 * to verify subsystem health after a crash.
 */

class DispatchProbe {
  #probeHandlers = new Map();
  #faultLog = [];
  #probeTimeout;

  constructor({ probeTimeout = 5000 } = {}) {
    this.#probeTimeout = probeTimeout;
  }

  /**
   * Register a named probe to run after every recorded fault.
   * Overwrites any previously registered probe with the same name.
   */
  register(name, fn) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('probe name must be a non-empty string');
    }
    if (typeof fn !== 'function') {
      throw new TypeError('probe handler must be a function');
    }
    this.#probeHandlers.set(name, fn);
  }

  unregister(name) {
    this.#probeHandlers.delete(name);
  }

  /**
   * Record a fault and dispatch all registered probes against it.
   * Returns the fault record including each probe's result.
   */
  async dispatch(fault) {
    const record = {
      fault,
      timestamp: Date.now(),
      probeResults: [],
    };
    this.#faultLog.push(record);

    for (const [name, fn] of this.#probeHandlers) {
      record.probeResults.push(await this.#runProbe(name, fn, fault));
    }

    return record;
  }

  async #runProbe(name, fn, fault) {
    const started = Date.now();
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => fn(fault)),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`probe "${name}" timed out`)),
            this.#probeTimeout,
          ),
        ),
      ]);
      return { name, status: 'ok', value, duration: Date.now() - started };
    } catch (err) {
      return {
        name,
        status: 'error',
        error: err.message,
        duration: Date.now() - started,
      };
    }
  }

  get faultLog() {
    return this.#faultLog.slice();
  }

  clearFaultLog() {
    this.#faultLog = [];
  }
}

module.exports = { DispatchProbe };
