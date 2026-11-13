/**
 * The amount parser - THE versioned seam the self-improvement loop targets.
 * The active configuration (from PostgreSQL, TTL-cached) decides which forms
 * are valid; the baseline v1 deliberately rejects "k"/"m" shorthand ("5k"),
 * which is the seed of the Phase 4 improvement demonstration. parseAmount()
 * reads the active config; tests and proposals use parseAmountWithConfig().
 */
import { getActiveParserConfig, type AmountParserConfig } from "../lib/parser-config.js";

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

function fail(reason: AmountFailReason, raw: string): ParsedAmount & { ok: false } {
  return { ok: false, raw, reason, message: FAIL_MESSAGES[reason](raw) };
}

function normalizeForm(trimmed: string): { digits: string; currencyFail?: ParsedAmount & { ok: false } } {
  let s = trimmed;
  if (/[$€£¥]/.test(s) || /\b(?:USD|EUR|GBP|JPY|KES|GHS|ZAR)\b/i.test(s)) {
    return { digits: "", currencyFail: fail("unsupported_currency", trimmed) };
  }
  s = s.replace(/^₦\s*/u, "");
  s = s.replace(/^NGN\s*/i, "").replace(/\s*NGN$/i, "");
  s = s.replace(/^N(?=\d)/, "");
  s = s.replaceAll(",", "").replaceAll(/\s+/g, "");
  return { digits: s };
}

function applyShorthand(digits: string, config: AmountParserConfig): { value: number; matched: boolean } {
  const shorthandMatch = /^(\d+(?:\.\d+)?)([a-z])$/i.exec(digits);
  if (!shorthandMatch) {
    return { value: Number.NaN, matched: false };
  }
  const suffix = (shorthandMatch[2] ?? "").toLowerCase();
  const rule = config.shorthand.find((r) => r.suffix === suffix);
  if (!rule) {
    return { value: Number.NaN, matched: false };
  }
  const baseDigit = shorthandMatch[1] ?? "";
  const value = Math.round(Number(baseDigit) * rule.factor * 100) / 100;
  return { value, matched: true };
}

export function parseAmountWithConfig(raw: string, config: AmountParserConfig): ParsedAmount {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fail("empty", "");

  const { digits, currencyFail } = normalizeForm(trimmed);
  if (currencyFail) return currencyFail;

  let value: number;
  if (/^\d+(?:\.\d{1,2})?$/.test(digits)) {
    value = Number(digits);
  } else {
    const shorthand = applyShorthand(digits, config);
    if (!shorthand.matched || !Number.isFinite(shorthand.value)) {
      return fail("unparsable", trimmed);
    }
    value = shorthand.value;
  }

  if (!Number.isFinite(value)) return fail("unparsable", trimmed);
  if (value <= 0) return fail("non_positive", trimmed);
  if (value > MAX_AMOUNT) return fail("too_large", trimmed);
  return { ok: true, value, currency: DEFAULT_CURRENCY };
}

/** Reads the ACTIVE parser configuration (PostgreSQL pointer, TTL cache). */
export async function parseAmount(raw: string): Promise<ParsedAmount> {
  const config = await getActiveParserConfig();
  return parseAmountWithConfig(raw, config);
}

export async function parseAmountOrMessage(
  raw: string,
): Promise<{ ok: true; value: number; currency: CurrencyCode } | { ok: false; error: Extract<ParsedAmount, { ok: false }> }> {
  const result = await parseAmount(raw);
  return result.ok ? { ok: true, value: result.value, currency: result.currency } : { ok: false, error: result };
}
