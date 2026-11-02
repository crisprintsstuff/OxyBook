// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseVersions } from '../src/versions.js';

describe('parseVersions', () => {
  it('reads name and ref, keeps order, and marks the default', () => {
    const { entries, problems } = parseVersions(
      Buffer.from(
        'title: T\nversions:\n  - name: latest\n    ref: main\n    default: true\n  - name: 1.x\n    ref: release/1.x\n  - name: 0.9\n    ref: v0.9.0\n',
      ),
    );
    assert.deepEqual(entries, [
      { name: 'latest', ref: 'main', default: true },
      { name: '1.x', ref: 'release/1.x', default: false },
      { name: '0.9', ref: 'v0.9.0', default: false },
    ]);
    assert.deepEqual(problems, []);
  });

  it('is empty without a file or a versions: key', () => {
    assert.deepEqual(parseVersions(null), { entries: [], problems: [] });
    assert.deepEqual(parseVersions(Buffer.from('title: T\n')), { entries: [], problems: [] });
  });

  it('skips malformed and duplicate entries with a reason, and refuses a non-list', () => {
    const { entries, problems } = parseVersions(
      Buffer.from(
        'versions:\n  - name: ok\n    ref: main\n  - name: ../up\n    ref: x\n  - name: noref\n  - name: ok\n    ref: other\n',
      ),
    );
    assert.deepEqual(
      entries.map((e) => e.name),
      ['ok'],
    );
    assert.equal(problems.length, 3);
    assert.deepEqual(parseVersions(Buffer.from('versions: main\n')).problems, [
      'versions: is not a list',
    ]);
    assert.deepEqual(parseVersions(Buffer.from('versions: [\n')).problems, [
      'oxybook.yml does not parse',
    ]);
  });
});
