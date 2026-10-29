// SPDX-License-Identifier: AGPL-3.0-only

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Compare `X-Hub-Signature-256` to HMAC-SHA256 of the raw body. */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expected = Buffer.from(`sha256=${digest}`);
  const actual = Buffer.from(signatureHeader ?? '', 'utf8');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
