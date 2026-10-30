// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migrateOnStart } from '../src/main.js';

describe('migrate on start', () => {
  it('does nothing unless OXYBOOK_MIGRATE_ON_START is true', async () => {
    assert.deepEqual(await migrateOnStart({}), []);
    assert.deepEqual(await migrateOnStart({ OXYBOOK_MIGRATE_ON_START: 'false' }), []);
  });

  it('refuses to start without DATABASE_URL when asked to migrate', async () => {
    await assert.rejects(
      migrateOnStart({ OXYBOOK_MIGRATE_ON_START: 'true' }),
      /DATABASE_URL is not set/,
    );
  });
});
