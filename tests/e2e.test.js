import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

test('index.html exists', () => {
  assert.ok(existsSync(join(root, 'index.html')), 'index.html should exist');
});

test('index.html contains expected content', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('<html>'), 'should be an HTML document');
  assert.ok(html.includes('Spoon-Knife'), 'should contain project name');
  assert.ok(html.includes('styles.css'), 'should link to stylesheet');
});

test('styles.css exists', () => {
  assert.ok(existsSync(join(root, 'styles.css')), 'styles.css should exist');
});

test('styles.css contains expected styles', () => {
  const css = readFileSync(join(root, 'styles.css'), 'utf8');
  assert.ok(css.includes('#octocat'), 'should style the octocat element');
  assert.ok(css.includes('margin'), 'should define margins');
});

test('README.md exists', () => {
  assert.ok(existsSync(join(root, 'README.md')), 'README.md should exist');
});

test('README.md describes forking', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.ok(readme.toLowerCase().includes('fork'), 'README should mention forking');
});
