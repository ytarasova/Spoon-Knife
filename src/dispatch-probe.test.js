'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { DispatchProbe } = require('./dispatch-probe.js');

beforeEach(() => {
  DispatchProbe.resetSequence();
});

describe('DispatchProbe', () => {
  describe('wrap – synchronous faults', () => {
    it('re-propagates the original error', () => {
      const probe = new DispatchProbe();
      const boom = probe.wrap(() => { throw new TypeError('oops'); });
      assert.throws(() => boom(), { message: 'oops' });
    });

    it('calls registered handler with a snapshot', () => {
      const probe = new DispatchProbe();
      const snapshots = [];
      probe.onFault(s => snapshots.push(s));

      const fn = probe.wrap((x) => { throw new RangeError('bad range'); }, { label: 'myOp' });
      assert.throws(() => fn(42));

      assert.equal(snapshots.length, 1);
      const s = snapshots[0];
      assert.equal(s.label, 'myOp');
      assert.equal(s.error.name, 'RangeError');
      assert.equal(s.error.message, 'bad range');
      assert.deepEqual(s.args, [42]);
      assert.equal(s.seq, 1);
      assert.ok(typeof s.ts === 'number');
    });

    it('does not fire handler when function succeeds', () => {
      const probe = new DispatchProbe();
      let called = false;
      probe.onFault(() => { called = true; });

      const fn = probe.wrap((x) => x * 2);
      assert.equal(fn(5), 10);
      assert.equal(called, false);
    });

    it('increments seq per fault', () => {
      const probe = new DispatchProbe();
      const seqs = [];
      probe.onFault(s => seqs.push(s.seq));

      const fn = probe.wrap(() => { throw new Error('e'); });
      assert.throws(() => fn());
      assert.throws(() => fn());
      assert.deepEqual(seqs, [1, 2]);
    });

    it('passes meta into snapshot', () => {
      const probe = new DispatchProbe();
      const snapshots = [];
      probe.onFault(s => snapshots.push(s));

      const fn = probe.wrap(() => { throw new Error('x'); }, { label: 'op', service: 'auth' });
      assert.throws(() => fn());

      assert.equal(snapshots[0].meta.service, 'auth');
    });

    it('uses function name when label is not in meta', () => {
      const probe = new DispatchProbe();
      const snapshots = [];
      probe.onFault(s => snapshots.push(s));

      function namedFn() { throw new Error('e'); }
      const wrapped = probe.wrap(namedFn);
      assert.throws(() => wrapped());
      assert.equal(snapshots[0].label, 'namedFn');
    });

    it('unsubscribe stops further handler calls', () => {
      const probe = new DispatchProbe();
      let count = 0;
      const unsub = probe.onFault(() => count++);

      const fn = probe.wrap(() => { throw new Error('e'); });
      assert.throws(() => fn());
      unsub();
      assert.throws(() => fn());
      assert.equal(count, 1);
    });

    it('a throwing handler does not suppress the original error', () => {
      const probe = new DispatchProbe();
      probe.onFault(() => { throw new Error('handler explodes'); });

      const fn = probe.wrap(() => { throw new RangeError('real error'); });
      assert.throws(() => fn(), { name: 'RangeError', message: 'real error' });
    });

    it('multiple handlers all receive the snapshot', () => {
      const probe = new DispatchProbe();
      const received = [];
      probe.onFault(s => received.push('h1:' + s.seq));
      probe.onFault(s => received.push('h2:' + s.seq));

      const fn = probe.wrap(() => { throw new Error('e'); });
      assert.throws(() => fn());
      assert.deepEqual(received, ['h1:1', 'h2:1']);
    });

    it('serialises plain-object args safely', () => {
      const probe = new DispatchProbe();
      const snapshots = [];
      probe.onFault(s => snapshots.push(s));

      const fn = probe.wrap((obj) => { throw new Error('e'); });
      assert.throws(() => fn({ a: 1, b: [2, 3] }));
      assert.deepEqual(snapshots[0].args, [{ a: 1, b: [2, 3] }]);
    });

    it('serialises function args as "[Function]"', () => {
      const probe = new DispatchProbe();
      const snapshots = [];
      probe.onFault(s => snapshots.push(s));

      const fn = probe.wrap((cb) => { throw new Error('e'); });
      assert.throws(() => fn(() => {}));
      assert.deepEqual(snapshots[0].args, ['[Function]']);
    });
  });

  describe('wrapAsync – asynchronous faults', () => {
    it('re-propagates the rejection', async () => {
      const probe = new DispatchProbe();
      const fn = probe.wrapAsync(async () => { throw new TypeError('async oops'); });
      await assert.rejects(fn(), { message: 'async oops' });
    });

    it('calls handler on rejection', async () => {
      const probe = new DispatchProbe();
      const snapshots = [];
      probe.onFault(s => snapshots.push(s));

      const fn = probe.wrapAsync(async (x) => { throw new Error('async fail'); }, { label: 'asyncOp' });
      await assert.rejects(fn(99));

      assert.equal(snapshots.length, 1);
      const s = snapshots[0];
      assert.equal(s.label, 'asyncOp');
      assert.equal(s.error.message, 'async fail');
      assert.deepEqual(s.args, [99]);
    });

    it('does not fire handler on successful resolution', async () => {
      const probe = new DispatchProbe();
      let called = false;
      probe.onFault(() => { called = true; });

      const fn = probe.wrapAsync(async (x) => x + 1);
      const result = await fn(5);
      assert.equal(result, 6);
      assert.equal(called, false);
    });
  });

  describe('history', () => {
    it('records faults in history', () => {
      const probe = new DispatchProbe();
      const fn = probe.wrap(() => { throw new Error('e'); });
      assert.throws(() => fn());
      assert.throws(() => fn());

      const h = probe.history();
      assert.equal(h.length, 2);
      // most recent first
      assert.equal(h[0].seq, 2);
      assert.equal(h[1].seq, 1);
    });

    it('clearHistory empties the buffer', () => {
      const probe = new DispatchProbe();
      const fn = probe.wrap(() => { throw new Error('e'); });
      assert.throws(() => fn());
      probe.clearHistory();
      assert.equal(probe.history().length, 0);
    });

    it('caps history at maxHistory entries', () => {
      const probe = new DispatchProbe();
      probe._maxHistory = 3;
      const fn = probe.wrap(() => { throw new Error('e'); });
      for (let i = 0; i < 5; i++) assert.throws(() => fn());
      assert.equal(probe.history().length, 3);
    });
  });

  describe('constructor guards', () => {
    it('wrap throws when target is not a function', () => {
      const probe = new DispatchProbe();
      assert.throws(() => probe.wrap('not a fn'), { message: /function/ });
    });

    it('wrapAsync throws when target is not a function', () => {
      const probe = new DispatchProbe();
      assert.throws(() => probe.wrapAsync(42), { message: /function/ });
    });

    it('onFault throws when handler is not a function', () => {
      const probe = new DispatchProbe();
      assert.throws(() => probe.onFault('nope'), { message: /function/ });
    });
  });
});
