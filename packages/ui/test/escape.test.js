import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, escapeAttr } from '../src/escape.js';

test('escapeHtml neutralizes element-context injection', () => {
  assert.equal(
    escapeHtml('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
});

test('REGRESSION #6: escapeAttr also escapes quotes (attribute breakout)', () => {
  // The old esc() left quotes intact, allowing `x" onmouseover="..."` to break
  // out of a double-quoted attribute. escapeAttr closes that.
  assert.equal(escapeAttr('x" onmouseover="alert(1)'),
    'x&quot; onmouseover=&quot;alert(1)');
  assert.equal(escapeAttr("y' onclick='x"), 'y&#39; onclick=&#39;x');
});

test('null/undefined render as empty string', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeAttr(undefined), '');
});
