'use strict';

/**
 * Post-fault dispatch probe.
 *
 * Wraps a dispatch function so that when it throws, a structured probe
 * snapshot is captured and forwarded to all registered probe handlers.
 * Handlers receive the snapshot synchronously before the error re-propagates,
 * giving them a chance to log, alert, or persist crash diagnostics.
 */

let _faultSequence = 0;

class DispatchProbe {
  constructor() {
    this._handlers = [];
    this._faultHistory = [];
    this._maxHistory = 100;
  }

  /**
   * Register a probe handler invoked on every post-fault snapshot.
   * @param {function(ProbeSnapshot): void} handler
   * @returns {function} unsubscribe function
   */
  onFault(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('handler must be a function');
    }
    this._handlers.push(handler);
    return () => {
      const idx = this._handlers.indexOf(handler);
      if (idx !== -1) this._handlers.splice(idx, 1);
    };
  }

  /**
   * Wrap a target function so post-fault probing fires on each throw.
   * The original error always re-propagates after handlers run.
   *
   * @param {function} target - Function to wrap
   * @param {object} [meta] - Optional static metadata merged into snapshots
   * @returns {function} wrapped function with identical call signature
   */
  wrap(target, meta = {}) {
    if (typeof target !== 'function') {
      throw new TypeError('target must be a function');
    }
    const probe = this;
    const label = meta.label || target.name || '<anonymous>';

    return function dispatchWrapper(...args) {
      try {
        return target.apply(this, args);
      } catch (err) {
        const snapshot = probe._capture(err, args, label, meta);
        probe._dispatch(snapshot);
        throw err;
      }
    };
  }

  /**
   * Wrap an async target function.
   * Captures post-fault probe on rejected promise before re-rejecting.
   *
   * @param {function} target
   * @param {object} [meta]
   * @returns {function}
   */
  wrapAsync(target, meta = {}) {
    if (typeof target !== 'function') {
      throw new TypeError('target must be a function');
    }
    const probe = this;
    const label = meta.label || target.name || '<anonymous>';

    return async function asyncDispatchWrapper(...args) {
      try {
        return await target.apply(this, args);
      } catch (err) {
        const snapshot = probe._capture(err, args, label, meta);
        probe._dispatch(snapshot);
        throw err;
      }
    };
  }

  /**
   * Return a copy of the fault history (most recent first).
   * @returns {ProbeSnapshot[]}
   */
  history() {
    return this._faultHistory.slice().reverse();
  }

  /** Clear the fault history ring buffer. */
  clearHistory() {
    this._faultHistory = [];
  }

  /** Reset the global fault sequence counter (useful in tests). */
  static resetSequence() {
    _faultSequence = 0;
  }

  _capture(err, args, label, meta) {
    _faultSequence += 1;
    return {
      seq: _faultSequence,
      ts: Date.now(),
      label,
      meta,
      error: {
        name: err && err.name,
        message: err && err.message,
        stack: err && err.stack,
      },
      args: args.map(_safeSerialize),
    };
  }

  _dispatch(snapshot) {
    this._faultHistory.push(snapshot);
    if (this._faultHistory.length > this._maxHistory) {
      this._faultHistory.shift();
    }
    for (const h of this._handlers) {
      try {
        h(snapshot);
      } catch (_) {
        // probe handlers must not suppress the original fault
      }
    }
  }
}

function _safeSerialize(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'function') return '[Function]';
  try {
    return JSON.parse(JSON.stringify(v));
  } catch (_) {
    return String(v);
  }
}

module.exports = { DispatchProbe };
