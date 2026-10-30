// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { type Database, type Kysely, sql } from '@oxybook/db';

export const SESSION_COOKIE_NAME = 'oxybook_session';
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// @node-rs/argon2 defaults to Argon2id (algorithm = 2).
const ARGON2_OPTIONS = {
  memoryCost: 19456, // 19 MiB (OWASP minimum recommendation for Argon2id)
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * The cookie holds the raw random token; the database holds only its SHA-256
 * (`0001_schema_v0.sql`, ARCHITECTURE §7), so a database read never yields live cookies.
 */
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function deriveCsrfToken(tokenHash: Buffer, secretKey: string): string {
  return createHmac('sha256', secretKey).update(tokenHash).digest('hex');
}

export function verifyCsrfToken(expected: string, provided: string | null | undefined): boolean {
  if (!provided || typeof provided !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided.trim(), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function signUpUser(
  db: Kysely<Database>,
  input: { email: string; name: string; password: string },
): Promise<AuthUser> {
  const email = input.email.trim();
  const name = input.name.trim();
  const password = input.password;

  if (!EMAIL_RE.test(email)) {
    throw new Error('enter a valid email address');
  }
  if (!name) {
    throw new Error('name is required');
  }
  if (password.length < 8) {
    throw new Error('password must be at least 8 characters');
  }

  const passwordHash = await hashPassword(password);

  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('users')
      .select('id')
      .where(sql<boolean>`lower(email) = ${email.toLowerCase()}`)
      .executeTakeFirst();
    if (existing) {
      throw new Error('an account with that email already exists');
    }

    const existingCountRow = await trx
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    const isFirstUser = Number(existingCountRow.count) === 0;

    const inserted = await trx
      .insertInto('users')
      .values({
        email,
        name,
        password_hash: passwordHash,
      })
      .returning(['id', 'email', 'name'])
      .executeTakeFirstOrThrow();

    // If this is the first user on the instance and orgs/spaces were created earlier via
    // `oxybook-admin`, attach the first user as owner/admin of memberless orgs and spaces.
    if (isFirstUser) {
      const orgs = await trx.selectFrom('orgs').select('id').execute();
      for (const org of orgs) {
        const hasMember = await trx
          .selectFrom('org_members')
          .select('user_id')
          .where('org_id', '=', org.id)
          .executeTakeFirst();
        if (!hasMember) {
          await trx
            .insertInto('org_members')
            .values({ org_id: org.id, user_id: inserted.id, role: 'owner' })
            .execute();
          const spaces = await trx
            .selectFrom('spaces')
            .select('id')
            .where('org_id', '=', org.id)
            .execute();
          for (const space of spaces) {
            await trx
              .insertInto('space_members')
              .values({
                org_id: org.id,
                space_id: space.id,
                user_id: inserted.id,
                role: 'admin',
              })
              .onConflict((oc) => oc.doNothing())
              .execute();
          }
        }
      }
    }

    return inserted;
  });
}

export async function authenticateUser(
  db: Kysely<Database>,
  input: { email: string; password: string },
): Promise<AuthUser | null> {
  const email = input.email.trim().toLowerCase();
  if (!email || !input.password) return null;

  const row = await db
    .selectFrom('users')
    .select(['id', 'email', 'name', 'password_hash'])
    .where(sql<boolean>`lower(email) = ${email}`)
    .executeTakeFirst();
  if (!row?.password_hash) return null;

  const valid = await verifyPassword(row.password_hash, input.password);
  if (!valid) return null;

  return { id: row.id, email: row.email, name: row.name };
}

export async function createSession(
  db: Kysely<Database>,
  userId: string,
  options: { ttlMs?: number; now?: Date } = {},
): Promise<{ token: string; tokenHash: Buffer; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(token);
  const nowMs = (options.now ?? new Date()).getTime();
  const expiresAt = new Date(nowMs + (options.ttlMs ?? DEFAULT_SESSION_TTL_MS));

  await db
    .insertInto('sessions')
    .values({
      token_hash: tokenHash,
      user_id: userId,
      expires_at: expiresAt,
    })
    .execute();

  return { token, tokenHash, expiresAt };
}

export interface LoadedSession {
  user: AuthUser;
  tokenHash: Buffer;
  expiresAt: Date;
}

export async function loadSessionUser(
  db: Kysely<Database>,
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<LoadedSession | null> {
  if (!token || typeof token !== 'string') return null;
  const tokenHash = hashSessionToken(token);
  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'users.id as id',
      'users.email as email',
      'users.name as name',
      'sessions.token_hash as tokenHash',
      'sessions.expires_at as expiresAt',
    ])
    .where('sessions.token_hash', '=', tokenHash)
    .where('sessions.expires_at', '>', now)
    .executeTakeFirst();
  if (!row) return null;
  return {
    user: { id: row.id, email: row.email, name: row.name },
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt),
  };
}

export async function deleteSession(
  db: Kysely<Database>,
  token: string | null | undefined,
): Promise<void> {
  if (!token || typeof token !== 'string') return;
  const tokenHash = hashSessionToken(token);
  await db.deleteFrom('sessions').where('token_hash', '=', tokenHash).execute();
}

export async function pruneExpiredSessions(
  db: Kysely<Database>,
  now: Date = new Date(),
): Promise<void> {
  await db.deleteFrom('sessions').where('expires_at', '<=', now).execute();
}

export function parseCookies(cookieHeader: string | string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : (cookieHeader ?? '');
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      map.set(key, decodeURIComponent(val));
    } catch {
      map.set(key, val);
    }
  }
  return map;
}

export function formatSessionCookie(
  token: string,
  options: { secure?: boolean; maxAgeSeconds?: number } = {},
): string {
  const maxAge = options.maxAgeSeconds ?? Math.floor(DEFAULT_SESSION_TTL_MS / 1000);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function formatClearSessionCookie(options: { secure?: boolean } = {}): string {
  const parts = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
