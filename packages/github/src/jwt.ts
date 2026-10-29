// SPDX-License-Identifier: AGPL-3.0-only

import { createSign, createVerify } from 'node:crypto';

const TEN_MINUTES_SECONDS = 10 * 60;
const IAT_SKEW_SECONDS = 60;

export interface AppJwtClaims {
  iat: number;
  exp: number;
  iss: string;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/**
 * RS256 JWT for a GitHub App.
 * `iat` is 60 seconds in the past (clock drift). `exp` is 10 minutes after `iat`,
 * which is 9 minutes from `now`, inside GitHub's "no more than 10 minutes" rule.
 */
export function signAppJwt(options: {
  appId: string | number;
  privateKeyPem: string;
  now?: Date;
}): string {
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const claims: AppJwtClaims = {
    iat: nowSeconds - IAT_SKEW_SECONDS,
    exp: nowSeconds - IAT_SKEW_SECONDS + TEN_MINUTES_SECONDS,
    iss: String(options.appId),
  };
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(options.privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

export function readAppJwtClaims(token: string): AppJwtClaims {
  const parts = token.split('.');
  const payload = parts[1];
  if (!payload) throw new Error('JWT is missing a payload');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AppJwtClaims;
}

export function verifyAppJwt(token: string, publicKeyPem: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return false;
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  return verifier.verify(publicKeyPem, Buffer.from(parts[2], 'base64url'));
}
