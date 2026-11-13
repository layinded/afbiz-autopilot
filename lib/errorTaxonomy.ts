/**
 * Error taxonomy — deterministic classification of provider/backend failures
 * into user-safe recovery categories. Lifted from the proven afcloud
 * observability layer; the card text each class produces is honest about the
 * cause and NEVER mentions paid upgrades for failures that are not plan-quota
 * exhaustion.
 */

export type FailureReason = "model_throttled" | "timeout" | "auth" | "backend_quota" | "provider_error";

export function asFailureReason(value: unknown): FailureReason {
  const candidates: FailureReason[] = ["model_throttled", "timeout", "auth", "backend_quota", "provider_error"];
  return candidates.includes(value as FailureReason) ? (value as FailureReason) : "provider_error";
}

const THROTTLED_RE = /status[Cc]ode[":\s]+429|rate.?limit|too many requests|usage limit/i;
const TIMEOUT_RE = /timed? ?out|TimeoutError|abort(ed)?|AbortError|signal/i;
const AUTH_RE = /status[Cs]ode[":\s]+40[13]|unauthori[sz]ed|forbidden|api key/i;
const BACKEND_QUOTA_RE = /quota|plan .* exhausted|wallet/i;

export function classifyProviderFailure(message: string | undefined | null): FailureReason {
  const text = message ?? "";
  if (THROTTLED_RE.test(text)) return "model_throttled";
  if (AUTH_RE.test(text)) return "auth";
  if (TIMEOUT_RE.test(text)) return "timeout";
  return "provider_error";
}

export function recoveryTextFor(reason: FailureReason, detail: string | undefined | null): string {
  switch (reason) {
    case "model_throttled":
      return "The AI service is rate-limited right now. Nothing was changed; try again in a minute.";
    case "timeout":
      return "The request didn't finish in time (the service may be busy). Nothing was changed; try again.";
    case "auth":
      return "The assistant is temporarily offline for maintenance. Nothing was changed; try again shortly.";
    default:
      return `The service is temporarily unavailable. Nothing was changed; try again.${detail ? ` (${detail.slice(0, 90)})` : ""}`;
  }
}

export function isPlanQuotaMessage(text: string | undefined | null): boolean {
  return BACKEND_QUOTA_RE.test(text ?? "");
}
