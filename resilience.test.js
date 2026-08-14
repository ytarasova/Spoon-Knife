'use strict';

const assert = require('assert');
const { Checkpoint, withRollAfter, rollingWithCheckpoints } = require('./resilience');

// Minimal test runner (no external deps)
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

function eq(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e} but got ${a}`);
}

// --- Checkpoint ---

await test('Checkpoint: save and restore returns deep copy', async () => {
  const cp = new Checkpoint('cp1');
  const state = { x: 1, nested: { y: 2 } };
  cp.save(state);
  const restored = cp.restore();
  eq(restored, state);
  // mutation of original does not affect checkpoint
  state.x = 99;
  eq(cp.restore().x, 1);
});

await test('Checkpoint: hasState returns false before save', async () => {
  const cp = new Checkpoint('empty');
  eq(cp.hasState(), false);
  cp.save({ v: 0 });
  eq(cp.hasState(), true);
});

await test('Checkpoint: restore throws when no state', async () => {
  const cp = new Checkpoint('empty');
  try {
    cp.restore();
    throw new Error('should have thrown');
  } catch (err) {
    if (!err.message.includes('no saved state')) throw err;
  }
});

// --- withRollAfter ---

await test('withRollAfter: saves checkpoint after success (roll:after)', async () => {
  const cp = new Checkpoint('op');
  const { result } = await withRollAfter(cp, async () => ({ value: 42 }));
  eq(result, { value: 42 });
  eq(cp.hasState(), true);
  eq(cp.restore(), { value: 42 });
});

await test('withRollAfter: no checkpoint saved on failure', async () => {
  const cp = new Checkpoint('op');
  try {
    await withRollAfter(cp, async () => { throw new Error('boom'); });
  } catch (_) {}
  eq(cp.hasState(), false);
});

await test('withRollAfter: calls onRollback with prior checkpoint state', async () => {
  const cp = new Checkpoint('op');
  cp.save({ v: 'good' });

  let rollbackState = null;
  try {
    await withRollAfter(cp, async () => { throw new Error('fail'); }, {
      onRollback: (state) => { rollbackState = state; },
    });
  } catch (_) {}

  eq(rollbackState, { v: 'good' });
});

await test('withRollAfter: retries on failure', async () => {
  let calls = 0;
  const cp = new Checkpoint('retry');
  const { result } = await withRollAfter(cp, async () => {
    calls++;
    if (calls < 3) throw new Error('not yet');
    return { ok: true };
  }, { retries: 5 });

  eq(calls, 3);
  eq(result, { ok: true });
});

await test('withRollAfter: error includes rolledBackState when checkpoint exists', async () => {
  const cp = new Checkpoint('op');
  cp.save({ saved: true });

  let thrown = null;
  try {
    await withRollAfter(cp, async () => { throw new Error('fail'); });
  } catch (err) {
    thrown = err;
  }

  eq(thrown.rolledBackState, { saved: true });
});

// --- rollingWithCheckpoints ---

await test('rollingWithCheckpoints: runs all steps and checkpoints each', async () => {
  const results = [];
  const { completed, lastCheckpoint } = await rollingWithCheckpoints([
    { name: 'step-a', run: async () => { results.push('a'); return { step: 'a' }; } },
    { name: 'step-b', run: async () => { results.push('b'); return { step: 'b' }; } },
    { name: 'step-c', run: async () => { results.push('c'); return { step: 'c' }; } },
  ]);

  eq(results, ['a', 'b', 'c']);
  eq(completed, ['step-a', 'step-b', 'step-c']);
  eq(lastCheckpoint.restore(), { step: 'c' });
});

await test('rollingWithCheckpoints: stops at first failing step', async () => {
  const ran = [];
  try {
    await rollingWithCheckpoints([
      { name: 'ok', run: async () => { ran.push('ok'); return {}; } },
      { name: 'fail', run: async () => { ran.push('fail'); throw new Error('fail'); } },
      { name: 'never', run: async () => { ran.push('never'); return {}; } },
    ]);
  } catch (_) {}

  eq(ran, ['ok', 'fail']);
});

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
