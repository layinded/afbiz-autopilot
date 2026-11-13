/**
 * The five MVP business tools (Phase 1 plan; brief tasks 1, 7, 8):
 * record_sale, record_expense, record_debt, get_business_summary, get_customer_balance.
 *
 * Laws:
 * - The LLM passes the RAW amount text it saw (amount_raw); our parser decides
 *   the meaning. The model never computes or converts amounts itself.
 * - Every write replies from backend-computed values only (no fabricated totals).
 * - Large amounts (>= CONFIRM_AMOUNT_THRESHOLD) and ambiguous new-customer debts
 *   become a pending action requiring the owner's explicit "confirm" / "cancel";
 *   at most one pending action per sender (a new one supersedes the old).
 * - Every execution logs a structured line carrying the turn's trace id.
 */
import { createTool } from "@voltagent/core";
import type { ToolExecuteOptions } from "@voltagent/core";
import { z } from "zod";
import type { Store } from "../db/store.js";
import { businessDayRange } from "../db/store.js";
import { fmtMoney } from "./money.js";
import { parseAmountOrMessage } from "./amounts.js";
import { logger } from "../lib/config.js";

export interface BusinessToolsOptions {
  confirmAmountThreshold: number;
  tzOffsetMinutes: number;
}

function traceOf(options?: ToolExecuteOptions): { userId: string | null; traceId: string | null } {
  const userId = options?.userId ?? null;
  const context = options?.context;
  const traceId = context instanceof Map ? ((context.get("traceId") as string | undefined) ?? null) : null;
  return { userId, traceId };
}

function todayOf(options: ToolExecuteOptions | undefined, tzOffsetMinutes: number): string {
  const context = options?.context;
  const fromContext = context instanceof Map ? context.get("today") : undefined;
  if (typeof fromContext === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fromContext)) return fromContext;
  return businessDayRange(new Date(), tzOffsetMinutes).date;
}

function sessionMissing(): Record<string, unknown> {
  return {
    ok: false,
    error: "session_missing",
    message: "No owner session is attached to this tool call; business tools are scoped per owner.",
  };
}

interface AmountCheck {
  ok: true;
  value: number;
  currency: string;
}

function checkAmount(raw: string): { parsed: AmountCheck } | { fail: Record<string, unknown> } {
  const result = parseAmountOrMessage(raw);
  if (result.ok) return { parsed: result };
  return { fail: { ok: false, error: "amount_unparsable", message: result.error.message } };
}

/** Apply a confirmed pending action. Shared by the confirm path and tests. */
export async function applyConfirmedPending(
  store: Store,
  pending: { tool: string; payload: Record<string, unknown>; owner_phone: string },
): Promise<{ ok: true; message: string; recordId?: string }> {
  const owner = pending.owner_phone;
  if (pending.tool === "record_sale") {
    const customerId = pending.payload["customer_name"]
      ? (await store.upsertCustomer(owner, String(pending.payload["customer_name"]))).id
      : null;
    const sale = await store.insertSale(owner, {
      description: String(pending.payload["description"]),
      quantity: Number(pending.payload["quantity"]),
      amount: Number(pending.payload["amount"]),
      currency: String(pending.payload["currency"]),
      customerId,
    });
    return {
      ok: true,
      recordId: sale.id,
      message: `Sale recorded: ${sale.quantity} × ${sale.description} — ${fmtMoney(sale.amount)}.`,
    };
  }
  if (pending.tool === "record_expense") {
    const expense = await store.insertExpense(owner, {
      category: String(pending.payload["category"]),
      description: pending.payload["description"] ? String(pending.payload["description"]) : null,
      amount: Number(pending.payload["amount"]),
      currency: String(pending.payload["currency"]),
    });
    return {
      ok: true,
      recordId: expense.id,
      message: `Expense recorded: ${expense.category} — ${fmtMoney(expense.amount)}.`,
    };
  }
  if (pending.tool === "record_debt") {
    const customer = await store.upsertCustomer(owner, String(pending.payload["customer_name"]));
    const debt = await store.insertDebt(owner, customer.id, {
      description: String(pending.payload["description"]),
      amount: Number(pending.payload["amount"]),
      currency: String(pending.payload["currency"]),
    });
    const balance = await store.customerBalance(owner, customer.id);
    return {
      ok: true,
      recordId: debt.id,
      message: `Debt recorded: ${customer.name} owes ${fmtMoney(debt.amount_due)} (balance ${fmtMoney(balance.outstanding)}).`,
    };
  }
  throw new Error(`unknown pending tool: ${pending.tool}`);
}

export function createBusinessTools(store: Store, options: BusinessToolsOptions) {
  const { confirmAmountThreshold, tzOffsetMinutes } = options;

  const confirmMessage =
    "Reply 'confirm' to approve or 'cancel' to discard." as const;

  const recordSale = createTool({
    name: "record_sale",
    description:
      "Record a sale the owner made. Pass the raw amount text exactly as the owner wrote it in amount_raw (do not convert it yourself). If the owner does not mention a customer, it is a walk-in cash sale: record it immediately with customer_name omitted - NEVER ask for a customer name on such sales.",
    parameters: z.object({
      description: z.string().min(1).describe("What was sold, e.g. 'bags of rice'"),
      quantity: z.number().int().min(1).default(1),
      amount_raw: z.string().min(1).describe('Raw amount text as written, e.g. "₦45,000"'),
      customer_name: z.string().min(1).optional(),
    }),
    execute: async (args, opOptions) => {
      const started = Date.now();
      const { userId, traceId } = traceOf(opOptions);
      if (!userId) return sessionMissing();
      const parsed = checkAmount(args.amount_raw);
      if (!("parsed" in parsed)) {
        logger.warn("parse_failed", { traceId, tool: "record_sale", raw: args.amount_raw });
        return { ...parsed.fail, meta: { durationMs: Date.now() - started } };
      }
      const { value, currency } = parsed.parsed;
      if (value >= confirmAmountThreshold) {
        const pending = await store.createPending(
          userId,
          "record_sale",
          { description: args.description, quantity: args.quantity, amount: value, currency, customer_name: args.customer_name ?? null },
          `record_sale ${args.quantity} × ${args.description} — ${fmtMoney(value)}`,
        );
        logger.info("confirmation_required", { traceId, tool: "record_sale", pendingId: pending.id, amount: value });
        return { ok: false, confirmation_required: true, pending_id: pending.id, message: `Large sale: ${args.quantity} × ${args.description} — ${fmtMoney(value)}. ${confirmMessage}` };
      }
      const customerId = args.customer_name ? (await store.upsertCustomer(userId, args.customer_name)).id : null;
      const sale = await store.insertSale(userId, {
        description: args.description,
        quantity: args.quantity,
        amount: value,
        currency,
        customerId,
      });
      logger.info("tool_executed", { traceId, tool: "record_sale", durationMs: Date.now() - started, recordId: sale.id, amount: value });
      return {
        ok: true,
        sale_id: sale.id,
        summary: `${sale.quantity} × ${sale.description} — ${fmtMoney(sale.amount)}`,
        message: `Sale recorded: ${sale.quantity} × ${sale.description} — ${fmtMoney(sale.amount)}.`,
      };
    },
  });

  const recordExpense = createTool({
    name: "record_expense",
    description:
      "Record a business expense with its category. Pass the raw amount text exactly as the owner wrote it in amount_raw.",
    parameters: z.object({
      description: z.string().min(1).describe("What the money was spent on"),
      category: z.string().min(1).describe("Short category, e.g. transportation, restocking, rent"),
      amount_raw: z.string().min(1),
    }),
    execute: async (args, opOptions) => {
      const started = Date.now();
      const { userId, traceId } = traceOf(opOptions);
      if (!userId) return sessionMissing();
      const parsed = checkAmount(args.amount_raw);
      if (!("parsed" in parsed)) {
        logger.warn("parse_failed", { traceId, tool: "record_expense", raw: args.amount_raw });
        return { ...parsed.fail, meta: { durationMs: Date.now() - started } };
      }
      const { value, currency } = parsed.parsed;
      if (value >= confirmAmountThreshold) {
        const pending = await store.createPending(
          userId,
          "record_expense",
          { category: args.category, description: args.description, amount: value, currency },
          `record_expense ${args.category} — ${fmtMoney(value)}`,
        );
        logger.info("confirmation_required", { traceId, tool: "record_expense", pendingId: pending.id, amount: value });
        return { ok: false, confirmation_required: true, pending_id: pending.id, message: `Large expense: ${args.category} — ${fmtMoney(value)}. ${confirmMessage}` };
      }
      const expense = await store.insertExpense(userId, {
        category: args.category,
        description: args.description,
        amount: value,
        currency,
      });
      logger.info("tool_executed", { traceId, tool: "record_expense", durationMs: Date.now() - started, recordId: expense.id, amount: value, category: args.category });
      return {
        ok: true,
        expense_id: expense.id,
        category: expense.category,
        summary: `${expense.category} — ${fmtMoney(expense.amount)}`,
        message: `Expense recorded: ${expense.category} — ${fmtMoney(expense.amount)}.`,
      };
    },
  });

  const recordDebt = createTool({
    name: "record_debt",
    description:
      "Record goods a customer took on credit (money they now owe). Creates the customer if they are not yet in the records. Pass the raw amount text in amount_raw.",
    parameters: z.object({
      customer_name: z.string().min(1),
      description: z.string().min(1).describe("What they took on credit, e.g. 'goods'"),
      amount_raw: z.string().min(1),
    }),
    execute: async (args, opOptions) => {
      const started = Date.now();
      const { userId, traceId } = traceOf(opOptions);
      if (!userId) return sessionMissing();
      const parsed = checkAmount(args.amount_raw);
      if (!("parsed" in parsed)) {
        logger.warn("parse_failed", { traceId, tool: "record_debt", raw: args.amount_raw });
        return { ...parsed.fail, meta: { durationMs: Date.now() - started } };
      }
      const { value, currency } = parsed.parsed;
      if (value >= confirmAmountThreshold) {
        const pending = await store.createPending(userId, "record_debt", { customer_name: args.customer_name, description: args.description, amount: value, currency }, `record_debt ${args.customer_name} — ${fmtMoney(value)}`);
        logger.info("confirmation_required", { traceId, tool: "record_debt", pendingId: pending.id, amount: value });
        return { ok: false, confirmation_required: true, pending_id: pending.id, message: `Large debt for ${args.customer_name}: ${fmtMoney(value)}. ${confirmMessage}` };
      }

      const exact = await store.findCustomer(userId, args.customer_name);
      if (exact) {
        const debt = await store.insertDebt(userId, exact.id, { description: args.description, amount: value, currency });
        const balance = await store.customerBalance(userId, exact.id);
        logger.info("tool_executed", { traceId, tool: "record_debt", durationMs: Date.now() - started, recordId: debt.id, amount: value });
        return {
          ok: true,
          debt_id: debt.id,
          customer: exact.name,
          balance: balance.outstanding,
          summary: `${exact.name} owes ${fmtMoney(balance.outstanding)}`,
          message: `Debt recorded: ${exact.name} owes ${fmtMoney(debt.amount_due)} (balance ${fmtMoney(balance.outstanding)}).`,
        };
      }

      const similar = await store.listSimilarCustomers(userId, args.customer_name);
      if (similar.length > 0) {
        const first = similar[0]!;
        const pending = await store.createPending(userId, "record_debt", { customer_name: args.customer_name, description: args.description, amount: value, currency }, `record_debt NEW customer ${args.customer_name} — ${fmtMoney(value)}`);
        logger.info("confirmation_required", { traceId, tool: "record_debt", pendingId: pending.id, reason: "similar_customer_exists", similar: first.name });
        return {
          ok: false,
          confirmation_required: true,
          pending_id: pending.id,
          message: `I found "${first.name}" in your records but no "${args.customer_name}". Record a NEW customer "${args.customer_name}" with a ${fmtMoney(value)} debt? ${confirmMessage}`,
        };
      }

      const customer = await store.upsertCustomer(userId, args.customer_name);
      const debt = await store.insertDebt(userId, customer.id, { description: args.description, amount: value, currency });
      const balance = await store.customerBalance(userId, customer.id);
      logger.info("tool_executed", { traceId, tool: "record_debt", durationMs: Date.now() - started, recordId: debt.id, amount: value, customerAutoCreated: customer.name });
      return {
        ok: true,
        debt_id: debt.id,
        customer: customer.name,
        customer_auto_created: true,
        balance: balance.outstanding,
        summary: `${customer.name} owes ${fmtMoney(balance.outstanding)}`,
        message: `New customer ${customer.name} recorded with a ${fmtMoney(value)} debt (balance ${fmtMoney(balance.outstanding)}).`,
      };
    },
  });

  const getBusinessSummary = createTool({
    name: "get_business_summary",
    description:
      "Summarize the owner's business numbers (sales, expenses, outstanding debts) for today or all time. All values are computed by the backend - never invent or adjust them.",
    parameters: z.object({
      scope: z.enum(["today", "total"]).default("today"),
    }),
    execute: async (args, opOptions) => {
      const started = Date.now();
      const { userId, traceId } = traceOf(opOptions);
      if (!userId) return sessionMissing();
      let sales: { total: number; count: number };
      let expenses: { total: number; count: number };
      const label = args.scope === "today" ? "Today" : "All time";
      if (args.scope === "today") {
        const range = businessDayRange(new Date(), tzOffsetMinutes);
        sales = await store.salesSummary(userId, range.from, range.to);
        expenses = await store.expensesSummary(userId, range.from, range.to);
      } else {
        const all = await store.allTimeSummary(userId);
        sales = { total: all.salesTotal, count: all.salesCount };
        expenses = { total: all.expensesTotal, count: all.expensesCount };
      }
      const debts = await store.outstandingDebtSummary(userId);
      logger.info("tool_executed", { traceId, tool: "get_business_summary", durationMs: Date.now() - started, scope: args.scope, salesTotal: sales.total, expensesTotal: expenses.total, outstanding: debts.outstanding });
      return {
        ok: true,
        scope: args.scope,
        sales_total: sales.total,
        sales_count: sales.count,
        expenses_total: expenses.total,
        expenses_count: expenses.count,
        outstanding_debts_total: debts.outstanding,
        open_debts: debts.openDebts,
        message: `${label}: sales ${fmtMoney(sales.total)} from ${sales.count} sale(s); expenses ${fmtMoney(expenses.total)} from ${expenses.count}; customers owe ${fmtMoney(debts.outstanding)} across ${debts.openDebts} debt(s).`,
      };
    },
  });

  const getCustomerBalance = createTool({
    name: "get_customer_balance",
    description: "How much a customer currently owes. Returns backend-computed values only.",
    parameters: z.object({
      customer_name: z.string().min(1),
    }),
    execute: async (args, opOptions) => {
      const started = Date.now();
      const { userId, traceId } = traceOf(opOptions);
      if (!userId) return sessionMissing();
      const exact = await store.findCustomer(userId, args.customer_name);
      if (exact) {
        const balance = await store.customerBalance(userId, exact.id);
        logger.info("tool_executed", { traceId, tool: "get_customer_balance", durationMs: Date.now() - started, customer: exact.name, outstanding: balance.outstanding });
        return {
          ok: true,
          customer: exact.name,
          outstanding: balance.outstanding,
          open_debts: balance.openDebts,
          message:
            balance.outstanding > 0
              ? `${exact.name} owes ${fmtMoney(balance.outstanding)}.`
              : `${exact.name} owes nothing right now - all debts settled.`,
        };
      }
      const similar = await store.listSimilarCustomers(userId, args.customer_name);
      if (similar.length > 0) {
        const lines = await Promise.all(
          similar.map(async (customer) => {
            const balance = await store.customerBalance(userId, customer.id);
            return `${customer.name} (owes ${fmtMoney(balance.outstanding)})`;
          }),
        );
        logger.info("tool_executed", { traceId, tool: "get_customer_balance", durationMs: Date.now() - started, suggested: similar.length });
        return {
          ok: false,
          error: "customer_not_found",
          suggestions: similar.map((c) => c.name),
          message: `No customer named "${args.customer_name}" yet. Did you mean: ${lines.join(", ")}?`,
        };
      }
      logger.info("tool_executed", { traceId, tool: "get_customer_balance", durationMs: Date.now() - started, customer: args.customer_name, found: false });
      return { ok: false, error: "customer_not_found", message: `No customer named "${args.customer_name}" in your records yet.` };
    },
  });

  return { tools: [recordSale, recordExpense, recordDebt, getBusinessSummary, getCustomerBalance], recordSale, recordExpense, recordDebt, getBusinessSummary, getCustomerBalance };
}
