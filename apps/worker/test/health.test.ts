// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startHealthServer } from '../src/main.js';

describe('worker health', () => {
  it('answers /healthz', async () => {
    const server = await startHealthServer({ port: 0, host: '127.0.0.1', service: 'worker' });
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true, service: 'worker' });
    } finally {
      await server.close();
    }
  });
});
