/**
 * Post-fault dispatch probe.
 *
 * Captures uncaught errors and unhandled promise rejections, packages them
 * into a structured fault record, and dispatches them to a configured sink.
 *
 * Usage:
 *   const probe = new CrashProbe({ endpoint: '/api/fault-report' });
 *   probe.install();
 *
 * The probe is safe to install multiple times; duplicate installs are no-ops.
 */

'use strict';

const DEFAULT_MAX_QUEUE = 50;

class CrashProbe {
  /**
   * @param {object} [options]
   * @param {string} [options.endpoint]        - URL to POST fault records to
   * @param {function} [options.onDispatch]    - fallback called with each record when endpoint is absent
   * @param {number} [options.maxQueue=50]     - max buffered records before oldest is dropped
   * @param {string} [options.release]         - app version / release tag included in every record
   */
  constructor(options = {}) {
    this._endpoint = options.endpoint || null;
    this._onDispatch = options.onDispatch || null;
    this._maxQueue = options.maxQueue || DEFAULT_MAX_QUEUE;
    this._release = options.release || 'unknown';
    this._queue = [];
    this._installed = false;
    this._boundErrorHandler = this._handleError.bind(this);
    this._boundRejectionHandler = this._handleRejection.bind(this);
  }

  /** Attach global listeners. Safe to call multiple times. */
  install() {
    if (this._installed) return;
    this._installed = true;
    if (typeof window !== 'undefined') {
      window.addEventListener('error', this._boundErrorHandler);
      window.addEventListener('unhandledrejection', this._boundRejectionHandler);
    }
  }

  /** Detach global listeners. */
  uninstall() {
    if (!this._installed) return;
    this._installed = false;
    if (typeof window !== 'undefined') {
      window.removeEventListener('error', this._boundErrorHandler);
      window.removeEventListener('unhandledrejection', this._boundRejectionHandler);
    }
  }

  /**
   * Manually record and dispatch a fault without waiting for a thrown error.
   * @param {Error|string} error
   * @param {object} [context] - additional key/value pairs to attach
   */
  capture(error, context = {}) {
    const record = this._buildRecord(error, context);
    this._enqueue(record);
    this._dispatch(record);
    return record;
  }

  /** Return a copy of the buffered fault queue (oldest first). */
  drainQueue() {
    const copy = this._queue.slice();
    this._queue = [];
    return copy;
  }

  // ---- private ----

  _handleError(event) {
    const record = this._buildRecord(event.error || event.message, {
      source: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
    this._enqueue(record);
    this._dispatch(record);
  }

  _handleRejection(event) {
    const reason = event.reason instanceof Error
      ? event.reason
      : new Error(String(event.reason));
    const record = this._buildRecord(reason, { type: 'unhandledrejection' });
    this._enqueue(record);
    this._dispatch(record);
  }

  _buildRecord(error, context = {}) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      id: _uuid(),
      timestamp: new Date().toISOString(),
      release: this._release,
      message: err.message,
      stack: err.stack || null,
      context,
    };
  }

  _enqueue(record) {
    if (this._queue.length >= this._maxQueue) {
      this._queue.shift(); // drop oldest
    }
    this._queue.push(record);
  }

  _dispatch(record) {
    if (this._endpoint) {
      this._post(record);
    } else if (typeof this._onDispatch === 'function') {
      try {
        this._onDispatch(record);
      } catch (_) {
        // never let a user-supplied handler break the probe itself
      }
    }
  }

  _post(record) {
    if (typeof fetch === 'undefined') return;
    fetch(this._endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
      // Fire-and-forget; failures are silently swallowed to avoid recursion.
      keepalive: true,
    }).catch(() => {});
  }
}

function _uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// CommonJS + ES module dual export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CrashProbe };
} else if (typeof window !== 'undefined') {
  window.CrashProbe = CrashProbe;
}
