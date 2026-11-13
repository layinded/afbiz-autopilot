/**
 * Failure classifier for Phase 3: distinguishes the five business failure
 * classes on top of the lifted afcloud provider taxonomy. Pure functions, no
 * I/O - callers emit the results.
 */

export type FailureCategory =
  | "amount_parsing"
  | "missing_information"
  | "tool_execution"
  | "database"
  | "unsupported_request"
  | "provider_error"
  | "provider_throttled"
  | "provider_timeout"
  | "provider_auth";

export function classifyToolError(error: unknown): FailureCategory {
  const name = (error as { name?: string } | undefined)?.name ?? "";
  const code = (error as { code?: string } | undefined)?.code ?? "";
  if (name === "postgres" || name === "PostgresError" || /^\d{5}$/.test(code)) return "database";
  if (error instanceof Error && error.message === "amount_unparsable") return "amount_parsing";
  return "tool_execution";
}

/** Classify a known business-refusal error name returned by a tool. */
export function classifyBusinessRefusal(errorName: string): FailureCategory | null {
  if (errorName === "amount_unparsable") return "amount_parsing";
  if (errorName === "customer_not_found") return "missing_information";
  return null;
}

/**
 * Classify an agent reply with no tool call into the brief's outcome classes:
 * explicit decline/capability language wins over a trailing question (models
 * often append "How can I assist?" after refusing), then a trailing question is
 * a clarification request; otherwise null.
 */
export function classifyReplyWithoutTool(text: string): "missing_information" | "unsupported_request" | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const head = trimmed.slice(0, 80);
  if (/\b(?:i'?m sorry|sorry|i can'?t|can'?t|cannot|unable|not able)\b/i.test(head)) {
    return "unsupported_request";
  }
  if (trimmed.endsWith("?")) return "missing_information";
  return null;
}

export const PROVIDER_CATEGORY: Record<string, FailureCategory> = {
  model_throttled: "provider_throttled",
  timeout: "provider_timeout",
  auth: "provider_auth",
  provider_error: "provider_error",
};
