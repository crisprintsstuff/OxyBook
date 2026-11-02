// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appendRedirect, ConfigEditError } from '../src/index.js';

describe('appendRedirect', () => {
  it('creates the file, or the key, when missing', () => {
    assert.equal(appendRedirect(null, '/a', '/b'), 'redirects:\n  - from: /a\n    to: /b\n');
    assert.equal(
      appendRedirect('# site config\nstrict: true', '/a', '/b'),
      '# site config\nstrict: true\nredirects:\n  - from: /a\n    to: /b\n',
    );
  });

  it('appends to an existing list at its indentation, touching no other byte', () => {
    const source =
      '# OxyBook\nredirects:   # moved pages\n    - from: /old\n      to: "/new"   # quoted on purpose\nexclude:\n  - drafts/**\n';
    const out = appendRedirect(source, '/guides/install', '/guides/setup');
    assert.equal(
      out,
      '# OxyBook\nredirects:   # moved pages\n    - from: /old\n      to: "/new"   # quoted on purpose\n    - from: /guides/install\n      to: /guides/setup\nexclude:\n  - drafts/**\n',
    );
  });

  it('fills an empty key, keeps CRLF, and quotes odd values', () => {
    assert.equal(
      appendRedirect('redirects:\r\nstrict: true\r\n', '/a b', '/c: d'),
      'redirects:\r\n  - from: "/a b"\r\n    to: "/c: d"\r\nstrict: true\r\n',
    );
  });

  it('refuses what it cannot edit in place', () => {
    assert.throws(
      () => appendRedirect('redirects: [{from: /a, to: /b}]\n', '/x', '/y'),
      ConfigEditError,
    );
    assert.throws(() => appendRedirect('redirects: [\n', '/x', '/y'), ConfigEditError);
    assert.throws(() => appendRedirect('- a\n- b\n', '/x', '/y'), ConfigEditError);
  });
});
