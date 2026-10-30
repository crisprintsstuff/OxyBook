// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { describe, it } from 'node:test';
import { sql } from 'kysely';
import { createDb, describeDatabaseUrl } from '../src/connect.js';

describe('createDb', () => {
  it('gives up on a port that accepts TCP and never answers', async () => {
    const held: Socket[] = [];
    const silent = createServer((socket) => held.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const address = silent.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const db = createDb(`postgres://u:p@127.0.0.1:${address.port}/x`, { connectTimeoutMs: 300 });
    const started = Date.now();
    try {
      await assert.rejects(sql`select 1`.execute(db), /timeout/i);
      assert.ok(Date.now() - started < 5_000);
    } finally {
      await db.destroy();
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it('describes a connection string without its password', () => {
    assert.equal(
      describeDatabaseUrl('postgres://oxybook:secret@127.0.0.1:5432/oxybook'),
      '127.0.0.1:5432/oxybook',
    );
    assert.equal(describeDatabaseUrl('not a url'), 'DATABASE_URL');
  });
});
