'use strict';

/**
 * Post-fault dispatch probe: detects faults, collects diagnostics, and
 * dispatches them to registered handlers after a crash event.
 */

const PROBE_STATES = Object.freeze({
  IDLE: 'idle',
  FAULTED: 'faulted',
  DISPATCHING: 'dispatching',
  COMPLETED: 'completed',
});

class CrashProbe {
  constructor(options = {}) {
    this._state = PROBE_STATES.IDLE;
    this._faultRecord = null;
    this._handlers = [];
    this._maxHandlers = options.maxHandlers ?? 16;
    this._captureStack = options.captureStack ?? true;
    this._dispatchTimeout = options.dispatchTimeout ?? 5000;
  }

  get state() {
    return this._state;
  }

  get faultRecord() {
    return this._faultRecord;
  }

  /**
   * Register a handler that receives the fault record after dispatch.
   * Returns a deregister function.
   */
  onFault(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('handler must be a function');
    }
    if (this._handlers.length >= this._maxHandlers) {
      throw new RangeError(`max handlers (${this._maxHandlers}) exceeded`);
    }
    this._handlers.push(handler);
    return () => {
      this._handlers = this._handlers.filter((h) => h !== handler);
    };
  }

  /**
   * Record a fault and dispatch the probe to all registered handlers.
   * Safe to call after a crash: no exceptions are thrown; errors from
   * handlers are collected and returned.
   */
  async recordFault(error, context = {}) {
    if (!(error instanceof Error)) {
      error = new Error(String(error));
    }

    this._state = PROBE_STATES.FAULTED;

    this._faultRecord = {
      timestamp: Date.now(),
      message: error.message,
      name: error.name,
      stack: this._captureStack ? (error.stack ?? null) : null,
      context: { ...context },
    };

    return this._dispatch();
  }

  async _dispatch() {
    this._state = PROBE_STATES.DISPATCHING;

    const record = this._faultRecord;
    const handlerErrors = [];

    const timeoutPromise = new Promise((resolve) => {
      const t = setTimeout(resolve, this._dispatchTimeout);
      if (typeof t.unref === 'function') t.unref();
    });

    const dispatchAll = Promise.allSettled(
      this._handlers.map((h) =>
        Promise.resolve()
          .then(() => h(record))
          .catch((err) => {
            handlerErrors.push({ handler: h.name || '(anonymous)', error: err });
          }),
      ),
    );

    await Promise.race([dispatchAll, timeoutPromise]);

    this._state = PROBE_STATES.COMPLETED;
    return { record, handlerErrors };
  }

  /** Reset probe back to idle, clearing any recorded fault. */
  reset() {
    this._state = PROBE_STATES.IDLE;
    this._faultRecord = null;
  }
}

/**
 * Attach a CrashProbe to the Node.js process, wiring up 'uncaughtException'
 * and 'unhandledRejection' events. Returns a detach function.
 */
function attachToProcess(probe, proc = process) {
  if (!(probe instanceof CrashProbe)) {
    throw new TypeError('probe must be a CrashProbe instance');
  }

  const onUncaughtException = (err) => {
    probe.recordFault(err, { source: 'uncaughtException' });
  };

  const onUnhandledRejection = (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    probe.recordFault(err, { source: 'unhandledRejection' });
  };

  proc.on('uncaughtException', onUncaughtException);
  proc.on('unhandledRejection', onUnhandledRejection);

  return function detach() {
    proc.off('uncaughtException', onUncaughtException);
    proc.off('unhandledRejection', onUnhandledRejection);
  };
}

module.exports = { CrashProbe, attachToProcess, PROBE_STATES };
