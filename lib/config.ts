import { randomUUID } from "node:crypto";

/**
 * Environment resolution with fail-closed gates.
 *
 * WhatsApp gate: the channel only mounts when WHATSAPP_ENABLED=1 AND all four
 * Meta credentials are present (proven pattern from the reference repos' config).
 * Anything missing keeps the whole channel unmounted - an unconfigured webhook
 * can never exist.
 */
export interface WhatsAppConfig {
  verifyToken: string;
  appSecret: string;
  accessToken: string;
  phoneNumberId: string;
  graphBaseUrl: string;
  graphVersion: string;
  graphTimeoutMs: number;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  businessTimezone: string;
  tzOffsetMinutes: number;
  confirmAmountThreshold: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  maxPayloadBytes: number;
  memoryDbUrl: string;
  modelProvider: "openai-compatible" | "ollama";
  modelBaseUrl: string;
  modelName: string;
  modelApiKey?: string;
  whatsapp?: WhatsAppConfig;
}

const TZ_OFFSETS: Record<string, number> = {
  // Africa/Lagos has no DST: constant +01:00
  "Africa/Lagos": 60,
};

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): {
  config: AppConfig;
  whatsappDisabledReason?: string;
} {
  const port = num(env["PORT"], 3141);
  const databaseUrl = env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/afbiz_autopilot";
  const businessTimezone = env["BUSINESS_TIMEZONE"] ?? "Africa/Lagos";
  const tzOffsetMinutes =
    TZ_OFFSETS[businessTimezone] ?? num(env["TZ_OFFSET_MINUTES"], 60);
  const confirmAmountThreshold = num(env["CONFIRM_AMOUNT_THRESHOLD"], 1_000_000);

  const modelProvider =
    env["MODEL_PROVIDER"] === "ollama" ? "ollama" : "openai-compatible";
  const modelBaseUrl = env["MODEL_BASE_URL"] ?? "https://ollama.com/v1";
  const modelName = env["MODEL_NAME"] ?? "gpt-oss:20b";
  const fallbackNames = (env["API_KEY_FALLBACKS"] ?? "OLLAMA_CLOUD_KEY_1,OLLAMA_CLOUD_KEY_2")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const modelApiKey =
    env["MODEL_API_KEY"]?.trim() || fallbackNames.map((n) => env[n]?.trim() ?? "").find(Boolean);

  let whatsapp: WhatsAppConfig | undefined;
  let whatsappDisabledReason: string | undefined;
  const verifyToken = env["WHATSAPP_VERIFY_TOKEN"]?.trim();
  const appSecret = env["WHATSAPP_APP_SECRET"]?.trim();
  const accessToken = env["WHATSAPP_ACCESS_TOKEN"]?.trim();
  const phoneNumberId = env["WHATSAPP_PHONE_NUMBER_ID"]?.trim();
  if (env["WHATSAPP_ENABLED"] === "1" && verifyToken && appSecret && accessToken && phoneNumberId) {
    whatsapp = {
      verifyToken,
      appSecret,
      accessToken,
      phoneNumberId,
      graphBaseUrl: env["WHATSAPP_GRAPH_BASE_URL"] ?? "https://graph.facebook.com",
      graphVersion: env["WHATSAPP_GRAPH_VERSION"] ?? "v23.0",
      graphTimeoutMs: num(env["WHATSAPP_GRAPH_TIMEOUT_MS"], 15_000),
    };
  } else {
    whatsappDisabledReason =
      env["WHATSAPP_ENABLED"] !== "1"
        ? "WHATSAPP_ENABLED!=1"
        : "missing WHATSAPP_VERIFY_TOKEN / APP_SECRET / ACCESS_TOKEN / PHONE_NUMBER_ID";
  }

  return {
    config: {
      port,
      databaseUrl,
      businessTimezone,
      tzOffsetMinutes,
      confirmAmountThreshold,
      maxOutputTokens: num(env["MAX_OUTPUT_TOKENS"], 1000),
      requestTimeoutMs: num(env["REQUEST_TIMEOUT_MS"], 90_000),
      maxPayloadBytes: num(env["WHATSAPP_MAX_PAYLOAD_BYTES"], 1_048_576),
      memoryDbUrl: env["MEMORY_DB_URL"] ?? "file:./.voltagent/memory.db",
      modelProvider,
      modelBaseUrl,
      modelName,
      modelApiKey,
      whatsapp,
    },
    whatsappDisabledReason,
  };
}

export type LogFields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger = {
  info: (event: string, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => emit("error", event, fields),
};

export function newTraceId(): string {
  return `t_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function maskPhone(phone: string): string {
  return `+***${phone.slice(-4)}`;
}
