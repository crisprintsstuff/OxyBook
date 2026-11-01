// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { sha256Hex } from '../src/sha256.js';

const node = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('matches node:crypto on edge lengths and Unicode', () => {
    for (const text of [
      '',
      'abc',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(64),
      'é漢🙂\r\n',
      'x'.repeat(100_000),
    ])
      assert.equal(sha256Hex(text), node(text));
  });

  it('matches node:crypto on random strings', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 300 }),
        (text) => sha256Hex(text) === node(text),
      ),
      { numRuns: 500 },
    );
  });
});
