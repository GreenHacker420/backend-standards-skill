import crypto from 'crypto';

/**
 * Timing-Safe Signature Verification
 * Protects webhook receivers (Stripe, Shopify, GitHub, Meta) from timing attacks.
 */
export function verifyHmacSignature(options: {
  rawBody: string | Buffer;
  receivedSignature: string;
  secret: string;
  algorithm?: 'sha256' | 'sha1';
}): boolean {
  const { rawBody, receivedSignature, secret, algorithm = 'sha256' } = options;

  const expectedSignature = crypto
    .createHmac(algorithm, secret)
    .update(rawBody)
    .digest('hex');

  const receivedBuffer = Buffer.from(receivedSignature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  // Prevent timingSafeEqual from throwing if lengths differ
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  // Constant-time byte-by-byte comparison
  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}
