// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createDb,
  type Database,
  deriveSecretsKey,
  type Kysely,
  migrateToLatest,
  saveAppCredentials,
  sql,
} from '@oxybook/db';
import {
  createOrg,
  createSpace,
  listSpaces,
  lookupInstallation,
  normalizeContentRoot,
  parseRepo,
} from '../src/admin.js';

describe('admin parsing', () => {
  it('normalizes content roots and parses owner/repo', () => {
    assert.equal(normalizeContentRoot('docs/'), 'docs');
    assert.equal(normalizeContentRoot('./docs'), 'docs');
    assert.equal(normalizeContentRoot('.'), '');
    assert.equal(normalizeContentRoot('website/docs//'), 'website/docs');
    assert.deepEqual(parseRepo('crisprintsstuff/oxybook-test'), {
      owner: 'crisprintsstuff',
      repo: 'oxybook-test',
    });
    assert.deepEqual(parseRepo('a/b.git'), { owner: 'a', repo: 'b' });
    assert.throws(() => parseRepo('https://github.com/a/b'), /owner\/repo/);
  });
});

const url = process.env.DATABASE_URL;

describe('orgs and spaces', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
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

  it('creates an org and a space, and lists it', async () => {
    await createOrg(db, { slug: 'cris', name: 'Cris' });
    await assert.rejects(createOrg(db, { slug: 'cris', name: 'again' }), /duplicate key/);
    await createSpace(db, {
      orgSlug: 'cris',
      slug: 'test',
      name: 'Test site',
      owner: 'crisprintsstuff',
      repo: 'oxybook-test',
      installationId: 176737174,
      contentRoot: 'docs/',
      defaultRef: 'main',
    });
    await assert.rejects(
      createSpace(db, {
        orgSlug: 'nobody',
        slug: 'x',
        name: 'x',
        owner: 'a',
        repo: 'b',
        installationId: 1,
        contentRoot: 'docs',
        defaultRef: 'main',
      }),
      /no org with slug "nobody"/,
    );
    assert.deepEqual(await listSpaces(db), [
      {
        org: 'cris',
        space: 'test',
        name: 'Test site',
        repo: 'crisprintsstuff/oxybook-test',
        installationId: '176737174',
        contentRoot: 'docs',
        defaultRef: 'main',
      },
    ]);
  });

  it('looks up the installation as the stored App', async () => {
    const secret = 'a-long-enough-secret-key';
    await assert.rejects(
      lookupInstallation(db, secret, 'crisprintsstuff', 'oxybook-test'),
      /no GitHub App is stored/,
    );
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await saveAppCredentials(db, deriveSecretsKey(secret), {
      id: 5535294,
      slug: 'oxybook-cris',
      clientId: 'c',
      clientSecret: 's',
      webhookSecret: 'w',
      privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    });
    const seen: string[] = [];
    const github = (status: number, body: unknown) =>
      (async (input: string | URL | Request) => {
        seen.push(String(input));
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    assert.equal(
      await lookupInstallation(db, secret, 'crisprintsstuff', 'oxybook-test', {
        fetch: github(200, { id: 176737174, account: { login: 'crisprintsstuff' } }),
      }),
      176737174,
    );
    assert.equal(seen[0], 'https://api.github.com/repos/crisprintsstuff/oxybook-test/installation');
    await assert.rejects(
      lookupInstallation(db, secret, 'someone', 'else', { fetch: github(404, {}) }),
      /oxybook-cris is not installed on someone\/else/,
    );
    await assert.rejects(
      lookupInstallation(db, undefined, 'a', 'b'),
      /OXYBOOK_SECRET_KEY is not set/,
    );
  });
});
