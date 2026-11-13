/**
 * Local failure summary (Phase 3, brief task 6): reads the event ledger and
 * prints recent failure counts by category plus the latest failures.
 *   npm run failures            # last 24 hours
 *   npm run failures -- --hours 72 --limit 30
 */
import { createDb } from "../db/client.js";
import { createStore } from "../db/store.js";
import { logger, resolveConfig } from "../lib/config.js";

const argv = process.argv.slice(2);
const take = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  const value = i >= 0 && i + 1 < argv.length ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const hours = take("hours", 24);
const limit = take("limit", 15);

async function main(): Promise<void> {
  const { config } = resolveConfig();
  const sql = createDb(config.databaseUrl);
  try {
    const store = createStore(sql);
    const counts = await store.failureCategoryCounts(hours);
    console.log(`Failure categories (last ${hours}h):`);
    if (counts.length === 0) {
      console.log("  none recorded");
    }
    for (const { category, count } of counts) {
      console.log(`  ${category}: ${count}`);
    }

    const events = await store.eventCounts(hours);
    console.log(`\nAll events (last ${hours}h):`);
    for (const { event, count } of events) {
      console.log(`  ${event}: ${count}`);
    }

    const recent = await store.recentFailures(limit);
    console.log(`\nLatest failures (up to ${limit}):`);
    for (const row of recent) {
      console.log(
        `  ${row.created_at.toISOString()} [${row.failure_category}] ${row.event} tool=${row.tool ?? "-"} trace=${row.trace_id} ${row.error_class ?? ""}`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

void main().catch((error) => {
  logger.error("failures_cli_failed", { error: error instanceof Error ? error.message : String(error) });
  console.error(`failures: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
