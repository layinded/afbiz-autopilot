/**
 * Applies db/schema.sql to the configured isolated PostgreSQL database
 * (creates the database first if missing). Idempotent: safe to re-run.
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { applySchema } from "../db/apply.js";
import { logger, resolveConfig } from "../lib/config.js";

async function ensureDatabase(adminUrl: string, databaseName: string): Promise<void> {
  const url = new URL(adminUrl);
  url.pathname = "/postgres";
  const admin = postgres(url.toString(), { max: 1, connect_timeout: 5 });
  try {
    const found = await admin`SELECT 1 FROM pg_database WHERE datname = ${databaseName}`;
    if (found.length === 0) {
      if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) throw new Error(`unsafe database name: ${databaseName}`);
      await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const { config } = resolveConfig();
  const databaseName = (new URL(config.databaseUrl).pathname.replace(/^\//, "") || "postgres").trim();
  await ensureDatabase(config.databaseUrl, databaseName);

  const sql = postgres(config.databaseUrl, { max: 1, connect_timeout: 5 });
  try {
    const applied = await applySchema(sql);
    logger.info("schema_applied", { database: databaseName, statements: applied });

    const storeCreator = await import("../db/store.js");
    const store = storeCreator.createStore(sql);
    await store.ensureParserVersion("parser_v1", { shorthand: [] });
    const candidate = JSON.parse(readFileSync(new URL("../improvement/configs/parser_v2.json", import.meta.url), "utf8")) as Record<string, unknown>;
    await store.insertParserConfig("parser_v2", candidate);
    logger.info("parser_baseline_seeded", { version: "parser_v1", candidate_registered: "parser_v2", candidate_active: false });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  logger.error("db_setup_failed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
