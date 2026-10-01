'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DispatchProbe } = require('../src/dispatch-probe.js');

describe('DispatchProbe', () => {
  describe('register()', () => {
    test('throws on empty name', () => {
      const probe = new DispatchProbe();
      assert.throws(() => probe.register('', () => {}), TypeError);
    });

    test('throws on non-string name', () => {
      const probe = new DispatchProbe();
      assert.throws(() => probe.register(42, () => {}), TypeError);
    });

    test('throws on non-function handler', () => {
      const probe = new DispatchProbe();
      assert.throws(() => probe.register('health', 'not-a-fn'), TypeError);
    });

    test('accepts a valid name and function', () => {
      const probe = new DispatchProbe();
      assert.doesNotThrow(() => probe.register('health', () => true));
    });

    test('overwrites previously registered probe with same name', async () => {
      const probe = new DispatchProbe();
      probe.register('check', () => 'first');
      probe.register('check', () => 'second');
      const record = await probe.dispatch({ code: 'ERR_TEST' });
      assert.equal(record.probeResults[0].value, 'second');
    });
  });

  describe('dispatch()', () => {
    test('returns a fault record with timestamp and empty probeResults when no probes registered', async () => {
      const probe = new DispatchProbe();
      const fault = { code: 'ERR_SEGFAULT', pid: 42 };
      const record = await probe.dispatch(fault);
      assert.deepEqual(record.fault, fault);
      assert.equal(typeof record.timestamp, 'number');
      assert.deepEqual(record.probeResults, []);
    });

    test('dispatches registered probe with the fault object', async () => {
      const probe = new DispatchProbe();
      const captured = [];
      probe.register('capture', (f) => { captured.push(f); return 'ok'; });
      const fault = { code: 'ERR_OOM' };
      await probe.dispatch(fault);
      assert.deepEqual(captured, [fault]);
    });

    test('probe result contains name, status ok, and returned value', async () => {
      const probe = new DispatchProbe();
      probe.register('ping', () => ({ alive: true }));
      const record = await probe.dispatch({ code: 'ERR_CRASH' });
      const result = record.probeResults[0];
      assert.equal(result.name, 'ping');
      assert.equal(result.status, 'ok');
      assert.deepEqual(result.value, { alive: true });
      assert.equal(typeof result.duration, 'number');
    });

    test('dispatches multiple probes in registration order', async () => {
      const probe = new DispatchProbe();
      const order = [];
      probe.register('a', () => order.push('a'));
      probe.register('b', () => order.push('b'));
      probe.register('c', () => order.push('c'));
      await probe.dispatch({});
      assert.deepEqual(order, ['a', 'b', 'c']);
    });

    test('catches synchronous probe errors and records status error', async () => {
      const probe = new DispatchProbe();
      probe.register('boom', () => { throw new Error('subsystem down'); });
      const record = await probe.dispatch({ code: 'ERR_FATAL' });
      const result = record.probeResults[0];
      assert.equal(result.status, 'error');
      assert.equal(result.error, 'subsystem down');
    });

    test('catches asynchronous probe rejections and records status error', async () => {
      const probe = new DispatchProbe();
      probe.register('async-fail', async () => { throw new Error('async boom'); });
      const record = await probe.dispatch({});
      assert.equal(record.probeResults[0].status, 'error');
      assert.equal(record.probeResults[0].error, 'async boom');
    });

    test('one failing probe does not block subsequent probes', async () => {
      const probe = new DispatchProbe();
      probe.register('bad', () => { throw new Error('bad'); });
      probe.register('good', () => 'still ran');
      const record = await probe.dispatch({});
      assert.equal(record.probeResults[0].status, 'error');
      assert.equal(record.probeResults[1].status, 'ok');
      assert.equal(record.probeResults[1].value, 'still ran');
    });

    test('supports async probes', async () => {
      const probe = new DispatchProbe();
      probe.register('async-ok', async () => {
        await new Promise((r) => setImmediate(r));
        return 'async value';
      });
      const record = await probe.dispatch({});
      assert.equal(record.probeResults[0].status, 'ok');
      assert.equal(record.probeResults[0].value, 'async value');
    });

    test('times out a probe that takes too long', async () => {
      const probe = new DispatchProbe({ probeTimeout: 50 });
      probe.register('slow', () => new Promise((r) => setTimeout(r, 200)));
      const record = await probe.dispatch({});
      const result = record.probeResults[0];
      assert.equal(result.status, 'error');
      assert.match(result.error, /timed out/);
    });

    test('appends to fault log on each dispatch call', async () => {
      const probe = new DispatchProbe();
      await probe.dispatch({ code: 'ERR_1' });
      await probe.dispatch({ code: 'ERR_2' });
      assert.equal(probe.faultLog.length, 2);
      assert.equal(probe.faultLog[0].fault.code, 'ERR_1');
      assert.equal(probe.faultLog[1].fault.code, 'ERR_2');
    });
  });

  describe('faultLog', () => {
    test('returns a copy so mutations do not affect internal state', async () => {
      const probe = new DispatchProbe();
      await probe.dispatch({});
      const log = probe.faultLog;
      log.push({ fake: true });
      assert.equal(probe.faultLog.length, 1);
    });
  });

  describe('clearFaultLog()', () => {
    test('empties the fault log', async () => {
      const probe = new DispatchProbe();
      await probe.dispatch({});
      probe.clearFaultLog();
      assert.equal(probe.faultLog.length, 0);
    });
  });

  describe('unregister()', () => {
    test('removes a probe so it no longer runs on dispatch', async () => {
      const probe = new DispatchProbe();
      probe.register('removed', () => 'should not appear');
      probe.unregister('removed');
      const record = await probe.dispatch({});
      assert.equal(record.probeResults.length, 0);
    });

    test('is a no-op for unknown names', () => {
      const probe = new DispatchProbe();
      assert.doesNotThrow(() => probe.unregister('nonexistent'));
    });
  });
});
