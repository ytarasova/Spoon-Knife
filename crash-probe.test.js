'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { CrashProbe } = require('./crash-probe.js');

describe('CrashProbe', () => {
  let probe;

  beforeEach(() => {
    probe = new CrashProbe();
  });

  describe('capture()', () => {
    test('returns a fault record with expected fields', () => {
      const record = probe.capture(new Error('boom'));
      assert.equal(typeof record.id, 'string');
      assert.match(record.id, /^[0-9a-f-]{36}$/);
      assert.equal(record.message, 'boom');
      assert.equal(typeof record.timestamp, 'string');
      assert.equal(record.release, 'unknown');
      assert.ok(record.stack);
    });

    test('accepts a plain string as the error argument', () => {
      const record = probe.capture('something went wrong');
      assert.equal(record.message, 'something went wrong');
    });

    test('merges supplied context into the record', () => {
      const record = probe.capture(new Error('ctx-test'), { userId: 42 });
      assert.equal(record.context.userId, 42);
    });

    test('includes configured release tag', () => {
      const p = new CrashProbe({ release: 'v1.2.3' });
      const record = p.capture(new Error('tagged'));
      assert.equal(record.release, 'v1.2.3');
    });
  });

  describe('drainQueue()', () => {
    test('returns buffered records and clears the internal queue', () => {
      probe.capture(new Error('first'));
      probe.capture(new Error('second'));
      const drained = probe.drainQueue();
      assert.equal(drained.length, 2);
      assert.equal(drained[0].message, 'first');
      assert.equal(drained[1].message, 'second');
      // After drain the queue is empty
      assert.equal(probe.drainQueue().length, 0);
    });
  });

  describe('maxQueue', () => {
    test('drops the oldest record when the queue is full', () => {
      const p = new CrashProbe({ maxQueue: 3 });
      p.capture(new Error('a'));
      p.capture(new Error('b'));
      p.capture(new Error('c'));
      p.capture(new Error('d')); // pushes 'a' out
      const records = p.drainQueue();
      assert.equal(records.length, 3);
      assert.equal(records[0].message, 'b');
      assert.equal(records[2].message, 'd');
    });
  });

  describe('onDispatch callback', () => {
    test('calls onDispatch for each captured fault', () => {
      const dispatched = [];
      const p = new CrashProbe({ onDispatch: (r) => dispatched.push(r) });
      p.capture(new Error('cb-test'));
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].message, 'cb-test');
    });

    test('swallows exceptions thrown inside onDispatch', () => {
      const p = new CrashProbe({
        onDispatch: () => { throw new Error('handler exploded'); },
      });
      // Must not throw
      assert.doesNotThrow(() => p.capture(new Error('trigger')));
    });
  });

  describe('install() / uninstall()', () => {
    test('install() is idempotent', () => {
      probe.install();
      probe.install(); // second call must not throw
      probe.uninstall();
    });

    test('uninstall() on a non-installed probe is a no-op', () => {
      assert.doesNotThrow(() => probe.uninstall());
    });

    test('installed flag toggles correctly', () => {
      assert.equal(probe._installed, false);
      probe.install();
      assert.equal(probe._installed, true);
      probe.uninstall();
      assert.equal(probe._installed, false);
    });
  });
});
