import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(`../.claude-plugin/${p}`, import.meta.url), 'utf8'));

test('plugin and marketplace manifests agree on the plugin name', () => {
  assert.equal(read('plugin.json').name, read('marketplace.json').plugins[0].name);
});
