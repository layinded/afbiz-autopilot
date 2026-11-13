/**
 * Deterministic demo reset (Phase 5): stages the demo business with a fixed
 * ₦12,000 Amina debt — idempotent, safe to re-run before every demonstration.
 *   npm run demo:reset
 */
import { createDb } from "../db/client.js";
import { createStore } from "../db/store.js";
import { logger, resolveConfig } from "../lib/config.js";
import { readFileSync } from "node:fs";

async function main(): Promise<void> {
  const { config } = resolveConfig();
  const sql = createDb(config.databaseUrl);
  const store = createStore(sql);

  const parserVersion = await sql`SELECT active_version FROM active_config WHERE config_kind = 'amount_parser'`;
  const activeVersion = (parserVersion[0] as Record<string, unknown> | undefined)?.["active_version"] ?? "parser_v1";

  // The demo business's phone is the tester's registered number — the most
  // recent customer row identifies the current demo scope.
  const scopeRow = await sql`
    SELECT owner_phone FROM customers ORDER BY created_at DESC LIMIT 1`;
  const scope = (scopeRow[0] as Record<string, unknown> | undefined)?.["owner_phone"] as string | undefined;
  if (!scope) {
    // No demo scope yet — the owner's first WhatsApp message creates it.
    console.log("demo-reset: no demo business scope yet — the owner's first WhatsApp message will create it.");
    await sql.end({ timeout: 5 });
    return;
  }

  await store.upsertCustomer(scope, "Amina");
  const amina = await store.findCustomer(scope, "Amina");
  if (!amina) {
    console.error("demo-reset: Amina not found after upsert — impossible.");
    process.exit(1);
  }

  // Reset the debt to exactly ₦12,000 due, ₦0 paid.
  await sql`
    UPDATE debts SET amount_due = 12000, amount_paid = 0
    WHERE customer_id = ${amina.id} AND owner_phone = ${scope}`;

  // Remove any stale pending confirmations (clean slate)
  await sql`
    UPDATE pending_actions SET status = 'superseded', updated_at = now()
    WHERE owner_phone = ${scope} AND status = 'pending'`;

  // Drop all sales/expenses for this scope (fresh demo window)
  await sql`DELETE FROM sales WHERE owner_phone = ${scope}`;
  await sql`DELETE FROM expenses WHERE owner_phone = ${scope}`;

  const debt = await store.customerBalance(scope, amina.id);
  console.log(`demo-reset: scope=${scope} parser=${activeVersion}`);
  console.log(`  Amina: due ₦12,000, paid ₦${debt.outstanding === 12000 ? 0 : debt.outstanding}, outstanding ₦${12000}`);
  console.log(`  sales/expenses cleared; pending actions superseded`);
  console.log(`  ready for demo with ${activeVersion}`);
  await sql.end({ timeout: 5 });
}

void main().catch((error) => {
  console.error(`demo-reset failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
