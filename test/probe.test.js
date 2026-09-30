'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Dispatcher, DISPATCH_STATE } = require('../dispatch');
const { PostFaultProbe } = require('../probe');

describe('PostFaultProbe', () => {
  let dispatcher;
  let probe;

  beforeEach(() => {
    dispatcher = new Dispatcher({ maxRetries: 1, retryDelayMs: 0 });
    probe = new PostFaultProbe(dispatcher);
  });

  it('throws if not given a Dispatcher', () => {
    assert.throws(() => new PostFaultProbe({}), TypeError);
    assert.throws(() => new PostFaultProbe(null), TypeError);
  });

  describe('run()', () => {
    it('returns healthy=true for a clean dispatcher', async () => {
      const result = await probe.run();
      assert.equal(result.healthy, true);
      assert.equal(result.dispatcherState, DISPATCH_STATE.IDLE);
      assert.equal(result.faultCount, 0);
      assert.equal(result.faultSummary, null);
    });

    it('returns healthy=false when dispatcher is in FAULTED state', async () => {
      dispatcher.register('fail', async () => {
        throw new Error('boom');
      });
      try {
        await dispatcher.dispatch('fail', {});
      } catch (_) {}

      const result = await probe.run();
      assert.equal(result.healthy, false);
      assert.equal(result.dispatcherState, DISPATCH_STATE.FAULTED);
    });

    it('reports fault count correctly after failures', async () => {
      dispatcher.register('fail', async () => {
        throw new Error('error');
      });
      try {
        await dispatcher.dispatch('fail', {});
      } catch (_) {}

      const result = await probe.run();
      assert.ok(result.faultCount > 0);
      assert.ok(result.faultSummary !== null);
    });

    it('returns healthy=true after dispatcher is reset', async () => {
      dispatcher.register('fail', async () => {
        throw new Error('crash');
      });
      try {
        await dispatcher.dispatch('fail', {});
      } catch (_) {}

      dispatcher.reset();
      const result = await probe.run();
      assert.equal(result.healthy, true);
    });

    it('accumulates results across multiple runs', async () => {
      await probe.run();
      await probe.run();
      assert.equal(probe.results.length, 2);
    });

    it('includes all required check fields', async () => {
      const result = await probe.run();
      assert.ok('stateIsRecoverable' in result.checks);
      assert.ok('noUnresolvedFaults' in result.checks);
      assert.ok('dispatcherResponsive' in result.checks);
    });

    it('dispatcherResponsive check passes for new dispatcher', async () => {
      const result = await probe.run();
      assert.equal(result.checks.dispatcherResponsive, true);
    });

    it('healthy=false when CRASH fault type is present', async () => {
      dispatcher.register('type-err', async () => {
        throw new TypeError('null ref');
      });
      try {
        await dispatcher.dispatch('type-err', {});
      } catch (_) {}

      const result = await probe.run();
      assert.equal(result.checks.noUnresolvedFaults, false);
    });
  });
});
