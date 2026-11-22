import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProperties, readWorkspace } from '../lib/workspace.mjs';

test('continuation yields one entry, no duplicate', () => {
  const r = parseProperties('a=b \\\n   c\n');
  assert.equal(r.entries.get('a'), 'b c');
  assert.equal(r.duplicates.length, 0);
});

test('CRLF equals LF', () => {
  const lf = '# c\na=1\nb: 2\n! x\nc = 3 \\\n 4\n';
  assert.deepEqual([...parseProperties(lf.replace(/\n/g, '\r\n')).entries], [...parseProperties(lf).entries]);
});

test('duplicates report both lines', () => {
  const r = parseProperties('a=1\nb=2\na=3\n');
  assert.deepEqual(r.duplicates, [{ key: 'a', lines: [1, 3] }]);
});

test('readWorkspace: local override and defaults', () => {
  assert.equal(readWorkspace('test/fixtures/ws-broken').product, 'dxp-2025.q1.23-lts');
  const g = readWorkspace('test/fixtures/ws-good');
  assert.equal(g.environment, 'local');
  assert.equal(g.isWorkspace, true);
  assert.equal(readWorkspace('test/fixtures').isWorkspace, false);
});

test('parseProperties unescapes keys and values', () => {
  const b = String.fromCharCode(92);
  const text = [
    `jdbc.default.url=jdbc${b}:mysql${b}://db${b}:3306/x`,
    `k${b}=ey=a${b}${b}b${b}tc${b}u0041`,
  ].join('\n');
  const r = parseProperties(text);
  assert.equal(r.entries.get('jdbc.default.url'), 'jdbc:mysql://db:3306/x');
  assert.equal(r.entries.get('k=ey'), `a${b}b\tcA`);
});
