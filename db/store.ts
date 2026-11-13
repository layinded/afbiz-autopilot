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
  };
}

export type Store = ReturnType<typeof createStore>;
