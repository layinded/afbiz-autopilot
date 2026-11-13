/**
 * Meta Graph sender lane (`POST /{version}/{phone_number_id}/messages`),
 * lifted from the proven afcloud-business production agent: Bearer +
 * appsecret_proof, exponential backoff, Retry-After honored, non-retryable
 * Meta refusals surfaced, and send timeouts NEVER retried (anti-double-send
 * law: the message may have landed at Graph before the timeout).
 */
import { appsecretProof } from "./security.js";
import type { SendTemplateComponent } from "./templates.js";

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

export interface ButtonAction {
  id: string;
  title: string;
}

export interface ListRow extends ButtonAction {
  description?: string;
}

const ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_FACTOR = 2;

export class WhatsAppSender {
  constructor(
    private readonly config: SenderConfig,
    private readonly fetchFn: typeof fetch = fetch,
    /** Fires ONCE per message-bearing outbound with its final outcome (read
     *  receipts / typing markers are excluded — status payloads don't log). */
    private readonly onSend?: (payload: Record<string, unknown>, result: SendResult) => void,
  ) {}

  private proof(): string {
    return appsecretProof(this.config.accessToken, this.config.appSecret) ?? "";
  }

  private endpoint(): string {
    return `${this.config.graphBaseUrl}/${this.config.graphVersion}/${this.config.phoneNumberId}/messages`;
  }

  async sendText(to: string, body: string): Promise<SendResult> {
    return this.postMessage({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    });
  }

  async sendInteractiveButtons(to: string, body: string, actions: ButtonAction[]): Promise<SendResult> {
    if (actions.length === 0 || actions.length > 3) {
      return { ok: false, error: "quick-reply buttons must be 1..3 (Meta limit)" };
    }
    return this.postMessage({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: { buttons: actions.map((action) => ({ type: "reply", reply: { id: action.id, title: action.title } })) },
      },
    });
  }

  async sendInteractiveList(to: string, title: string, body: string, rows: ListRow[]): Promise<SendResult> {
    if (rows.length === 0 || rows.length > 10) {
      return { ok: false, error: "list rows must be 1..10 (Meta limit)" };
    }
    return this.postMessage({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: title.slice(0, 60) },
        body: { text: body },
        footer: { text: "AFBiz" },
        action: {
          button: "Choose one",
          sections: [
            {
              title: title.slice(0, 24),
              rows: rows.map((row) => ({
                id: row.id.slice(0, 200),
                title: row.title.slice(0, 24),
                ...(row.description ? { description: row.description.slice(0, 72) } : {}),
              })),
            },
          ],
        },
      },
    });
  }

  async sendTemplate(to: string, langCode: string, name: string, components: SendTemplateComponent[]): Promise<SendResult> {
    const payload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: { name, language: { code: langCode }, components },
    };
    return this.postMessage(payload);
  }

  /**
   * Upload raw bytes to Graph (`POST /{version}/{phone_number_id}/media`,
   * `messaging_product=whatsapp`): returns the media id or null. Retrying
   * is SAFE — the upload has no side effect until a message references it.
   */
  async uploadMedia(request: { mimeType: string; bytes: Uint8Array; filename: string }): Promise<{ id: string } | null> {
    const url = `${this.config.graphBaseUrl}/${this.config.graphVersion}/${this.config.phoneNumberId}/media?appsecret_proof=${this.proof()}`;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const wait = BACKOFF_BASE_MS * BACKOFF_FACTOR ** (attempt - 1) * 2;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      try {
        const form = new FormData();
        form.append("messaging_product", "whatsapp");
        form.append("file", new Blob([Uint8Array.from(request.bytes)], { type: request.mimeType }), request.filename);
        const response = await this.fetchFn(url, {
          method: "POST",
          headers: { authorization: `Bearer ${this.config.accessToken}` },
          body: form,
          signal: AbortSignal.timeout(this.config.graphTimeoutMs),
        });
        if (response.ok) {
          const parsed = (await response.json().catch(() => ({}))) as { id?: string };
          if (parsed.id) return { id: parsed.id };
          return null;
        }
        if (response.status < 500 && response.status !== 429) return null;
      } catch {
        // retryable transport failure (timeout during upload is safe — no
        // message was created; only an upload the message never referenced)
      }
    }
    return null;
  }

  async sendDocument(
    to: string,
    request: { id: string; filename: string; caption?: string },
  ): Promise<SendResult> {
    const document: Record<string, unknown> = { id: request.id, filename: request.filename };
    if (request.caption) document["caption"] = request.caption;
    const payload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "document",
      document,
    };
    return this.postMessage(payload);
  }

  /**
   * Mark the inbound message read; with `typingIndicator` the same request also
   * shows Meta's native typing indicator (dismissed when we reply or after
   * 25 s; re-issuing this request refreshes it). Best-effort only: resolves
   * with the send outcome (true when Meta accepted) and never rejects.
   */
  async markRead(waMessageId: string, options?: { typingIndicator?: boolean }): Promise<boolean> {
    try {
      const result = await this.postMessage(
        {
          messaging_product: "whatsapp",
          status: "read",
          message_id: waMessageId,
          ...(options?.typingIndicator ? { typing_indicator: { type: "text" } } : {}),
        },
        { attempts: 1 },
      );
      return result.ok;
    } catch {
      return false; // best-effort only (AFBiz pattern)
    }
  }

  private async postMessage(
    payload: Record<string, unknown>,
    override?: { attempts: number },
  ): Promise<SendResult> {
    const result = await this.postMessageAttempt(payload, override);
    if (payload.status === undefined) this.onSend?.(payload, result);
    return result;
  }

  private async postMessageAttempt(
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
        const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
        lastResult = {
          ok: false,
          error: `graph transport failure: ${error instanceof Error ? error.message : String(error)}`,
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
