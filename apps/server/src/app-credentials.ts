// SPDX-License-Identifier: AGPL-3.0-only

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Database, Kysely } from '@oxybook/db';
import type { AppCredentials } from '@oxybook/github';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM key for secrets at rest, derived from OXYBOOK_SECRET_KEY. */
export function deriveSecretsKey(secretKey: string): Buffer {
  if (secretKey.length < 16) {
    throw new Error('OXYBOOK_SECRET_KEY must be at least 16 characters to store App secrets');
  }
  return Buffer.from(hkdfSync('sha256', secretKey, '', 'oxybook secrets at rest v1', 32));
}

/** iv || tag || ciphertext */
export function seal(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function open(sealed: Buffer, key: Buffer): string {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('sealed secret is truncated');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES));
  decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(
      'could not decrypt the stored GitHub App secrets; OXYBOOK_SECRET_KEY changed since the App was created',
    );
  }
}

export async function loadAppCredentials(
  db: Kysely<Database>,
  key: Buffer,
): Promise<AppCredentials | null> {
  const row = await db.selectFrom('github_app').selectAll().executeTakeFirst();
  if (!row) return null;
  return {
    id: Number(row.app_id),
    slug: row.slug,
    clientId: row.client_id,
    clientSecret: open(row.client_secret_enc, key),
    webhookSecret: open(row.webhook_secret_enc, key),
    privateKeyPem: open(row.private_key_enc, key),
  };
}

/** Refuses to replace an App that is already stored: the old one would be orphaned. */
export async function saveAppCredentials(
  db: Kysely<Database>,
  key: Buffer,
  credentials: AppCredentials,
): Promise<void> {
  await db
    .insertInto('github_app')
    .values({
      app_id: credentials.id,
      slug: credentials.slug,
      client_id: credentials.clientId,
      client_secret_enc: seal(credentials.clientSecret, key),
      webhook_secret_enc: seal(credentials.webhookSecret, key),
      private_key_enc: seal(credentials.privateKeyPem, key),
    })
    .execute();
}
