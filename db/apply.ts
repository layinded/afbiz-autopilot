/** Shared schema application used by scripts/db-setup.ts and the test suite. */
import { readFileSync } from "node:fs";
import type { PgClient } from "./client.js";

export function parseStatements(schemaSql: string): string[] {
  return schemaSql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const SCHEMA_TABLES = [
  "customers",
  "sales",
  "expenses",
  "debts",
  "pending_actions",
  "webhook_receipts",
] as const;

export async function applySchema(sql: PgClient): Promise<number> {
  const schemaSql = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  const list = parseStatements(schemaSql);
  for (const statement of list) {
    await sql.unsafe(statement);
  }
  return list.length;
}
