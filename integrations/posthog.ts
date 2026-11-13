/**
 * PostHog wrapper (posthog-node 5, official SDK, simplest configuration).
 * Events are fire-and-forget: PostHog problems can NEVER block or break the
 * business flow - the local event ledger in PostgreSQL is the durable record.
 *
 * Privacy law (Phase 3 brief): NO personal or financial data leaves the
 * machine. Only the whitelisted scalar properties are attached; raw message
 * text and amounts ride solely in the local ledger.
 */
import { PostHog } from "posthog-node";

export interface PostHogObservability {
  configured: boolean;
  capture(event: string, distinctId: string, properties: Record<string, string | number | boolean>): void;
  flush(): Promise<void>;
}

export function createPostHogObservability(options: {
  publicKey?: string;
  host: string;
  onProblem?: (detail: string) => void;
}): PostHogObservability {
  const { publicKey, host, onProblem } = options;
  if (!publicKey || publicKey.includes("replace_me")) {
    onProblem?.("posthog not configured (no public key) - local ledger only");
    return { configured: false, capture: () => undefined, flush: async () => undefined };
  }

  let client: PostHog;
  try {
    client = new PostHog(publicKey, { host });
  } catch (error) {
    onProblem?.(`posthog init failed: ${error instanceof Error ? error.message : String(error)}`);
    return { configured: false, capture: () => undefined, flush: async () => undefined };
  }

  return {
    configured: true,
    capture(event, distinctId, properties) {
      // posthog-node buffers and retries internally; a capture call itself is
      // safe against network outages. Guard anyway so nothing can escape.
      try {
        client.capture({ event, distinctId, properties });
      } catch (error) {
        onProblem?.(`posthog capture failure: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async flush() {
      try {
        await client.shutdown();
        onProblem?.("posthog flushed: queued events delivered");
      } catch (error) {
        onProblem?.(`posthog flush failure: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
