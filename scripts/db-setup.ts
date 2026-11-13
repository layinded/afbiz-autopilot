/**
 * Applies db/schema.sql to the configured isolated PostgreSQL database
 * (creates the database first if missing). Idempotent: safe to re-run.
 */
import postgres from "postgres";
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
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  logger.error("db_setup_failed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
