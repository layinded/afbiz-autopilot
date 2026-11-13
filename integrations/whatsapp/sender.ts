/**
 * Meta Graph sender lane (`POST /{version}/{phone_number_id}/messages`),
 * pattern-level port of the proven reference sender: Bearer + appsecret_proof,
 * retries with backoff, Retry-After honored, non-retryable Meta refusals
 * surfaced, and send timeouts NEVER retried (anti-double-send law - a timed-out
 * request may still have delivered).
 */
import { appsecretProof } from "./security.js";

export interface SenderConfig {
  accessToken: string;
  appSecret: string;
  phoneNumberId: string;
  graphBaseUrl: string;
  graphVersion: string;
  graphTimeoutMs: number;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  httpStatus?: number;
}

const ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_FACTOR = 2;

export class WhatsAppSender {
  constructor(
    private readonly config: SenderConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private proof(): string {
    return appsecretProof(this.config.accessToken, this.config.appSecret) ?? "";
  }

  private endpoint(): string {
    return `${this.config.graphBaseUrl}/${this.config.graphVersion}/${this.config.phoneNumberId}/messages`;
  }

  /** Short, natural confirmation text goes out as plain text. */
  async sendText(to: string, body: string): Promise<SendResult> {
    return this.postMessage({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    });
  }

  /** Best-effort read receipt for inbound messages (no typing indicator in Phase 2). */
  async markRead(waMessageId: string): Promise<void> {
    try {
      await this.postMessage(
        {
          messaging_product: "whatsapp",
          status: "read",
          message_id: waMessageId,
        },
        { attempts: 1 },
      );
    } catch {
      // best-effort only (AFBiz pattern)
    }
  }

  private async postMessage(
    payload: Record<string, unknown>,
    override?: { attempts: number },
  ): Promise<SendResult> {
    const attempts = override?.attempts ?? ATTEMPTS;
    const url = `${this.endpoint()}?appsecret_proof=${this.proof()}`;
    let delayMs = BACKOFF_BASE_MS;
    let lastResult: SendResult = { ok: false, error: "not attempted" };
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        const wait = lastResult.retryAfterMs ?? delayMs;
        await new Promise((resolve) => setTimeout(resolve, wait));
        delayMs *= BACKOFF_FACTOR;
      }
      try {
        const response = await this.fetchFn(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.config.graphTimeoutMs),
        });
        if (response.ok) {
          const parsed = (await response.json().catch(() => ({}))) as { messages?: { id?: string }[] };
          return { ok: true, messageId: parsed.messages?.[0]?.id };
        }
        const errorBody = (await response.text().catch(() => "")) || "";
        const retryAfterMs = Number(response.headers.get("retry-after") ?? "") * 1000 || undefined;
        const retryable = response.status >= 500 || response.status === 429 || retryAfterMs !== undefined;
        lastResult = {
          ok: false,
          error: `Graph API ${response.status}: ${errorBody.slice(0, 300)}`,
          retryable,
          retryAfterMs,
          httpStatus: response.status,
        };
      } catch (error) {
        const isTimeout =
          error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        lastResult = {
          ok: false,
          error: `graph transport failure${isTimeout ? " (timeout)" : ""}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retryable: !isTimeout,
        };
      }
      if (!lastResult.retryable) {
        return lastResult;
      }
    }
    return lastResult;
  }
}
