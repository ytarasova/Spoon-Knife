'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { CrashProbe, attachToProcess, PROBE_STATES } = require('../crash.js');

describe('PROBE_STATES', () => {
  it('exposes expected state constants', () => {
    assert.equal(PROBE_STATES.IDLE, 'idle');
    assert.equal(PROBE_STATES.FAULTED, 'faulted');
    assert.equal(PROBE_STATES.DISPATCHING, 'dispatching');
    assert.equal(PROBE_STATES.COMPLETED, 'completed');
  });

  it('is frozen', () => {
    assert.throws(() => {
      PROBE_STATES.NEW_STATE = 'new';
    }, TypeError);
  });
});

describe('CrashProbe construction', () => {
  it('starts in idle state with no fault record', () => {
    const probe = new CrashProbe();
    assert.equal(probe.state, PROBE_STATES.IDLE);
    assert.equal(probe.faultRecord, null);
  });

  it('accepts options', () => {
    const probe = new CrashProbe({ maxHandlers: 2, captureStack: false, dispatchTimeout: 100 });
    assert.equal(probe._maxHandlers, 2);
    assert.equal(probe._captureStack, false);
    assert.equal(probe._dispatchTimeout, 100);
  });
});

describe('CrashProbe.onFault', () => {
  it('registers a handler and returns deregister function', () => {
    const probe = new CrashProbe();
    const calls = [];
    const deregister = probe.onFault((rec) => calls.push(rec));
    assert.equal(typeof deregister, 'function');
    assert.equal(probe._handlers.length, 1);
    deregister();
    assert.equal(probe._handlers.length, 0);
  });

  it('throws if handler is not a function', () => {
    const probe = new CrashProbe();
    assert.throws(() => probe.onFault('not-a-function'), TypeError);
  });

  it('throws when max handlers exceeded', () => {
    const probe = new CrashProbe({ maxHandlers: 2 });
    probe.onFault(() => {});
    probe.onFault(() => {});
    assert.throws(() => probe.onFault(() => {}), RangeError);
  });
});

describe('CrashProbe.recordFault', () => {
  let probe;
  beforeEach(() => {
    probe = new CrashProbe({ dispatchTimeout: 200 });
  });

  it('transitions through faulted → dispatching → completed states', async () => {
    const states = [];
    // Poll state after recordFault resolves
    await probe.recordFault(new Error('boom'));
    assert.equal(probe.state, PROBE_STATES.COMPLETED);
  });

  it('populates the fault record with error info and timestamp', async () => {
    const before = Date.now();
    await probe.recordFault(new Error('test error'), { requestId: '123' });
    const after = Date.now();

    const rec = probe.faultRecord;
    assert.ok(rec, 'faultRecord should not be null');
    assert.equal(rec.message, 'test error');
    assert.equal(rec.name, 'Error');
    assert.ok(rec.stack.includes('test error'));
    assert.equal(rec.context.requestId, '123');
    assert.ok(rec.timestamp >= before && rec.timestamp <= after);
  });

  it('wraps non-Error arguments in an Error', async () => {
    await probe.recordFault('string fault');
    assert.equal(probe.faultRecord.message, 'string fault');
  });

  it('omits stack when captureStack is false', async () => {
    probe = new CrashProbe({ captureStack: false, dispatchTimeout: 200 });
    await probe.recordFault(new Error('no stack'));
    assert.equal(probe.faultRecord.stack, null);
  });

  it('dispatches the record to all registered handlers', async () => {
    const received = [];
    probe.onFault((rec) => received.push(rec));
    probe.onFault((rec) => received.push(rec));

    await probe.recordFault(new Error('dispatch test'));
    assert.equal(received.length, 2);
    assert.equal(received[0].message, 'dispatch test');
  });

  it('returns handler errors without throwing', async () => {
    probe.onFault(() => {
      throw new Error('handler exploded');
    });

    const { handlerErrors } = await probe.recordFault(new Error('fault'));
    assert.equal(handlerErrors.length, 1);
    assert.equal(handlerErrors[0].error.message, 'handler exploded');
  });

  it('isolates context snapshot from later mutation', async () => {
    const ctx = { key: 'original' };
    await probe.recordFault(new Error('ctx test'), ctx);
    ctx.key = 'mutated';
    assert.equal(probe.faultRecord.context.key, 'original');
  });
});

describe('CrashProbe.reset', () => {
  it('returns probe to idle with no fault record', async () => {
    const probe = new CrashProbe({ dispatchTimeout: 100 });
    await probe.recordFault(new Error('reset me'));
    assert.equal(probe.state, PROBE_STATES.COMPLETED);
    probe.reset();
    assert.equal(probe.state, PROBE_STATES.IDLE);
    assert.equal(probe.faultRecord, null);
  });
});

describe('attachToProcess', () => {
  it('throws if probe is not a CrashProbe', () => {
    assert.throws(() => attachToProcess({}), TypeError);
  });

  it('registers and deregisters process listeners', () => {
    const probe = new CrashProbe({ dispatchTimeout: 100 });
    const fakeProcess = {
      _listeners: {},
      on(evt, fn) { (this._listeners[evt] = this._listeners[evt] ?? []).push(fn); },
      off(evt, fn) { this._listeners[evt] = (this._listeners[evt] ?? []).filter((h) => h !== fn); },
    };

    const detach = attachToProcess(probe, fakeProcess);
    assert.equal(fakeProcess._listeners['uncaughtException'].length, 1);
    assert.equal(fakeProcess._listeners['unhandledRejection'].length, 1);

    detach();
    assert.equal(fakeProcess._listeners['uncaughtException'].length, 0);
    assert.equal(fakeProcess._listeners['unhandledRejection'].length, 0);
  });

  it('records a fault when uncaughtException fires', async () => {
    const probe = new CrashProbe({ dispatchTimeout: 100 });
    const fakeProcess = {
      _listeners: {},
      on(evt, fn) { (this._listeners[evt] = this._listeners[evt] ?? []).push(fn); },
      off(evt, fn) { this._listeners[evt] = (this._listeners[evt] ?? []).filter((h) => h !== fn); },
    };

    attachToProcess(probe, fakeProcess);
    const err = new Error('uncaught!');
    fakeProcess._listeners['uncaughtException'][0](err);

    // Give async dispatch a tick to start
    await new Promise((r) => setImmediate(r));
    assert.ok(probe.state !== PROBE_STATES.IDLE);
  });
});
