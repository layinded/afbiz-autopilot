/**
 * Business data access on the isolated PostgreSQL database.
 * Every row is scoped by owner_phone (the WhatsApp user of the demo business).
 */
import type { PgClient } from "./client.js";

export interface CustomerRow {
  id: string;
  owner_phone: string;
  name: string;
  normalized_name: string;
}

export interface SaleRow {
  id: string;
  owner_phone: string;
  description: string;
  quantity: number;
  amount: number;
  currency: string;
  customer_id: string | null;
  recorded_at: Date;
}

export interface ExpenseRow {
  id: string;
  owner_phone: string;
  category: string;
  description: string | null;
  amount: number;
  currency: string;
  recorded_at: Date;
}

export interface DebtRow {
  id: string;
  owner_phone: string;
  customer_id: string;
  description: string;
  amount_due: number;
  amount_paid: number;
  currency: string;
}

export interface PendingRow {
  id: string;
  owner_phone: string;
  tool: string;
  payload: Record<string, unknown>;
  summary: string;
  status: "pending" | "confirmed" | "cancelled" | "superseded";
}

export interface PeriodSummary {
  total: number;
  count: number;
}

export interface BalanceSummary {
  outstanding: number;
  openDebts: number;
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** UTC instant boundaries of the owner's business day for a fixed-offset zone. */
export function businessDayRange(now: Date, tzOffsetMinutes: number): { from: Date; to: Date; date: string } {
  const shifted = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  const date = shifted.toISOString().slice(0, 10);
  const from = new Date(new Date(`${date}T00:00:00Z`).getTime() - tzOffsetMinutes * 60_000);
  const to = new Date(from.getTime() + 24 * 60 * 60_000);
  return { from, to, date };
}

export type ReceiptClaim = "claimed" | "duplicate";

export interface ProposalRow {
  id: string;
  version: string;
  config: Record<string, unknown>;
  rationale: string;
  evidence: Record<string, unknown>;
  diagnosis: string;
  tests_passed: boolean;
  test_report: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "discarded";
  approval_token_hash: string;
}

export interface LedgerEntry {
  traceId: string;
  event: string;
  tool?: string;
  agentVersion: string;
  status: "success" | "failure" | "info";
  outcome?: string;
  failureCategory?: string;
  durationMs?: number;
  improvementVersion?: string;
  errorClass?: string;
  payload?: Record<string, unknown>;
}

export interface LedgerRow {
  trace_id: string;
  event: string;
  tool: string | null;
  agent_version: string;
  status: string;
  outcome: string | null;
  failure_category: string | null;
  duration_ms: number | null;
  error_class: string | null;
  payload?: Record<string, unknown>;
  created_at: Date;
}

/**
 * postgres.js hands jsonb columns back as a parsed object in some query shapes
 * and as a raw string through RETURNING - normalize both to an object.
 */
function normalizePendingRow(row: Record<string, unknown>): PendingRow {
  const payload = row["payload"];
  return {
    ...row,
    payload: typeof payload === "string" ? (JSON.parse(payload) as Record<string, unknown>) : (payload as Record<string, unknown>),
  } as PendingRow;
}

function normalizeProposalRow(raw: Record<string, unknown>): ProposalRow {
  const parse = (value: unknown): Record<string, unknown> => {
    if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
    return value === null || value === undefined ? {} : (value as Record<string, unknown>);
  };
  return {
    ...raw,
    config: parse(raw["config"]),
    evidence: parse(raw["evidence"]),
    test_report: parse(raw["test_report"]),
  } as ProposalRow;
}

export function createStore(sql: PgClient) {
  return {
    async probe(): Promise<void> {
      await sql`SELECT 1`;
    },

    async upsertCustomer(ownerPhone: string, name: string): Promise<CustomerRow> {
      const rows = await sql`
        INSERT INTO customers (owner_phone, name, normalized_name)
        VALUES (${ownerPhone}, ${name.trim()}, ${normalizeName(name)})
        ON CONFLICT (owner_phone, normalized_name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id, owner_phone, name, normalized_name`;
      const row = rows[0] as CustomerRow;
      return row;
    },

    async findCustomer(ownerPhone: string, name: string): Promise<CustomerRow | null> {
      const rows = await sql`SELECT id, owner_phone, name, normalized_name FROM customers
        WHERE owner_phone = ${ownerPhone} AND normalized_name = ${normalizeName(name)} LIMIT 1`;
      return (rows[0] as CustomerRow) ?? null;
    },

    /** Same owner, name contains the query but is not an exact match. */
    async listSimilarCustomers(ownerPhone: string, name: string, limit = 5): Promise<CustomerRow[]> {
      const like = `%${normalizeName(name).replace(/[%_]/g, "")}%`;
      const rows = await sql`SELECT id, owner_phone, name, normalized_name FROM customers
        WHERE owner_phone = ${ownerPhone} AND normalized_name LIKE ${like}
          AND normalized_name <> ${normalizeName(name)}
        ORDER BY length(normalized_name), normalized_name LIMIT ${limit}`;
      return rows as unknown as CustomerRow[];
    },

    async insertSale(
      ownerPhone: string,
      sale: { description: string; quantity: number; amount: number; currency: string; customerId?: string | null },
    ): Promise<SaleRow> {
      const rows = await sql`
        INSERT INTO sales (owner_phone, description, quantity, amount, currency, customer_id)
        VALUES (${ownerPhone}, ${sale.description}, ${sale.quantity}, ${sale.amount}, ${sale.currency}, ${sale.customerId ?? null})
        RETURNING id, owner_phone, description, quantity, amount, currency, customer_id, recorded_at`;
      const row = rows[0] as SaleRow;
      return { ...row, amount: Number(row.amount) };
    },

    async insertExpense(
      ownerPhone: string,
      expense: { category: string; description?: string | null; amount: number; currency: string },
    ): Promise<ExpenseRow> {
      const rows = await sql`
        INSERT INTO expenses (owner_phone, category, description, amount, currency)
        VALUES (${ownerPhone}, ${expense.category}, ${expense.description ?? null}, ${expense.amount}, ${expense.currency})
        RETURNING id, owner_phone, category, description, amount, currency, recorded_at`;
      const row = rows[0] as ExpenseRow;
      return { ...row, amount: Number(row.amount) };
    },

    async insertDebt(
      ownerPhone: string,
      customerId: string,
      debt: { description: string; amount: number; currency: string },
    ): Promise<DebtRow> {
      const rows = await sql`
        INSERT INTO debts (owner_phone, customer_id, description, amount_due, currency)
        VALUES (${ownerPhone}, ${customerId}, ${debt.description}, ${debt.amount}, ${debt.currency})
        RETURNING id, owner_phone, customer_id, description, amount_due, amount_paid, currency`;
      const row = rows[0] as DebtRow;
      return { ...row, amount_due: Number(row.amount_due), amount_paid: Number(row.amount_paid) };
    },

    async salesSummary(ownerPhone: string, from: Date, to: Date): Promise<PeriodSummary> {
      const rows = await sql`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
        FROM sales WHERE owner_phone = ${ownerPhone} AND recorded_at >= ${from} AND recorded_at < ${to}`;
      const row = rows[0] as { total: string | number; count: number };
      return { total: Number(row.total), count: Number(row.count) };
    },

    async expensesSummary(ownerPhone: string, from: Date, to: Date): Promise<PeriodSummary> {
      const rows = await sql`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
        FROM expenses WHERE owner_phone = ${ownerPhone} AND recorded_at >= ${from} AND recorded_at < ${to}`;
      const row = rows[0] as { total: string | number; count: number };
      return { total: Number(row.total), count: Number(row.count) };
    },

    async allTimeSummary(ownerPhone: string): Promise<{ salesTotal: number; salesCount: number; expensesTotal: number; expensesCount: number }> {
      const rows = await sql`SELECT
          (SELECT COALESCE(SUM(amount), 0) FROM sales WHERE owner_phone = ${ownerPhone}) AS sales_total,
          (SELECT COUNT(*) FROM sales WHERE owner_phone = ${ownerPhone}) AS sales_count,
          (SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE owner_phone = ${ownerPhone}) AS expenses_total,
          (SELECT COUNT(*) FROM expenses WHERE owner_phone = ${ownerPhone}) AS expenses_count`;
      const row = rows[0] as { sales_total: string | number; sales_count: number; expenses_total: string | number; expenses_count: number };
      return {
        salesTotal: Number(row.sales_total),
        salesCount: Number(row.sales_count),
        expensesTotal: Number(row.expenses_total),
        expensesCount: Number(row.expenses_count),
      };
    },

    async outstandingDebtSummary(ownerPhone: string): Promise<BalanceSummary> {
      const rows = await sql`SELECT COALESCE(SUM(amount_due - amount_paid), 0) AS outstanding,
        COUNT(*) FILTER (WHERE amount_paid < amount_due) AS open_debts
        FROM debts WHERE owner_phone = ${ownerPhone}`;
      const row = rows[0] as { outstanding: string | number; open_debts: number };
      return { outstanding: Number(row.outstanding), openDebts: Number(row.open_debts) };
    },

    async customerBalance(ownerPhone: string, customerId: string): Promise<BalanceSummary> {
      const rows = await sql`SELECT COALESCE(SUM(amount_due - amount_paid), 0) AS outstanding,
        COUNT(*) FILTER (WHERE amount_paid < amount_due) AS open_debts
        FROM debts WHERE owner_phone = ${ownerPhone} AND customer_id = ${customerId}`;
      const row = rows[0] as { outstanding: string | number; open_debts: number };
      return { outstanding: Number(row.outstanding), openDebts: Number(row.open_debts) };
    },

    // --- Duplicate-message protection ---
    async claimReceipt(waMessageId: string, kind: string, preview: string): Promise<ReceiptClaim> {
      const inserted = await sql`
        INSERT INTO webhook_receipts (wa_message_id, kind, preview)
        VALUES (${waMessageId}, ${kind}, ${preview})
        ON CONFLICT (wa_message_id) DO NOTHING
        RETURNING wa_message_id`;
      return inserted.length > 0 ? "claimed" : "duplicate";
    },

    async markReceipt(waMessageId: string, status: "processed" | "failed"): Promise<void> {
      await sql`UPDATE webhook_receipts SET status = ${status} WHERE wa_message_id = ${waMessageId}`;
    },

    // --- Confirmation flow ---
    async createPending(
      ownerPhone: string,
      tool: string,
      payload: Record<string, unknown>,
      summary: string,
    ): Promise<PendingRow> {
      const rows = await sql`
        WITH superseded AS (
          UPDATE pending_actions SET status = 'superseded', updated_at = now()
          WHERE owner_phone = ${ownerPhone} AND status = 'pending'
          RETURNING id
        )
        INSERT INTO pending_actions (owner_phone, tool, payload, summary)
        VALUES (${ownerPhone}, ${tool}, ${JSON.stringify(payload)}::jsonb, ${summary})
        RETURNING id, owner_phone, tool, payload, summary, status`;
      return normalizePendingRow(rows[0] as unknown as Record<string, unknown>);
    },

    /** Atomically consume the sender's latest pending action, or null if none. */
    async consumePending(ownerPhone: string, decision: "confirm" | "cancel"): Promise<PendingRow | null> {
      const status = decision === "confirm" ? "confirmed" : "cancelled";
      const rows = await sql`
        UPDATE pending_actions SET status = ${status}, updated_at = now()
        WHERE id = (
          SELECT id FROM pending_actions
          WHERE owner_phone = ${ownerPhone} AND status = 'pending'
          ORDER BY created_at DESC
          LIMIT 1
        )
        RETURNING id, owner_phone, tool, payload, summary, status`;
      return (rows[0] as unknown as Record<string, unknown> | undefined) ? normalizePendingRow(rows[0] as unknown as Record<string, unknown>) : null;
    },

    // --- Local event ledger ---
    async recordEventLedger(entry: LedgerEntry): Promise<void> {
      await sql`
        INSERT INTO event_ledger
          (trace_id, event, tool, agent_version, status, outcome, failure_category, duration_ms, improvement_version, error_class, payload)
        VALUES (
          ${entry.traceId}, ${entry.event}, ${entry.tool ?? null}, ${entry.agentVersion}, ${entry.status},
          ${entry.outcome ?? null}, ${entry.failureCategory ?? null}, ${entry.durationMs ?? null},
          ${entry.improvementVersion ?? null}, ${entry.errorClass ?? null}, ${JSON.stringify(entry.payload ?? {})}::jsonb
        )`;
    },

    async recentFailures(limit = 20): Promise<LedgerRow[]> {
      const rows = await sql`
        SELECT trace_id, event, tool, agent_version, status, outcome, failure_category, duration_ms, error_class, payload, created_at
        FROM event_ledger
        WHERE failure_category IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ${limit}`;
      return rows.map((row) => {
        const raw = row as Record<string, unknown>;
        const payload = typeof raw["payload"] === "string" ? JSON.parse(String(raw["payload"])) : (raw["payload"] ?? {});
        return { ...raw, payload } as unknown as LedgerRow;
      });
    },

    async failureCategoryCounts(hours = 24): Promise<{ category: string; count: number }[]> {
      const rows = await sql`
        SELECT failure_category AS category, COUNT(*) AS count
        FROM event_ledger
        WHERE failure_category IS NOT NULL AND created_at > now() - ${`${hours} hours`}::interval
        GROUP BY failure_category
        ORDER BY count DESC`;
      return rows.map((row) => ({
        category: String((row as Record<string, unknown>)["category"]),
        count: Number((row as Record<string, unknown>)["count"]),
      }));
    },

    async eventCounts(hours = 24): Promise<{ event: string; count: number }[]> {
      const rows = await sql`
        SELECT event, COUNT(*) AS count
        FROM event_ledger
        WHERE created_at > now() - ${`${hours} hours`}::interval
        GROUP BY event
        ORDER BY count DESC`;
      return rows.map((row) => ({
        event: String((row as Record<string, unknown>)["event"]),
        count: Number((row as Record<string, unknown>)["count"]),
      }));
    },

    async ensureParserVersion(seedVersion: string, seedConfig: unknown): Promise<void> {
      await sql`
        INSERT INTO parse_configs (version, config)
        VALUES (${seedVersion}, ${JSON.stringify(seedConfig)}::jsonb)
        ON CONFLICT (version) DO UPDATE SET config = EXCLUDED.config`;
      await sql`
        INSERT INTO active_config (config_kind, active_version)
        VALUES ('amount_parser', ${seedVersion})
        ON CONFLICT (config_kind) DO NOTHING`;
    },

    async getActiveParserVersion(kind: "amount_parser"): Promise<string> {
      const rows = await sql`SELECT active_version FROM active_config WHERE config_kind = ${kind}`;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        await this.ensureParserVersion("parser_v1", { shorthand: [] });
        return "parser_v1";
      }
      return String(row["active_version"]);
    },

    async getActiveParserConfig(kind: "amount_parser"): Promise<unknown> {
      const version = await this.getActiveParserVersion(kind);
      const rows = await sql`SELECT config FROM parse_configs WHERE version = ${version}`;
      const row = rows[0] as Record<string, unknown> | undefined;
      const raw = row ? row["config"] : null;
      if (typeof raw === "string") return JSON.parse(raw) as unknown;
      return raw ?? { shorthand: [] };
    },

    async insertParserConfig(version: string, config: unknown): Promise<void> {
      await sql`
        INSERT INTO parse_configs (version, config)
        VALUES (${version}, ${JSON.stringify(config)}::jsonb)
        ON CONFLICT (version) DO UPDATE SET config = EXCLUDED.config`;
    },

    async setActiveParserConfig(kind: "amount_parser", version: string): Promise<void> {
      await sql`
        INSERT INTO active_config (config_kind, active_version, updated_at)
        VALUES (${kind}, ${version}, now())
        ON CONFLICT (config_kind) DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()`;
    },

    async listParserVersions(): Promise<{ version: string; created_at: Date; config: unknown }[]> {
      const rows = await sql`SELECT version, created_at, config FROM parse_configs ORDER BY created_at`;
      return rows.map((row) => {
        const raw = row as Record<string, unknown>;
        const config = typeof raw["config"] === "string" ? JSON.parse(String(raw["config"])) : raw["config"];
        return { version: String(raw["version"]), created_at: raw["created_at"] as Date, config };
      });
    },

    async applyCustomerPayment(
      ownerPhone: string,
      customerId: string,
      amount: number,
      currency: string,
    ): Promise<{ applied: number; outstanding: number; payments: { debtId: string; applied: number }[] }> {
      const payments: { debtId: string; applied: number }[] = [];
      let remaining = amount;
      const open = (await sql`
        SELECT id, amount_due, amount_paid FROM debts
        WHERE owner_phone = ${ownerPhone} AND customer_id = ${customerId}
          AND amount_paid < amount_due AND amount_due > 0
        ORDER BY created_at, id`) as unknown as { id: string; amount_due: number; amount_paid: number }[];
      for (const debt of open) {
        if (remaining <= 0) break;
        const due = Number(debt.amount_due);
        const paid = Number(debt.amount_paid);
        const toApply = Math.min(remaining, Math.round((due - paid) * 100) / 100);
        if (toApply <= 0) continue;
        await sql`UPDATE debts SET amount_paid = amount_paid + ${toApply} WHERE id = ${debt.id}`;
        payments.push({ debtId: debt.id, applied: toApply });
        remaining = Math.round((remaining - toApply) * 100) / 100;
      }
      const balance = await this.customerBalance(ownerPhone, customerId);
      return { applied: Math.round((amount - remaining) * 100) / 100, outstanding: balance.outstanding, payments };
    },

    async saveProposal(entry: {
      version: string;
      config: unknown;
      rationale: string;
      evidence: unknown;
      diagnosis: string;
      testsPassed: boolean;
      testReport: unknown;
      approvalTokenHash: string;
    }): Promise<string> {
      const rows = await sql`
        INSERT INTO improvement_proposals
          (version, config, rationale, evidence, diagnosis, tests_passed, test_report, status, approval_token_hash)
        VALUES (
          ${entry.version}, ${JSON.stringify(entry.config)}::jsonb, ${entry.rationale},
          ${JSON.stringify(entry.evidence)}::jsonb, ${entry.diagnosis},
          ${entry.testsPassed}, ${JSON.stringify(entry.testReport)}::jsonb, 'pending', ${entry.approvalTokenHash})
        RETURNING id`;
      return String((rows[0] as Record<string, unknown>)["id"]);
    },

    async getProposal(id: string): Promise<ProposalRow | null> {
      const rows = await sql`SELECT id, version, config, rationale, evidence, diagnosis, tests_passed, test_report, status, approval_token_hash, created_at
        FROM improvement_proposals WHERE id = ${id}`;
      const raw = rows[0] as Record<string, unknown> | undefined;
      return raw ? normalizeProposalRow(raw) : null;
    },

    async approveProposal(id: string, tokenHash: string): Promise<ProposalRow | null> {
      const rows = await sql`
        UPDATE improvement_proposals
        SET status = 'approved', decided_at = now()
        WHERE id = ${id} AND status = 'pending' AND approval_token_hash = ${tokenHash}
        RETURNING id, version, config, rationale, evidence, diagnosis, tests_passed, test_report, status, approval_token_hash, created_at`;
      const raw = rows[0] as Record<string, unknown> | undefined;
      return raw ? normalizeProposalRow(raw) : null;
    },

    async setProposalStatus(id: string, status: "rejected" | "discarded"): Promise<void> {
      await sql`UPDATE improvement_proposals SET status = ${status}, decided_at = now() WHERE id = ${id}`;
    },

    async latestPendingProposal(): Promise<ProposalRow | null> {
      const rows = await sql`
        SELECT id, version, config, rationale, evidence, diagnosis, tests_passed, test_report, status, approval_token_hash, created_at
        FROM improvement_proposals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`;
      const raw = rows[0] as Record<string, unknown> | undefined;
      return raw ? normalizeProposalRow(raw) : null;
    },

    async insertImprovementAudit(entry: {
      action: string;
      version?: string;
      proposalId?: string;
      actor: string;
      detail?: unknown;
    }): Promise<void> {
      await sql`
        INSERT INTO improvement_audit (action, version, proposal_id, actor, detail)
        VALUES (${entry.action}, ${entry.version ?? null}, ${entry.proposalId ?? null}, ${entry.actor}, ${JSON.stringify(entry.detail ?? {})}::jsonb)`;
    },

    async improvementAuditTrail(limit = 10): Promise<{ action: string; version: string | null; actor: string; created_at: Date }[]> {
      const rows = await sql`
        SELECT action, version, actor, created_at FROM improvement_audit
        ORDER BY created_at DESC LIMIT ${limit}`;
      return rows.map((row) => {
        const raw = row as Record<string, unknown>;
        return { action: String(raw["action"]), version: (raw["version"] as string | null) ?? null, actor: String(raw["actor"]), created_at: raw["created_at"] as Date };
      });
    },

    async configAuditTrail(limit = 10): Promise<{ action: string; version: string | null; actor: string; created_at: Date }[]> {
      return this.improvementAuditTrail(limit);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
