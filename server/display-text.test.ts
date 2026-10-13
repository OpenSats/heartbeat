import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayText } from './display-text.js';

test('truncates emoji at a code point boundary', () => {
  const text = 'x'.repeat(999) + '🧡suffix';
  assert.equal(displayText(text, 1000), 'x'.repeat(999) + '🧡');
  assert.equal(displayText('🧡hello', 1), '🧡');
});

test('makes derived text valid for PostgreSQL JSON without altering its source', () => {
  const event = { content: 'a\u0000b\uD800c\uDC00d🧡' };
  assert.equal(displayText(event.content, 100), 'ab�c�d🧡');
  assert.equal(event.content, 'a\u0000b\uD800c\uDC00d🧡');
});
