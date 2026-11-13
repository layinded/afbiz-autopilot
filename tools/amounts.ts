/**
 * The amount parser - THE versioned seam the self-improvement loop will target
 * in a later phase. Phase 2 deliberately handles Meta-typical written forms:
 * "₦45,000", "45,000", "45000", "₦12,000.50", bare decimals.
 *
 * KNOWN LIMITATION (intentional, seeded for the later improvement demo): the
 * "k"/"m" shorthand ("5k" = 5000) is NOT parsed - it fails with reason
 * "unparsable". Do not "fix" this here casually; the improvement loop's
 * regression suite owns that change.
 */
export type CurrencyCode = "NGN";

export type ParsedAmount =
  | { ok: true; value: number; currency: CurrencyCode }
  | {
      ok: false;
      raw: string;
      reason: "empty" | "unsupported_currency" | "unparsable" | "non_positive" | "too_large";
      message: string;
    };

export const DEFAULT_CURRENCY: CurrencyCode = "NGN";
export const MAX_AMOUNT = 1_000_000_000;

type AmountFailReason = Extract<ParsedAmount, { ok: false }>["reason"];

const FAIL_MESSAGES: Record<AmountFailReason, (raw: string) => string> = {
  empty: () => "The amount was empty. Please restate it like ₦5,000.",
  unsupported_currency: (raw) =>
    `"${raw}" looks like a currency I can't record. This business uses ₦ (NGN) - please restate like ₦5,000.`,
  unparsable: (raw) => `I couldn't read the amount "${raw}". Please restate it like ₦5,000.`,
  non_positive: (raw) => `"${raw}" isn't a valid business amount - it must be above zero.`,
  too_large: (raw) => `"${raw}" is above the recordable limit (₦1,000,000,000). Check the amount.`,
};

export function parseAmount(raw: string): ParsedAmount {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { ok: false, raw: "", reason: "empty", message: FAIL_MESSAGES["empty"]("") };
  }
  if (/[$€£¥]/.test(trimmed) || /\b(?:USD|EUR|GBP|JPY|KES|GHS|ZAR)\b/i.test(trimmed)) {
    return { ok: false, raw: trimmed, reason: "unsupported_currency", message: FAIL_MESSAGES["unsupported_currency"](trimmed) };
  }
  let s = trimmed;
  s = s.replace(/^₦\s*/u, "");
  s = s.replace(/^NGN\s*/i, "").replace(/\s*NGN$/i, "");
  s = s.replaceAll(",", "").replaceAll(/\s+/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) {
    return { ok: false, raw: trimmed, reason: "unparsable", message: FAIL_MESSAGES["unparsable"](trimmed) };
  }
  const value = Math.round(Number(s) * 100) / 100;
  if (!Number.isFinite(value)) {
    return { ok: false, raw: trimmed, reason: "unparsable", message: FAIL_MESSAGES["unparsable"](trimmed) };
  }
  if (value <= 0) {
    return { ok: false, raw: trimmed, reason: "non_positive", message: FAIL_MESSAGES["non_positive"](trimmed) };
  }
  if (value > MAX_AMOUNT) {
    return { ok: false, raw: trimmed, reason: "too_large", message: FAIL_MESSAGES["too_large"](trimmed) };
  }
  return { ok: true, value, currency: DEFAULT_CURRENCY };
}

export function parseAmountOrMessage(
  raw: string,
): { ok: true; value: number; currency: CurrencyCode } | { ok: false; error: Extract<ParsedAmount, { ok: false }> } {
  const result = parseAmount(raw);
  return result.ok ? { ok: true, value: result.value, currency: result.currency } : { ok: false, error: result };
}
