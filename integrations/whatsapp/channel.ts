/**
 * WhatsApp channel runtime, orchestrating the modules lifted from the proven
 * afcloud production channel: parser (typed events + instance id), full Graph
 * sender, security primitives, typing lifecycle manager, conversation ids, and
 * the error taxonomy for provider-failure replies.
 *
 * Per-sender serialized turns, bare Confirm/Cancel over pending actions, and
 * Phase 3 observability: agent_task_started / completed / failed /
 * clarification_required events through the emitter (ledger always, PostHog
 * best-effort, never blocking).
 */
import type { Agent } from "@voltagent/core";
import type { Store } from "../../db/store.js";
import { businessDayRange } from "../../db/store.js";
import { logger, maskPhone, newTraceId, type WhatsAppConfig } from "../../lib/config.js";
import { applyConfirmedPending } from "../../tools/index.js";
import {
  classifyProviderFailure,
  recoveryTextFor,
} from "../../lib/errorTaxonomy.js";
import { PROVIDER_CATEGORY } from "../../lib/failures.js";
import { classifyReplyWithoutTool, type FailureCategory } from "../../lib/failures.js";
import type { Emitter, TaskEventFields } from "../../lib/observability.js";
import { WhatsAppSender, type SenderConfig } from "./sender.js";
import { createTypingManager, type TypingManager, type TypingStartContext } from "./typingManager.js";
import { waConversationId } from "./conversationId.js";
import { mountWhatsappWebhook, type RouteMount, type WebhookDeps } from "./webhook.js";
import { runSupervisorTurn, type TurnResult } from "../../agent/turn.js";

const UNAVAILABLE_REPLY =
  "The assistant is temporarily unavailable. Please try again in a moment - nothing was recorded.";

export interface WhatsAppChannelOptions {
  config: WhatsAppConfig;
  maxPayloadBytes: number;
  store: Store;
  supervisor: Agent;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  tzOffsetMinutes: number;
  emitter?: Emitter;
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
  handleInbound(message: {
    kind: "text" | "button" | "unsupported";
    from: string;
    waMessageId: string;
    text?: string;
    buttonId?: string;
    profileName?: string;
  }): Promise<void>;
  sender: WhatsAppSender;
  typingManager: TypingManager;
}

export function createWhatsAppChannel(options: WhatsAppChannelOptions): WhatsAppChannel {
  const senderConfig: SenderConfig = options.config;
  const sender = new WhatsAppSender(senderConfig, options.fetchFn ?? fetch);
  const typingManager = createTypingManager({
    sender,
    config: options.config,
    emit: (ctx, status, data, detail, durationMs) => {
      logger.info("typing_event", {
        conversationId: ctx.conversationId,
        typing: data.event,
        reason: data.reason ?? null,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(detail ? { detail } : {}),
        level: status === "error" ? "warn" : "info",
      });
    },
  });
  const emitter = options.emitter;
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

  const handleConfirmation = async (from: string, word: "confirm" | "cancel"): Promise<void> => {
    const traceId = newTraceId();
    await emitter?.emit("agent_task_started", { traceId, status: "info", outcome: `confirmation_${word}` });
    const pending = await options.store.consumePending(from, word);
    if (!pending) {
      logger.info("confirm_no_pending", { traceId, sender: maskPhone(from), word });
      await emitter?.emit("agent_task_completed", { traceId, status: "info", outcome: "no_pending_action" });
      await reply(from, "There's nothing pending to confirm or cancel right now.", traceId);
      return;
    }
    if (word === "cancel") {
      logger.info("pending_cancelled", { traceId, sender: maskPhone(from), pendingId: pending.id, tool: pending.tool });
      await emitter?.emit("agent_task_completed", {
        traceId,
        status: "success",
        tool: pending.tool,
        outcome: "confirmation_cancelled",
      });
      await reply(from, "Cancelled. Nothing was recorded.", traceId);
      return;
    }
    logger.info("pending_confirmed", { traceId, sender: maskPhone(from), pendingId: pending.id, tool: pending.tool });
    try {
      const startedAt = Date.now();
      const applied = await applyConfirmedPending(options.store, pending);
      logger.info("pending_applied", { traceId, pendingId: pending.id, tool: pending.tool, recordId: applied.recordId ?? null });
      await emitter?.emit("agent_tool_executed", {
        traceId,
        tool: pending.tool,
        status: "success",
        outcome: "confirmation_applied",
        durationMs: Date.now() - startedAt,
      } satisfies TaskEventFields);
      await emitter?.emit("agent_task_completed", {
        traceId,
        status: "success",
        tool: pending.tool,
        outcome: "confirmation_applied",
        durationMs: Date.now() - startedAt,
      });
      await reply(from, applied.message, traceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const category: FailureCategory = classifyProviderFailure(message) === "provider_error" ? "database" : "provider_error";
      logger.error("confirm_apply_failed", { traceId, pendingId: pending.id, tool: pending.tool, error: message });
      await emitter?.emit("agent_task_failed", {
        traceId,
        status: "failure",
        tool: pending.tool,
        outcome: "confirmation_apply_error",
        failureCategory: category,
        errorClass: error instanceof Error ? error.name : "Unknown",
        ledgerExtra: { error: message.slice(0, 300) },
      });
      await reply(from, "That action couldn't be saved - nothing was recorded. Please restate it and try again.", traceId);
    }
  };

  const handleTextTurn = async (from: string, message: { waMessageId: string; text: string; profileName?: string }): Promise<void> => {
    const traceId = newTraceId();
    await emitter?.emit("agent_task_started", { traceId, status: "info", outcome: "message" });
    logger.info("inbound_message", {
      traceId,
      sender: maskPhone(from),
      waMessageId: message.waMessageId,
      preview: message.text.slice(0, 80),
    });

    const typingStart: TypingStartContext = { conversationId: waConversationId(from), userId: from, runId: traceId };
    const stopTyping = typingManager.start(message.waMessageId, typingStart);

    try {
      const today = businessDayRange(new Date(), options.tzOffsetMinutes).date;
      const turn = await runTurn({
        supervisor: options.supervisor,
        userId: from,
        conversationId: waConversationId(from),
        message: message.text,
        traceId,
        today,
        maxOutputTokens: options.maxOutputTokens,
        timeoutMs: options.requestTimeoutMs,
      });
      logger.info("turn_completed", { traceId, durationMs: turn.durationMs, settled: turn.settled });

      let text: string;
      if (turn.settled === "result" && turn.text.trim().length > 0) {
        text = turn.text.trim();
      } else {
        const reason = classifyProviderFailure(turn.settled === "timeout" ? "timed out" : "provider unavailable");
        text = turn.settled === "timeout" ? recoveryTextFor(reason, undefined) : UNAVAILABLE_REPLY;
        const category = turn.settled === "timeout" ? PROVIDER_CATEGORY["timeout"] : PROVIDER_CATEGORY["provider_error"];
        await emitter?.emit("agent_task_failed", {
          traceId,
          status: "failure",
          outcome: turn.settled === "timeout" ? "turn_timeout" : "turn_provider_error",
          failureCategory: category,
          durationMs: turn.durationMs,
          errorClass: turn.settled,
        });
      }
      logger.info("turn_reply", { traceId, replyPreview: text.slice(0, 120), usedFallback: turn.text.trim().length === 0 });

      if (turn.settled === "result" && turn.toolCalls === 0) {
        const replyClass = classifyReplyWithoutTool(text);
        if (replyClass === "missing_information") {
          await emitter?.emit("agent_clarification_required", {
            traceId,
            status: "info",
            outcome: "clarification_request",
            failureCategory: "missing_information",
            ledgerExtra: { raw_input: message.text.slice(0, 200), reply_preview: text.slice(0, 120) },
          });
        } else if (replyClass === "unsupported_request") {
          await emitter?.emit("agent_task_completed", {
            traceId,
            status: "info",
            outcome: "unsupported_request",
            durationMs: turn.durationMs,
          });
        } else {
          await emitter?.emit("agent_task_completed", {
            traceId,
            status: "success",
            outcome: "answered",
            durationMs: turn.durationMs,
          });
        }
      } else if (turn.settled === "result") {
        await emitter?.emit("agent_task_completed", {
          traceId,
          status: "success",
          outcome: turn.toolCalls === 0 ? "answered" : "tools_ran",
          durationMs: turn.durationMs,
        });
      }

      await reply(from, text, traceId);
    } finally {
      stopTyping();
    }
  };

  const handleInbound: WhatsAppChannel["handleInbound"] = (message) =>
    enqueue(message.from, async () => {
      const from = message.from.startsWith("+") ? message.from : `+${message.from}`;
      if (message.kind === "button") {
        logger.info("inbound_button", { sender: maskPhone(from), waMessageId: message.waMessageId, buttonId: message.buttonId?.slice(0, 30) });
        return;
      }
      if (message.kind !== "text" || !message.text) {
        logger.info("inbound_unsupported_type", { sender: maskPhone(from), waMessageId: message.waMessageId });
        return;
      }
      const normalized = message.text.trim().toLowerCase();
      if (normalized === "confirm" || normalized === "cancel") {
        await handleConfirmation(from, normalized);
        return;
      }
      await handleTextTurn(from, { waMessageId: message.waMessageId, text: message.text, profileName: message.profileName });
    });

  const channel: WhatsAppChannel = {
    verifyToken: options.config.verifyToken,
    appSecret: options.config.appSecret,
    phoneNumberId: options.config.phoneNumberId,
    maxPayloadBytes: options.maxPayloadBytes,
    claimReceipt: (id, kind, preview) => options.store.claimReceipt(id, kind, preview),
    markReceipt: (id, status) => options.store.markReceipt(id, status),
    handleInbound,
    sender,
    typingManager,
    mount(app: RouteMount): void {
      mountWhatsappWebhook(app, channel);
    },
  };
  return channel;
}
