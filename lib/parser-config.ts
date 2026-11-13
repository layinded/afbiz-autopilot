/**
 * Versioned amount-parser configuration (Phase 4): the ONLY mutation surface
 * the self-improvement loop may touch. The active version lives in PostgreSQL
 * and the running agent re-reads it through a TTL cache - activation needs no
 * restart. Tests can pin a config directly through the override hook.
 */
import type { Store } from "../db/store.js";

export interface ShorthandRule {
  suffix: "k" | "m";
  factor: number;
}

export interface AmountParserConfig {
  shorthand: ShorthandRule[];
}

export const BASELINE_PARSER_CONFIG: AmountParserConfig = { shorthand: [] };

export const KNOWN_PARSER_SHORTHANDS: Record<"k" | "m", number> = {
  k: 1_000,
  m: 1_000_000,
};

export function isValidParserConfig(config: unknown): config is AmountParserConfig {
  if (!config || typeof config !== "object") return false;
  const shorthand = (config as { shorthand?: unknown }).shorthand;
  if (!Array.isArray(shorthand)) return false;
  const seen = new Set<string>();
  for (const rule of shorthand) {
    if (!rule || typeof rule !== "object") return false;
    const suffix = (rule as { suffix?: unknown }).suffix;
    const factor = (rule as { factor?: unknown }).factor;
    if (suffix !== "k" && suffix !== "m") return false;
    if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) return false;
    if (factor !== KNOWN_PARSER_SHORTHANDS[suffix]) return false;
    if (seen.has(suffix)) return false;
    seen.add(suffix);
  }
  return true;
}

export const ACTIVE_CONFIG_TTL_MS = 5_000;

let override: AmountParserConfig | undefined;
let cached: { config: AmountParserConfig; fetchedAt: number } | null = null;
let storeRef: Store | null = null;

/** Binds the live store used by the TTL resolver (called once at boot). */
export function bindParserConfigStore(store: Store | null): void {
  storeRef = store;
  cached = null;
}

/** Test hook: pin a config; undefined clears the pin (store pointer resumes). */
export function setActiveParserOverride(config: AmountParserConfig | undefined): void {
  override = config;
  cached = null;
}

export async function getActiveParserConfig(): Promise<AmountParserConfig> {
  if (override !== undefined) return override;
  if (storeRef && (!cached || Date.now() - cached.fetchedAt >= ACTIVE_CONFIG_TTL_MS)) {
    try {
      const raw = await storeRef.getActiveParserConfig("amount_parser");
      if (isValidParserConfig(raw)) {
        cached = { config: raw, fetchedAt: Date.now() };
      } else if (!cached) {
        cached = { config: BASELINE_PARSER_CONFIG, fetchedAt: Date.now() };
      }
    } catch {
      if (!cached) cached = { config: BASELINE_PARSER_CONFIG, fetchedAt: Date.now() };
    }
  }
  return cached?.config ?? BASELINE_PARSER_CONFIG;
}
