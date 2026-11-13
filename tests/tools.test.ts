/**
 * Tool-level tests on the isolated PostgreSQL: validation, currency handling,
 * confirmation flow for ambiguous/large operations, and backend-computed reads.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "../db/store.js";
import { createBusinessTools, applyConfirmedPending } from "../tools/index.js";
import { cleanupTestDb, getSql, setupTestDb, TEST_OWNER, truncateAll } from "./helpers/test-db.js";
import { executeTool, fakeOpOptions } from "./helpers/fakes.js";

let store: Store;
let tools: ReturnType<typeof createBusinessTools>;

beforeAll(async () => {
  await setupTestDb();
  store = createStore(getSql());
  tools = createBusinessTools(store, { confirmAmountThreshold: 1_000_000, tzOffsetMinutes: 60 });
});
afterAll(cleanupTestDb);
beforeEach(truncateAll);

describe("record_sale", () => {
  it("records amount and quantity exactly as parsed", async () => {
    const result = (await executeTool(tools.recordSale, 
      { description: "bags of rice", quantity: 3, amount_raw: "₦45,000" },
      fakeOpOptions(),
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(String(result["message"])).toContain("3 × bags of rice");
    expect(String(result["message"])).toContain("₦45,000");
    const sales = await getSql()`SELECT quantity, amount, currency, owner_phone FROM sales`;
    expect(sales).toHaveLength(1);
    expect(Number((sales[0] as Record<string, unknown>)["quantity"])).toBe(3);
    expect(Number((sales[0] as Record<string, unknown>)["amount"])).toBe(45_000);
    expect((sales[0] as Record<string, unknown>)["currency"]).toBe("NGN");
  });

  it("rejects an unparsable amount without writing anything", async () => {
    const result = (await executeTool(tools.recordSale, 
      { description: "bags of rice", quantity: 3, amount_raw: "5k" },
      fakeOpOptions(),
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("amount_unparsable");
    expect(String(result["message"])).toContain("₦5,000");
    const sales = await getSql()`SELECT id FROM sales`;
    expect(sales).toHaveLength(0);
  });

  it("rejects foreign currency without writing anything", async () => {
    const result = (await executeTool(tools.recordSale, 
      { description: "soap", quantity: 1, amount_raw: "$50" },
      fakeOpOptions(),
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(String(result["message"])).toContain("₦ (NGN)");
  });

  it("requires confirmation for large amounts, applies it on confirm, and drops on cancel", async () => {
    const result = (await executeTool(tools.recordSale, 
      { description: "generator", quantity: 1, amount_raw: "₦2,500,000" },
      fakeOpOptions(),
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["confirmation_required"]).toBe(true);
    expect(await getSql()`SELECT id FROM sales`).toHaveLength(0);

    const pending = await store.consumePending(TEST_OWNER, "confirm");
    expect(pending).not.toBeNull();
    const applied = await applyConfirmedPending(store, pending!);
    expect(applied.message).toContain("₦2,500,000");
    const sales = await getSql()`SELECT amount FROM sales`;
    expect(sales).toHaveLength(1);
    expect(Number((sales[0] as Record<string, unknown>)["amount"])).toBe(2_500_000);

    // A fresh pending action cancelled leaves nothing behind.
    await executeTool(tools.recordSale, { description: "freezer", quantity: 1, amount_raw: "₦1,200,000" }, fakeOpOptions());
    const cancelled = await store.consumePending(TEST_OWNER, "cancel");
    expect(cancelled?.status).toBe("cancelled");
    expect(await getSql()`SELECT id FROM sales`).toHaveLength(1);
  });
});

describe("record_expense", () => {
  it("records amount and category", async () => {
    const result = (await executeTool(tools.recordExpense, 
      { description: "bus fare", category: "transportation", amount_raw: "₦8,000" },
      fakeOpOptions(),
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["category"]).toBe("transportation");
    expect(String(result["message"])).toContain("₦8,000");
    const expenses = await getSql()`SELECT category, amount FROM expenses`;
    expect(expenses).toHaveLength(1);
    expect((expenses[0] as Record<string, unknown>)["category"]).toBe("transportation");
    expect(Number((expenses[0] as Record<string, unknown>)["amount"])).toBe(8_000);
  });
});

describe("record_debt", () => {
  it("auto-creates a new customer with no similar name and records the debt", async () => {
    const result = (await executeTool(tools.recordDebt, 
      { customer_name: "Amina", description: "goods", amount_raw: "₦12,000" },
      fakeOpOptions(),
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["customer_auto_created"]).toBe(true);
    const customer = await store.findCustomer(TEST_OWNER, "Amina");
    expect(customer).not.toBeNull();
    const balance = await store.customerBalance(TEST_OWNER, customer!.id);
    expect(balance.outstanding).toBe(12_000);
  });

  it("asks for confirmation when a similar customer exists", async () => {
    await store.upsertCustomer(TEST_OWNER, "Aminat");
    const result = (await executeTool(tools.recordDebt, 
      { customer_name: "Amina", description: "goods", amount_raw: "₦12,000" },
      fakeOpOptions(),
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["confirmation_required"]).toBe(true);
    expect(String(result["message"])).toContain("Aminat");
    expect(String(result["message"])).toContain("NEW customer");
    const debts = await getSql()`SELECT id FROM debts`;
    expect(debts).toHaveLength(0);

    const pending = await store.consumePending(TEST_OWNER, "confirm");
    expect(pending).not.toBeNull();
    const applied = await applyConfirmedPending(store, pending!);
    expect(applied.message).toContain("₦12,000");
    const amina = await store.findCustomer(TEST_OWNER, "Amina");
    expect(amina).not.toBeNull();
    const balance = await store.customerBalance(TEST_OWNER, amina!.id);
    expect(balance.outstanding).toBe(12_000);
  });

  it("adds to the balance of an existing customer", async () => {
    await store.upsertCustomer(TEST_OWNER, "Amina");
    await executeTool(tools.recordDebt, { customer_name: "Amina", description: "goods", amount_raw: "₦12,000" }, fakeOpOptions());
    await executeTool(tools.recordDebt, { customer_name: "Amina", description: "rice", amount_raw: "₦13,000" }, fakeOpOptions());
    const amina = await store.findCustomer(TEST_OWNER, "Amina");
    const balance = await store.customerBalance(TEST_OWNER, amina!.id);
    expect(balance.outstanding).toBe(25_000);
  });
});

describe("get_business_summary", () => {
  it("reports zeros for an empty business day", async () => {
    const result = (await executeTool(tools.getBusinessSummary, { scope: "today" }, fakeOpOptions())) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(Number(result["sales_total"])).toBe(0);
    expect(String(result["message"])).toContain("Today");
  });

  it("sums today's sales and expenses from PostgreSQL", async () => {
    await executeTool(tools.recordSale, { description: "bags of rice", quantity: 3, amount_raw: "₦45,000" }, fakeOpOptions());
    await executeTool(tools.recordExpense, { description: "bus fare", category: "transportation", amount_raw: "₦8,000" }, fakeOpOptions());
    const result = (await executeTool(tools.getBusinessSummary, { scope: "today" }, fakeOpOptions())) as Record<string, unknown>;
    expect(Number(result["sales_total"])).toBe(45_000);
    expect(Number(result["expenses_total"])).toBe(8_000);
    expect(Number(result["outstanding_debts_total"])).toBe(0);
    expect(String(result["message"])).toContain("₦45,000");
  });
});

describe("get_customer_balance", () => {
  it("returns the recomputed outstanding balance", async () => {
    await store.upsertCustomer(TEST_OWNER, "Amina");
    await executeTool(tools.recordDebt, { customer_name: "Amina", description: "goods", amount_raw: "₦12,000" }, fakeOpOptions());
    const result = (await executeTool(tools.getCustomerBalance, { customer_name: "Amina" }, fakeOpOptions())) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(String(result["message"])).toContain("₦12,000");
  });

  it("suggests similar customers and never invents a balance", async () => {
    await store.upsertCustomer(TEST_OWNER, "Aminat");
    await executeTool(tools.recordDebt, { customer_name: "Aminat", description: "goods", amount_raw: "₦7,000" }, fakeOpOptions());
    const result = (await executeTool(tools.getCustomerBalance, { customer_name: "Amina" }, fakeOpOptions())) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("customer_not_found");
    expect(result["suggestions"]).toEqual(["Aminat"]);
    expect(String(result["message"])).toContain("₦7,000");
  });

  it("says so when the customer does not exist at all", async () => {
    const result = (await executeTool(tools.getCustomerBalance, { customer_name: "Zainab" }, fakeOpOptions())) as Record<string, unknown>;
    expect(String(result["message"])).toContain("No customer named");
  });
});

describe("validation", () => {
  it("the quantity CHECK constraint rejects invalid quantities at the database", async () => {
    await expect(
      store.insertSale(TEST_OWNER, { description: "x", quantity: 0, amount: 1_000, currency: "NGN" }),
    ).rejects.toThrow();
  });
});
