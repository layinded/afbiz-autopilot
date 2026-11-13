/**
 * Webhook security primitives, pattern-level port of the AFBiz production
 * channel laws (N-WA-1/2/9/12), lifted from the proven afcloud-business agent:
 * HMAC over the EXACT raw request bytes, `sha256=` prefix gate,
 * constant-time compares, verify-before-parse, appsecret_proof on Graph calls.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-hub-signature-256";
export const SIGNATURE_PREFIX = "sha256=";

export type HeaderLookup = (name: string) => string | undefined;

export function signatureValid(
  appSecret: string | undefined,
  lookupHeader: HeaderLookup,
  rawBody: Uint8Array,
): boolean {
  if (!appSecret) return false;
  const declared = (lookupHeader(SIGNATURE_HEADER) ?? "").trim();
  if (!declared.startsWith(SIGNATURE_PREFIX)) return false;
  const received = declared.slice(SIGNATURE_PREFIX.length);
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return constantTimeEqual(received, expected);
}

export function verifyTokenMatch(expectedToken: string | undefined, candidate: string | undefined): boolean {
  if (!expectedToken || candidate === undefined) return false;
  return constantTimeEqual(candidate, expectedToken);
}

export function appsecretProof(accessToken: string | undefined, appSecret: string | undefined): string | undefined {
  if (!accessToken || !appSecret) return undefined;
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
