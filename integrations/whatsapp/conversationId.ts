/**
 * Stable, non-PII conversation ids, lifted from the proven afcloud channel.
 */
import { createHash } from "node:crypto";

export function waConversationId(waId: string): string {
  return `wah:${createHash("sha256").update(waId).digest("hex").slice(0, 16)}`;
}

export function textHash(from: string, text: string): string {
  return createHash("sha256").update(`${from}:${text}`).digest("hex").slice(0, 16);
}
