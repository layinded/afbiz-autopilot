/**
 * One supervised turn over VoltAgent streamText, with the reference watchdog:
 * VoltAgent 2.11's streamText promise may never settle when the model call
 * fails or is aborted - so the op races a timeout that aborts it. On timeout or
 * error the turn returns settled!=("result") with empty text; the channel then
 * sends an honest "unavailable, try again" line. No simulated answer is ever
 * produced.
 */
import type { Agent, VoltAgentTextStreamPart } from "@voltagent/core";
import { logger } from "../lib/config.js";

export interface TurnParams {
  supervisor: Agent;
  userId: string;
  conversationId: string;
  message: string;
  traceId: string;
  today: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface TurnResult {
  text: string;
  durationMs: number;
  settled: "result" | "error" | "timeout";
  toolCalls: number;
}

type Settled =
  | { kind: "result"; result: Awaited<ReturnType<Agent["streamText"]>> }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

export async function runSupervisorTurn(params: TurnParams): Promise<TurnResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const opPromise = params.supervisor
      .streamText(params.message, {
        memory: { userId: params.userId, conversationId: params.conversationId },
        context: new Map<string, unknown>([
          ["today", params.today],
          ["traceId", params.traceId],
          ["source", "whatsapp"],
        ]),
        maxOutputTokens: params.maxOutputTokens,
        abortSignal: controller.signal,
      })
      .then((settled) => ({ kind: "result", result: settled }) satisfies Settled)
      .catch((error) => ({ kind: "error", error }) satisfies Settled);

    const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
      setTimeout(() => resolve({ kind: "timeout" }), params.timeoutMs + 250);
    });

    const outcome = (await Promise.race([opPromise, timeoutPromise])) as Settled;
    if (outcome.kind === "timeout") {
      return { text: "", durationMs: Date.now() - startedAt, settled: "timeout", toolCalls: 0 };
    }
    if (outcome.kind === "error") {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      logger.error("turn_failed", { traceId: params.traceId, error: message.slice(0, 300) });
      return { text: "", durationMs: Date.now() - startedAt, settled: "error", toolCalls: 0 };
    }

    let toolCalls = 0;
    const seenCallIds = new Set<string>();
    for await (const part of outcome.result.fullStream as AsyncIterable<VoltAgentTextStreamPart>) {
      if (part.type === "tool-call") {
        const callId = (part as { toolCallId?: string }).toolCallId ?? "unknown";
        if (seenCallIds.has(callId)) continue;
        seenCallIds.add(callId);
        toolCalls += 1;
        logger.info("agent_tool_call", { traceId: params.traceId, toolName: (part as { toolName?: string }).toolName });
      }
    }
    const text = (await outcome.result.text) ?? "";
    logger.info("turn_text_ready", { traceId: params.traceId, toolCalls });
    return { text, durationMs: Date.now() - startedAt, settled: "result", toolCalls };
  } finally {
    clearTimeout(watchdog);
  }
}
