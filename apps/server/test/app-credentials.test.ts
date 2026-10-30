// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createDb,
  type Database,
  deriveSecretsKey,
  type Kysely,
  loadAppCredentials,
  migrateToLatest,
  open,
  saveAppCredentials,
  seal,
  sql,
} from '@oxybook/db';
import { appCredentialsFromEnv } from '../src/main.js';

const credentials = {
  id: 5530818,
  slug: 'oxybook-test-app',
  clientId: 'Iv1.abc',
  clientSecret: 'client-secret',
  webhookSecret: 'webhook-secret',
  privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n',
};

describe('sealed secrets', () => {
  it('round-trips and refuses a different key', () => {
    const key = deriveSecretsKey('a-long-enough-secret-key');
    const sealed = seal('hello', key);
    assert.equal(sealed.includes(Buffer.from('hello')), false);
    assert.equal(open(sealed, key), 'hello');
    assert.notDeepEqual(seal('hello', key), sealed, 'a fresh IV each time');
    assert.throws(
      () => open(sealed, deriveSecretsKey('some-other-secret-key')),
      /OXYBOOK_SECRET_KEY changed/,
    );
    assert.throws(() => deriveSecretsKey('short'), /at least 16/);
  });

  it('stays in memory without DATABASE_URL or OXYBOOK_SECRET_KEY', async () => {
    const lines: string[] = [];
    const result = await appCredentialsFromEnv({}, (line) => lines.push(line));
    assert.equal(result.persist, undefined);
    assert.equal(result.store.get(), null);
    assert.match(lines.join('\n'), /memory only/);
  });
});

const url = process.env.DATABASE_URL;

describe('github_app table', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  let admin: Kysely<Database>;
  let db: Kysely<Database>;

  before(async () => {
    admin = createDb(url as string, { max: 1 });
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
    db = createDb(url as string, { max: 2, searchPath: schema });
    await migrateToLatest(db, { schema });
  });

  after(async () => {
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
  });

  it('saves sealed, loads back, and refuses a second App', async () => {
    const key = deriveSecretsKey('a-long-enough-secret-key');
    assert.equal(await loadAppCredentials(db, key), null);
    await saveAppCredentials(db, key, credentials);
    const row = await db.selectFrom('github_app').selectAll().executeTakeFirstOrThrow();
    assert.equal(row.private_key_enc.includes(Buffer.from('PRIVATE KEY')), false);
    assert.equal(row.webhook_secret_enc.includes(Buffer.from('webhook-secret')), false);
    assert.deepEqual(await loadAppCredentials(db, key), credentials);
    await assert.rejects(saveAppCredentials(db, key, { ...credentials, id: 1 }), /github_app_pkey/);
    await assert.rejects(
      loadAppCredentials(db, deriveSecretsKey('some-other-secret-key')),
      /OXYBOOK_SECRET_KEY changed/,
    );
  });
});
