'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Dispatcher, DispatchFault, FAULT_TYPES, DISPATCH_STATE } = require('../dispatch');

describe('Dispatcher', () => {
  let dispatcher;

  beforeEach(() => {
    dispatcher = new Dispatcher({ maxRetries: 2, retryDelayMs: 0 });
  });

  describe('register', () => {
    it('registers a handler for an event type', () => {
      dispatcher.register('ping', async () => 'pong');
      // no throw = registered
    });

    it('throws if eventType is not a string', () => {
      assert.throws(() => dispatcher.register(42, () => {}), TypeError);
    });

    it('throws if handler is not a function', () => {
      assert.throws(() => dispatcher.register('event', 'not-a-fn'), TypeError);
    });
  });

  describe('dispatch', () => {
    it('returns handler result on success', async () => {
      dispatcher.register('greet', async (payload) => `hello ${payload.name}`);
      const result = await dispatcher.dispatch('greet', { name: 'world' });
      assert.equal(result, 'hello world');
    });

    it('state is IDLE after successful dispatch', async () => {
      dispatcher.register('ok', async () => 'done');
      await dispatcher.dispatch('ok', {});
      assert.equal(dispatcher.state, DISPATCH_STATE.IDLE);
    });

    it('state is RECOVERED after retry succeeds', async () => {
      let attempts = 0;
      dispatcher.register('flaky', async () => {
        if (++attempts < 2) throw new Error('temporary failure');
        return 'ok';
      });
      await dispatcher.dispatch('flaky', {});
      assert.equal(dispatcher.state, DISPATCH_STATE.RECOVERED);
    });

    it('throws DispatchFault after max retries exceeded', async () => {
      dispatcher.register('always-fail', async () => {
        throw new Error('always fails');
      });
      await assert.rejects(
        () => dispatcher.dispatch('always-fail', {}),
        DispatchFault
      );
    });

    it('state is FAULTED after exhausted retries', async () => {
      dispatcher.register('broken', async () => {
        throw new Error('broken');
      });
      try {
        await dispatcher.dispatch('broken', {});
      } catch (_) {}
      assert.equal(dispatcher.state, DISPATCH_STATE.FAULTED);
    });

    it('records faults in history on failure', async () => {
      dispatcher.register('err', async () => {
        throw new Error('oops');
      });
      try {
        await dispatcher.dispatch('err', {});
      } catch (_) {}
      assert.ok(dispatcher.faultHistory.length > 0);
    });

    it('throws when no handler registered', async () => {
      await assert.rejects(
        () => dispatcher.dispatch('unknown', {}),
        /No handler registered/
      );
    });
  });

  describe('fault classification', () => {
    it('classifies timeout errors', async () => {
      dispatcher.register('slow', async () => {
        throw new Error('operation timed out');
      });
      try {
        await dispatcher.dispatch('slow', {});
      } catch (fault) {
        assert.equal(fault.type, FAULT_TYPES.TIMEOUT);
      }
    });

    it('classifies unavailable errors', async () => {
      dispatcher.register('down', async () => {
        throw new Error('service unavailable');
      });
      try {
        await dispatcher.dispatch('down', {});
      } catch (fault) {
        assert.equal(fault.type, FAULT_TYPES.UNAVAILABLE);
      }
    });

    it('classifies TypeError as crash', async () => {
      dispatcher.register('type-err', async () => {
        throw new TypeError('null dereference');
      });
      try {
        await dispatcher.dispatch('type-err', {});
      } catch (fault) {
        assert.equal(fault.type, FAULT_TYPES.CRASH);
      }
    });
  });

  describe('reset', () => {
    it('clears fault history and resets state', async () => {
      dispatcher.register('fail', async () => {
        throw new Error('fail');
      });
      try {
        await dispatcher.dispatch('fail', {});
      } catch (_) {}
      dispatcher.reset();
      assert.equal(dispatcher.state, DISPATCH_STATE.IDLE);
      assert.equal(dispatcher.faultHistory.length, 0);
    });
  });
});
