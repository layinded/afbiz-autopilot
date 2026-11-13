/** Shared test database helpers: one isolated local PostgreSQL, truncated between cases. */
import { createDb, type PgClient } from "../../db/client.js";
import { applySchema } from "../../db/apply.js";

export const TEST_DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/afbiz_autopilot";
export const TEST_OWNER = "+2349000000099";
export const TEST_TODAY = "2026-11-13";

let sql: PgClient;

export function getSql(): PgClient {
  if (!sql) throw new Error("test db not initialized");
  return sql;
}

export async function setupTestDb(): Promise<void> {
  if (!sql) {
    sql = createDb(TEST_DATABASE_URL);
  }
  await applySchema(sql);
}

export async function truncateAll(): Promise<void> {
  await getSql().unsafe(
    "TRUNCATE customers, sales, expenses, debts, pending_actions, webhook_receipts",
  );
}

export async function cleanupTestDb(): Promise<void> {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = undefined as unknown as PgClient;
  }
}
