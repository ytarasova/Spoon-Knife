'use strict';

const FAULT_TYPES = {
  TIMEOUT: 'timeout',
  CRASH: 'crash',
  REJECTION: 'rejection',
  UNAVAILABLE: 'unavailable',
};

const DISPATCH_STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  FAULTED: 'faulted',
  RECOVERING: 'recovering',
  RECOVERED: 'recovered',
};

class DispatchFault extends Error {
  constructor(type, message, originalError) {
    super(message);
    this.name = 'DispatchFault';
    this.type = type;
    this.originalError = originalError || null;
    this.timestamp = Date.now();
  }
}

class Dispatcher {
  constructor(options) {
    const opts = options || {};
    this._state = DISPATCH_STATE.IDLE;
    this._faultHistory = [];
    this._handlers = {};
    this._maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : 3;
    this._retryDelayMs = opts.retryDelayMs !== undefined ? opts.retryDelayMs : 100;
  }

  get state() {
    return this._state;
  }

  get faultHistory() {
    return this._faultHistory.slice();
  }

  register(eventType, handler) {
    if (typeof eventType !== 'string' || !eventType) {
      throw new TypeError('eventType must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('handler must be a function');
    }
    this._handlers[eventType] = handler;
  }

  async dispatch(eventType, payload) {
    if (!this._handlers[eventType]) {
      throw new Error(`No handler registered for event type: ${eventType}`);
    }

    this._state = DISPATCH_STATE.RUNNING;
    let attempt = 0;

    while (attempt <= this._maxRetries) {
      try {
        const result = await this._handlers[eventType](payload);
        this._state = attempt > 0 ? DISPATCH_STATE.RECOVERED : DISPATCH_STATE.IDLE;
        return result;
      } catch (err) {
        const fault = new DispatchFault(
          this._classifyError(err),
          err.message,
          err
        );
        this._faultHistory.push(fault);
        this._state = DISPATCH_STATE.FAULTED;

        if (attempt < this._maxRetries) {
          this._state = DISPATCH_STATE.RECOVERING;
          await this._delay(this._retryDelayMs);
          attempt++;
        } else {
          throw fault;
        }
      }
    }
  }

  _classifyError(err) {
    if (!err) return FAULT_TYPES.CRASH;
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out')) return FAULT_TYPES.TIMEOUT;
    if (msg.includes('unavailable') || msg.includes('service')) return FAULT_TYPES.UNAVAILABLE;
    if (err instanceof TypeError || err instanceof RangeError) return FAULT_TYPES.CRASH;
    return FAULT_TYPES.REJECTION;
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  reset() {
    this._state = DISPATCH_STATE.IDLE;
    this._faultHistory = [];
  }
}

module.exports = { Dispatcher, DispatchFault, FAULT_TYPES, DISPATCH_STATE };
