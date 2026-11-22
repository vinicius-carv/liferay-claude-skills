import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigFile, checkConfigFileName, checkWorkspace } from '../skills/liferay-config-check/scripts/check-config.mjs';

test('parseConfigFile typed values', () => {
  const r = parseConfigFile('a="x"\nb=I"2"\nc=["p","q"]');
  assert.equal(r.errors.length, 0);
  assert.equal(r.values.b, 'I"2"');
});

test('parseConfigFile unquoted value', () => {
  const r = parseConfigFile('a=x');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 1);
});

test('checkConfigFileName', () => {
  assert.equal(checkConfigFileName('com.x.Y~one.config').kind, 'factory');
  assert.equal(checkConfigFileName('com.x.Y-one.config').kind, 'legacy-factory');
  assert.equal(checkConfigFileName('com.x.Y.cfg').kind, 'cfg');
  assert.equal(checkConfigFileName('com.x.Y.config').kind, 'single');
  assert.equal(checkConfigFileName('bad name.config').kind, 'invalid');
});

test('ws-good has no errors', async () => {
  const f = await checkWorkspace('test/fixtures/ws-good', { probe: async () => true });
  assert.deepEqual(f.filter((x) => x.severity === 'error'), []);
});

test('ws-broken findings', async () => {
  const f = await checkWorkspace('test/fixtures/ws-broken', { probe: async () => false });
  const has = (sev, re) => f.some((x) => x.severity === sev && re.test(x.message));
  assert.ok(has('error', /must be quoted/));
  assert.ok(has('error', /invalid/i));
  assert.ok(has('error', /unreachable/i));
  assert.ok(has('warn', /duplicate/i));
});
