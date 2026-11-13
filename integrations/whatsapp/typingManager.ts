/**
 * THE TYPING LIFECYCLE MANAGER, lifted from the proven afcloud channel: one
 * process-wide owner of Meta's native typing indicator, with its laws intact:
 * - ONE session per inbound message id (duplicate start returns the live handle)
 * - ZERO overlap: next refresh scheduled only after the previous markRead settles
 * - REFRESH while processing; STOP on reply delivery, deadline, or repeated failures
 * - BEST-EFFORT: an indicator failure is counted and logged, never thrown
 */
export interface TypingSender {
  markRead(waMessageId: string, options?: { typingIndicator?: boolean }): Promise<boolean>;
}

export interface TypingStartContext {
  conversationId: string;
  userId: string;
  runId?: string;
}

export interface TypingSnapshot {
  active: number;
  started: number;
  refreshed: number;
  stopped: number;
  metaFailures: number;
}

export interface TypingManager {
  start(waMessageId: string, ctx: TypingStartContext): () => void;
  stopAll(): void;
  snapshot(): TypingSnapshot;
}

/** Consecutive Meta failures before a session stops refreshing. */
const MAX_CONSECUTIVE_FAILURES = 3;

export type TypingEmit = (
  ctx: TypingStartContext,
  status: "ok" | "error",
  data: {
    event: "started" | "refreshed" | "stopped" | "meta_error";
    externalMessageId: string;
    failures?: number;
    reason?: string;
    durationMs?: number;
  },
  detail?: string,
  durationMs?: number,
) => void;

export function createTypingManager(deps: {
  sender: TypingSender;
  config: { typingIndicator: boolean; typingRefreshMs: number; typingMaxMs: number };
  emit: TypingEmit;
}): TypingManager {
  const { sender, config, emit } = deps;

  const activeSessions = new Map<string, () => void>();
  const counters = { started: 0, refreshed: 0, stopped: 0, metaFailures: 0 };

  const start = (waMessageId: string, ctx: TypingStartContext): (() => void) => {
    const existing = activeSessions.get(waMessageId);
    if (existing) return existing;

    const startedAt = Date.now();
    let active = true;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    let refreshes = 0;

    const scheduleNext = (): void => {
      if (!active) return;
      if (Date.now() - startedAt >= config.typingMaxMs) {
        selfStop("deadline");
        return;
      }
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        void runOnce(false);
      }, config.typingRefreshMs);
    };

    const runOnce = async (isInitial: boolean): Promise<void> => {
      if (!active) return;
      const ok = await sender
        .markRead(waMessageId, { typingIndicator: config.typingIndicator })
        .catch(() => false);
      if (!active) return;
      if (ok) {
        consecutiveFailures = 0;
        if (!isInitial) {
          refreshes += 1;
          counters.refreshed += 1;
          emit(ctx, "ok", { event: "refreshed", externalMessageId: waMessageId });
        }
        scheduleNext();
      } else {
        consecutiveFailures += 1;
        counters.metaFailures += 1;
        emit(
          ctx,
          "error",
          { event: "meta_error", externalMessageId: waMessageId, failures: consecutiveFailures },
          "typing indicator request failed (Meta API)",
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          selfStop("meta_failures");
          return;
        }
        scheduleNext();
      }
    };

    const selfStop = (reason: string): void => {
      if (!active) return;
      active = false;
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      activeSessions.delete(waMessageId);
      counters.stopped += 1;
      emit(
        ctx,
        "ok",
        {
          event: "stopped",
          externalMessageId: waMessageId,
          reason,
          durationMs: Date.now() - startedAt,
        },
        undefined,
        Date.now() - startedAt,
      );
    };

    const handle = (): void => selfStop("completed");

    if (!config.typingIndicator) {
      active = false;
      void sender.markRead(waMessageId).catch(() => false);
      counters.started += 1;
      emit(ctx, "ok", { event: "started", externalMessageId: waMessageId });
      emit(ctx, "ok", {
        event: "stopped",
        externalMessageId: waMessageId,
        reason: "typing_disabled",
        durationMs: 0,
      });
      counters.stopped += 1;
      return handle;
    }

    activeSessions.set(waMessageId, handle);
    counters.started += 1;
    emit(ctx, "ok", { event: "started", externalMessageId: waMessageId });
    void runOnce(true);
    return handle;
  };

  const stopAll = (): void => {
    for (const handle of [...activeSessions.values()]) handle();
  };

  const snapshot = (): TypingSnapshot => ({
    active: activeSessions.size,
    started: counters.started,
    refreshed: counters.refreshed,
    stopped: counters.stopped,
    metaFailures: counters.metaFailures,
  });

  return {
    start,
    stopAll,
    snapshot,
  };
}
