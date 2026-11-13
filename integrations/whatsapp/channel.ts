/**
 * WhatsApp channel runtime: per-sender serialized turns, bare Confirm/Cancel
 * handling over pending actions, outbound replies via the Graph sender.
 * All user-facing replies are short; every step logs a structured line with a
 * per-inbound trace id.
 */
import type { Agent } from "@voltagent/core";
import type { Store } from "../../db/store.js";
import { logger, maskPhone, newTraceId } from "../../lib/config.js";
import { businessDayRange } from "../../db/store.js";
import { applyConfirmedPending } from "../../tools/index.js";
import { WhatsAppSender, type SenderConfig } from "./sender.js";
import { mountWhatsappWebhook, type RouteMount, type WebhookDeps } from "./webhook.js";
import { runSupervisorTurn, type TurnResult } from "../../agent/turn.js";

export interface WhatsAppChannelOptions {
  verifyToken: string;
  appSecret: string;
  sender: SenderConfig;
  maxPayloadBytes: number;
  store: Store;
  supervisor: Agent;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  tzOffsetMinutes: number;
  /** Injectable for tests; defaults to the real watchdog turn runner. */
  runTurn?: (params: {
    supervisor: Agent;
    userId: string;
    conversationId: string;
    message: string;
    traceId: string;
    today: string;
    maxOutputTokens: number;
    timeoutMs: number;
  }) => Promise<TurnResult>;
  fetchFn?: typeof fetch;
}

export interface WhatsAppChannel extends WebhookDeps {
  mount(app: RouteMount): void;
  handleInbound(message: { kind: "text" | "other"; from: string; waMessageId: string; text?: string; profileName?: string }): Promise<void>;
  sender: WhatsAppSender;
}

export function createWhatsAppChannel(options: WhatsAppChannelOptions): WhatsAppChannel {
  const sender = new WhatsAppSender(options.sender, options.fetchFn ?? fetch);
  const runTurn =
    options.runTurn ??
    ((params) =>
      runSupervisorTurn({
        supervisor: params.supervisor,
        userId: params.userId,
        conversationId: params.conversationId,
        message: params.message,
        traceId: params.traceId,
        today: params.today,
        maxOutputTokens: params.maxOutputTokens,
        timeoutMs: params.timeoutMs,
      }));

  const queues = new Map<string, Promise<unknown>>();
  const enqueue = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    const tracked = next.catch(() => undefined) as Promise<unknown>;
    queues.set(key, tracked);
    void tracked.finally(() => {
      if (queues.get(key) === tracked) queues.delete(key);
    });
    return next;
  };

  const reply = async (to: string, body: string, traceId: string): Promise<void> => {
    const sent = await sender.sendText(to, body);
    if (sent.ok) {
      logger.info("outbound_reply", { traceId, sender: maskPhone(to), waMessageId: sent.messageId ?? null });
    } else {
      logger.error("outbound_failed", { traceId, sender: maskPhone(to), error: sent.error ?? "unknown" });
    }
  };

  // Meta webhook payloads carry wa_id WITHOUT the leading "+"; owner identity is
  // canonical E.164-style "+<digits>" everywhere (store rows, pending actions).
  const normalizePhone = (waId: string): string => (waId.startsWith("+") ? waId : `+${waId}`);

  const handleConfirmation = async (rawFrom: string, word: "confirm" | "cancel"): Promise<void> => {
    const from = normalizePhone(rawFrom);
    const traceId = newTraceId();
    const pending = await options.store.consumePending(from, word);
    if (!pending) {
      logger.info("confirm_no_pending", { traceId, sender: maskPhone(from), word });
      await reply(from, "There's nothing pending to confirm or cancel right now.", traceId);
      return;
    }
    if (word === "cancel") {
      logger.info("pending_cancelled", { traceId, sender: maskPhone(from), pendingId: pending.id, tool: pending.tool });
      await reply(from, "Cancelled. Nothing was recorded.", traceId);
      return;
    }
    logger.info("pending_confirmed", { traceId, sender: maskPhone(from), pendingId: pending.id, tool: pending.tool });
    try {
      const applied = await applyConfirmedPending(options.store, pending);
      logger.info("pending_applied", { traceId, pendingId: pending.id, tool: pending.tool, recordId: applied.recordId ?? null });
      await reply(from, applied.message, traceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("confirm_apply_failed", { traceId, pendingId: pending.id, tool: pending.tool, error: message });
      await reply(from, "That action couldn't be saved - please restate it and I'll try again.", traceId);
    }
  };

  const handleInbound: WhatsAppChannel["handleInbound"] = (message) =>
    enqueue(message.from, async () => {
      const from = normalizePhone(message.from);
      if (message.kind !== "text" || !message.text) {
        logger.info("inbound_unsupported_type", { sender: maskPhone(from), waMessageId: message.waMessageId });
        return;
      }
      const normalized = message.text.trim().toLowerCase();
      if (normalized === "confirm" || normalized === "cancel") {
        await handleConfirmation(from, normalized);
        return;
      }

      const traceId = newTraceId();
      logger.info("inbound_message", {
        traceId,
        sender: maskPhone(from),
        waMessageId: message.waMessageId,
        preview: message.text.slice(0, 80),
      });
      void sender.markRead(message.waMessageId); // best-effort

      const today = businessDayRange(new Date(), options.tzOffsetMinutes).date;
      const turn = await runTurn({
        supervisor: options.supervisor,
        userId: from,
        conversationId: `wa:${from}`,
        message: message.text,
        traceId,
        today,
        maxOutputTokens: options.maxOutputTokens,
        timeoutMs: options.requestTimeoutMs,
      });
      logger.info("turn_completed", { traceId, durationMs: turn.durationMs, settled: turn.settled });

      const fallback =
        turn.settled === "result"
          ? "I couldn't compose an answer just now - please try again."
          : "My reasoning service is unavailable right now - please try again shortly.";
      const text = turn.text.trim().length > 0 ? turn.text.trim() : fallback;
      logger.info("turn_reply", { traceId, replyPreview: text.slice(0, 120), usedFallback: turn.text.trim().length === 0 });
      await reply(from, text, traceId);
    });

  const channel: WhatsAppChannel = {
    verifyToken: options.verifyToken,
    appSecret: options.appSecret,
    maxPayloadBytes: options.maxPayloadBytes,
    claimReceipt: (id, kind, preview) => options.store.claimReceipt(id, kind, preview),
    markReceipt: (id, status) => options.store.markReceipt(id, status),
    handleInbound,
    sender,
    mount(app: RouteMount): void {
      mountWhatsappWebhook(app, channel);
    },
  };
  return channel;
}
