/**
 * The operational event emitter (Phase 3): every important task outcome lands
 * in the LOCAL PostgreSQL event ledger first (durable, diagnostic source of
 * truth), and the same event is forwarded to PostHog with a fixed whitelist of
 * privacy-safe properties. PostHog never blocks the business flow, and the
 * ledger records everything whether or not PostHog is reachable.
 */
import type { Store } from "../db/store.js";
import type { PostHogObservability } from "../integrations/posthog.js";
import { logger } from "./config.js";

export type AfbizEvent =
  | "agent_task_started"
  | "agent_task_completed"
  | "agent_task_failed"
  | "agent_clarification_required"
  | "agent_tool_executed"
  | "improvement_proposed"
  | "improvement_tested"
  | "improvement_activated";

export type EventStatus = "success" | "failure" | "info";

export interface TaskEventFields {
  traceId: string;
  tool?: string;
  status: EventStatus;
  outcome?: string;
  failureCategory?: string;
  durationMs?: number;
  improvementVersion?: string;
  errorClass?: string;
  /** Local-only extras (ledger payload): e.g. `raw_input` for parse failures. */
  ledgerExtra?: Record<string, unknown>;
}

const POSTHog_PROPERTIES = new Set([
  "tool",
  "agentVersion",
  "outcome",
  "failureCategory",
  "durationMs",
  "improvementVersion",
  "errorClass",
]);

export interface Emitter {
  emit(event: AfbizEvent, fields: TaskEventFields): Promise<void>;
}

export function createEmitter(deps: {
  store: Store;
  observability?: PostHogObservability;
  agentVersion: string;
}): Emitter {
  const { store, observability, agentVersion } = deps;

  const emit = async (event: AfbizEvent, fields: TaskEventFields): Promise<void> => {
    const {
      traceId,
      tool,
      status,
      outcome,
      failureCategory,
      durationMs,
      improvementVersion,
      errorClass,
      ledgerExtra,
    } = fields;

    await store.recordEventLedger({
      traceId,
      event,
      tool,
      agentVersion,
      status,
      outcome,
      failureCategory,
      durationMs,
      improvementVersion,
      errorClass,
      payload: ledgerExtra ?? {},
    });

    if (observability?.configured) {
      const properties: Record<string, string | number | boolean> = { agentVersion };
      for (const key of POSTHog_PROPERTIES) {
        const raw = fields[key as keyof TaskEventFields];
        if (raw === undefined || raw === null || typeof raw === "object") continue;
        properties[key] = raw as string | number | boolean;
      }
      observability.capture(event, traceId, properties);
    }

    logger.info("observability_event", {
      traceId,
      event,
      status,
      ...(failureCategory ? { failureCategory } : {}),
      ...(observability?.configured ? { posthog: "forwarded" } : { posthog: "local_only" }),
    });
  };

  return { emit };
}
