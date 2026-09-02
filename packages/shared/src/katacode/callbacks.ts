import { createHmac, timingSafeEqual } from 'node:crypto';

export const KATACODE_SIGNATURE_HEADER = 'x-katacode-signature';
export const KATACODE_TIMESTAMP_HEADER = 'x-katacode-timestamp';

const MAX_SKEW_MS = 5 * 60 * 1000;

export function signKatacodeCallback(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifyKatacodeCallback(input: {
  readonly secret: string;
  readonly timestamp: string;
  readonly body: string;
  readonly signature: string;
  readonly nowMs?: number;
}): boolean {
  if (!input.secret || !input.timestamp || !input.signature) return false;
  const timestampMs = Date.parse(input.timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  const now = input.nowMs ?? Date.now();
  if (Math.abs(now - timestampMs) > MAX_SKEW_MS) return false;
  const expected = signKatacodeCallback(input.secret, input.timestamp, input.body);
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(input.signature, 'hex');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
