/**
 * AFBiz Autopilot service entry: config -> PostgreSQL -> tools -> supervisor
 * agent -> official VoltAgent server (honoServer) with the WhatsApp webhook
 * mounted only when the channel gate passed.
 *
 * Boot fails early on: unreachable PostgreSQL. Boot proceeds with warnings on:
 * missing model key (inference will fail loudly) and WhatsApp disabled (no
 * webhook mounted at all).
 */
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Memory, VoltAgent } from "@voltagent/core";
import { LibSQLMemoryAdapter } from "@voltagent/libsql";
import { honoServer } from "@voltagent/server-hono";
import { logger, resolveConfig } from "../lib/config.js";
import { createDb } from "../db/client.js";
import { createStore } from "../db/store.js";
import { createBusinessTools } from "../tools/index.js";
import { createSupervisorAgent, supervisorInstructions } from "./agent.js";
import { createChatModel } from "./model.js";
import { createWhatsAppChannel } from "../integrations/whatsapp/channel.js";

export async function main(): Promise<{ voltagent: VoltAgent; dispose: () => Promise<void> }> {
  const { config, whatsappDisabledReason } = resolveConfig();
  mkdirSync(".voltagent", { recursive: true });

  const sql = createDb(config.databaseUrl);
  const store = createStore(sql);
  await store.probe();
  logger.info("db_connected", { databaseHost: new URL(config.databaseUrl).host });

  const { tools } = createBusinessTools(store, {
    confirmAmountThreshold: config.confirmAmountThreshold,
    tzOffsetMinutes: config.tzOffsetMinutes,
  });

  const memory = new Memory({
    storage: new LibSQLMemoryAdapter({ url: config.memoryDbUrl }),
    generateTitle: false,
  });

  const { model, info } = createChatModel(config);
  if (!info.authenticated) {
    logger.warn("model_key_missing", {
      hint: "Set MODEL_API_KEY (or the env name in API_KEY_FALLBACKS); inference will fail 401 until then.",
    });
  }

  const supervisor = createSupervisorAgent({ model, memory, tools });

  const channel = config.whatsapp
    ? createWhatsAppChannel({
        verifyToken: config.whatsapp.verifyToken,
        appSecret: config.whatsapp.appSecret,
        sender: config.whatsapp,
        maxPayloadBytes: config.maxPayloadBytes,
        store,
        supervisor,
        maxOutputTokens: config.maxOutputTokens,
        requestTimeoutMs: config.requestTimeoutMs,
        tzOffsetMinutes: config.tzOffsetMinutes,
      })
    : undefined;

  const voltagent = new VoltAgent({
    agents: { supervisor },
    agentMemory: memory,
    server: honoServer({
      port: config.port,
      configureApp: (app) => {
        channel?.mount(app);
      },
    }),
  });

  logger.info("server_started", {
    port: config.port,
    whatsapp: config.whatsapp ? "enabled" : `disabled: ${whatsappDisabledReason}`,
    model: info.modelName,
    modelEndpoint: info.endpointHost,
    businessTimezone: config.businessTimezone,
    confirmAmountThreshold: config.confirmAmountThreshold,
    tools: tools.length,
  });

  return {
    voltagent,
    dispose: async () => {
      await voltagent.stopServer();
      await sql.end({ timeout: 5 });
    },
  };
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main()
    .then(({ dispose }) => {
      let shuttingDown = false;
      const shutdown = (signal: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info("server_stopping", { signal });
        void dispose().finally(() => process.exit(0));
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((error) => {
      logger.error("boot_failed", { error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    });
}
