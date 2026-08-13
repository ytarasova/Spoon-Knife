import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AutoGate, createCheck } from '../../src/autoGate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const alwaysPass = createCheck('always-pass', async () => true);
const alwaysFail = createCheck('always-fail', async () => false);
const alwaysThrow = createCheck('always-throw', async () => {
  throw new Error('check exploded');
});

// ---------------------------------------------------------------------------
// FAILED flow — the primary focus of PAI-43216
// ---------------------------------------------------------------------------

describe('AutoGate — FAILED flow', () => {
  test('status is FAIL when all checks return false', async () => {
    const gate = new AutoGate('all-fail-gate');
    gate.addCheck(alwaysFail);

    const result = await gate.evaluate({});

    assert.equal(result.status, 'FAIL');
    assert.equal(result.gateName, 'all-fail-gate');
    assert.equal(result.failed.length, 1);
    assert.equal(result.passed.length, 0);
  });

  test('status is FAIL when at least one check returns false', async () => {
    const gate = new AutoGate('partial-fail-gate');
    gate.addCheck(alwaysPass);
    gate.addCheck(alwaysFail);

    const result = await gate.evaluate({});

    assert.equal(result.status, 'FAIL');
    assert.equal(result.failed.length, 1);
    assert.equal(result.passed.length, 1);
    assert.equal(result.failed[0].name, 'always-fail');
    assert.equal(result.passed[0].name, 'always-pass');
  });

  test('status is FAIL when a check throws', async () => {
    const gate = new AutoGate('throw-gate');
    gate.addCheck(alwaysThrow);

    const result = await gate.evaluate({});

    assert.equal(result.status, 'FAIL');
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].error, 'check exploded');
    assert.equal(result.failed[0].passed, false);
  });

  test('failed result includes the check name for every failing check', async () => {
    const gate = new AutoGate('multi-fail-gate');
    gate
      .addCheck(createCheck('check-a', async () => false))
      .addCheck(createCheck('check-b', async () => false))
      .addCheck(createCheck('check-c', async () => true));

    const result = await gate.evaluate({});

    assert.equal(result.status, 'FAIL');
    const failedNames = result.failed.map((f) => f.name);
    assert.deepEqual(failedNames, ['check-a', 'check-b']);
    assert.equal(result.passed[0].name, 'check-c');
  });

  test('results array contains an entry for every check regardless of outcome', async () => {
    const gate = new AutoGate('mixed-gate');
    gate.addCheck(alwaysPass);
    gate.addCheck(alwaysFail);
    gate.addCheck(alwaysThrow);

    const result = await gate.evaluate({});

    assert.equal(result.results.length, 3);
    assert.equal(result.status, 'FAIL');
  });

  test('FAILED gate passes context to each check', async () => {
    const received = [];
    const contextCheck = createCheck('context-check', async (ctx) => {
      received.push(ctx);
      return false; // deliberately fail
    });

    const gate = new AutoGate('context-gate');
    gate.addCheck(contextCheck);

    const ctx = { prId: 'PAI-43216', branch: 'main' };
    const result = await gate.evaluate(ctx);

    assert.equal(result.status, 'FAIL');
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], ctx);
  });

  test('async check failure is captured correctly', async () => {
    const asyncFailCheck = createCheck('async-fail', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return false;
    });

    const gate = new AutoGate('async-gate');
    gate.addCheck(asyncFailCheck);

    const result = await gate.evaluate({});

    assert.equal(result.status, 'FAIL');
    assert.equal(result.failed[0].name, 'async-fail');
    assert.equal(result.failed[0].error, null);
  });

  test('multiple async checks all fail independently', async () => {
    const makeDelayedFail = (name, ms) =>
      createCheck(name, async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return false;
      });

    const gate = new AutoGate('concurrent-fail-gate');
    gate
      .addCheck(makeDelayedFail('slow-check', 20))
      .addCheck(makeDelayedFail('fast-check', 5));

    const result = await gate.evaluate({});

    assert.equal(result.status, 'FAIL');
    assert.equal(result.failed.length, 2);
  });
});

// ---------------------------------------------------------------------------
// PASS flow — baseline to confirm the gate itself isn't broken
// ---------------------------------------------------------------------------

describe('AutoGate — PASS flow (baseline)', () => {
  test('status is PASS when all checks succeed', async () => {
    const gate = new AutoGate('pass-gate');
    gate.addCheck(alwaysPass);

    const result = await gate.evaluate({});

    assert.equal(result.status, 'PASS');
    assert.equal(result.passed.length, 1);
    assert.equal(result.failed.length, 0);
  });

  test('status is PASS when there are no checks', async () => {
    const gate = new AutoGate('empty-gate');

    const result = await gate.evaluate({});

    assert.equal(result.status, 'PASS');
    assert.equal(result.results.length, 0);
  });

  test('gateName is preserved in the result', async () => {
    const gate = new AutoGate('my-named-gate');
    gate.addCheck(alwaysPass);

    const result = await gate.evaluate({});

    assert.equal(result.gateName, 'my-named-gate');
  });
});
