// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { InstallationTokenCache } from '../src/installation-token.js';
import { readAppJwtClaims, signAppJwt, verifyAppJwt } from '../src/jwt.js';
import { verifyWebhookSignature } from '../src/webhook.js';

const webhookBody = readFileSync(new URL('./fixtures/webhook-body.json', import.meta.url));
const webhookSecret = 'test-webhook-secret';

describe('app JWT', () => {
  it('signs RS256 claims with iat in the past and exp inside ten minutes', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const now = new Date('2026-10-29T12:00:00.000Z');
    const token = signAppJwt({
      appId: 12345,
      privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      now,
    });
    assert.equal(
      verifyAppJwt(token, publicKey.export({ type: 'spki', format: 'pem' }).toString()),
      true,
    );
    const claims = readAppJwtClaims(token);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    assert.equal(claims.iss, '12345');
    assert.equal(claims.iat, nowSeconds - 60);
    assert.equal(claims.exp, claims.iat + 600);
    assert.ok(claims.exp <= nowSeconds + 600);
  });
});

describe('webhook signature', () => {
  it('accepts the recorded payload and rejects a different body or secret', () => {
    const signature = `sha256=${createHmac('sha256', webhookSecret).update(webhookBody).digest('hex')}`;
    assert.equal(verifyWebhookSignature(webhookBody, signature, webhookSecret), true);
    assert.equal(
      verifyWebhookSignature(
        Buffer.concat([webhookBody, Buffer.from(' ')]),
        signature,
        webhookSecret,
      ),
      false,
    );
    assert.equal(verifyWebhookSignature(webhookBody, signature, 'other-secret'), false);
    assert.equal(verifyWebhookSignature(webhookBody, undefined, webhookSecret), false);
    assert.equal(verifyWebhookSignature(webhookBody, 'sha256=abcd', webhookSecret), false);
    assert.match(webhookBody.toString('utf8'), /keep the bytes/);
  });
});

describe('installation token cache', () => {
  it('keeps the token in memory and refreshes only inside the skew window', async () => {
    let now = 1_700_000_000_000;
    let calls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1;
      const url = String(input);
      assert.match(url, /\/app\/installations\/42\/access_tokens$/);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer test-jwt');
      const expires = new Date(now + 10 * 60_000).toISOString();
      return new Response(JSON.stringify({ token: `ghs_${calls}`, expires_at: expires }), {
        status: 201,
      });
    };
    const cache = new InstallationTokenCache({
      signJwt: () => 'test-jwt',
      fetch: fetchImpl,
      now: () => now,
      skewMs: 60_000,
    });
    assert.equal(await cache.get(42), 'ghs_1');
    assert.equal(await cache.get(42), 'ghs_1');
    now += 9 * 60_000;
    assert.equal(await cache.get(42), 'ghs_2');
    assert.equal(calls, 2);
  });
});
