/**
 * Live-test observer (Milestone 5.2): waits for the NEXT inbound WhatsApp task
 * recorded by the running channel, then prints the turn's evidence - trace id,
 * outcome, tool, failure category, duration - plus the resulting database state
 * (sales / expenses / debts) so each physical message is verified per dimension:
 * webhook receipt, agent execution, tool selection, DB operation, PostHog
 * telemetry (see the server log's posthog:"forwarded" lines), trace id, and
 * processing time.
 *
 *   npx tsx --env-file-if-exists=.env scripts/live-observe.ts --wait 120
 */
import { setTimeout as sleep } from "node:timers/promises";
import { writeSync } from "node:fs";
import { createDb } from "../db/client.js";
import { createStore, type LedgerRow } from "../db/store.js";
import { bindParserConfigStore } from "../lib/parser-config.js";
import { resolveConfig } from "../lib/config.js";

function out(line: string): void {
  writeSync(1, line + "\n");
}

async function latestEventStamp(sql: ReturnType<typeof createDb>): Promise<string> {
  const rows = await sql`SELECT COALESCE(MAX(created_at)::text, '') AS stamp FROM event_ledger`;
  return String((rows[0] as Record<string, unknown>)["stamp"] ?? "");
}

async function printNewEvents(sql: ReturnType<typeof createDb>, sinceStamp: string): Promise<void> {
  const rows = await sql`
    SELECT trace_id, event, status, outcome, failure_category, tool, duration_ms, created_at
    FROM event_ledger
    WHERE event IN ('agent_task_started','agent_task_completed','agent_task_failed',
                    'agent_clarification_required','agent_tool_executed')
      AND created_at::text > ${sinceStamp}
    ORDER BY created_at`;
  for (const raw of rows as unknown as Record<string, unknown>[]) {
    const parts = [
      `trace=${raw["trace_id"]}`,
      String(raw["event"]),
      `status=${raw["status"]}`,
      raw["outcome"] ? `outcome=${raw["outcome"]}` : null,
      raw["failure_category"] ? `category=${raw["failure_category"]}` : null,
      raw["tool"] ? `tool=${raw["tool"]}` : null,
      raw["duration_ms"] ? `durationMs=${raw["duration_ms"]}` : null,
      String((raw["created_at"] as Date).toISOString().slice(11, 23)),
    ].filter(Boolean);
    out(`    ${parts.join(" ")}`);
  }
}

async function printDbState(sql: ReturnType<typeof createDb>): Promise<void> {
  const sales = await sql`SELECT description, quantity, amount FROM sales ORDER BY recorded_at DESC LIMIT 4`;
  const expenses = await sql`SELECT category, amount FROM expenses ORDER BY recorded_at DESC LIMIT 4`;
  const debts = await sql`SELECT c.name, d.amount_due, d.amount_paid, (d.amount_due - d.amount_paid) AS outstanding
    FROM debts d JOIN customers c ON c.id = d.customer_id ORDER BY d.created_at DESC LIMIT 4`;
  out(`    DB sales: ${sales.map((s) => `${(s as Record<string, unknown>)["description"]}×${(s as Record<string, unknown>)["quantity"]}=${Number((s as Record<string, unknown>)["amount"])}`).join("; ") || "none"}`);
  out(`    DB expenses: ${expenses.map((e) => `${(e as Record<string, unknown>)["category"]}=${Number((e as Record<string, unknown>)["amount"])}`).join("; ") || "none"}`);
  out(`    DB debts: ${debts.map((d) => `${(d as Record<string, unknown>)["name"]}: due=${Number((d as Record<string, unknown>)["amount_due"])}, paid=${Number((d as Record<string, unknown>)["amount_paid"])}, outstanding=${Number((d as Record<string, unknown>)["outstanding"])}`).join("; ") || "none"}`);
}

async function main(): Promise<void> {
  const { config } = resolveConfig();
  const sql = createDb(config.databaseUrl);
  const store = createStore(sql);
  bindParserConfigStore(store);

  const beforeStamp = await latestEventStamp(sql);
  const waitSeconds = Number(process.argv[process.argv.indexOf("--wait") + 1] ?? "") || 120;
  out(`live-observe: waiting up to ${waitSeconds}s for inbound traffic newer than ${beforeStamp || "(empty ledger)"}...`);

  const deadline = Date.now() + waitSeconds * 1000;
  let stamp = beforeStamp;
  let observed = false;
  while (Date.now() < deadline) {
    await sleep(2000);
    const newStamp = await latestEventStamp(sql);
    if (newStamp && newStamp > stamp) {
      stamp = newStamp;
      observed = true;
    }
  }
  if (observed) {
    out(`  events since wait start:`);
    await printNewEvents(sql, beforeStamp);
    await printDbState(sql);
  } else {
    out("  no new inbound traffic within the wait window");
  }
  process.exit(0);
}

void main().catch((error) => {
  out(`live-observe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
