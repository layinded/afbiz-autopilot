/**
 * Brief Test G: persistence across a service/client restart. Business data is
 * written through one PostgreSQL client, that client is closed (a real
 * disconnect), a fresh client + store reconnects, and the previously recorded
 * data is still queryable through the same tools the WhatsApp channel uses.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { createStore, type Store } from "../db/store.js";
import { createBusinessTools } from "../tools/index.js";
import { cleanupTestDb, setupTestDb, TEST_DATABASE_URL, TEST_OWNER, truncateAll } from "./helpers/test-db.js";
import { executeTool, fakeOpOptions } from "./helpers/fakes.js";

beforeAll(setupTestDb);
afterAll(cleanupTestDb);

describe("Test G: persistence across client restart", () => {
  it("keeps previously recorded data available after reconnect", async () => {
    await truncateAll();

    const client1 = createDb(TEST_DATABASE_URL);
    const store1 = createStore(client1);
    await store1.upsertCustomer(TEST_OWNER, "Amina");
    const amina = await store1.findCustomer(TEST_OWNER, "Amina");
    expect(amina).not.toBeNull();
    await store1.insertDebt(TEST_OWNER, amina!.id, { description: "goods", amount: 12_000, currency: "NGN" });
    await store1.insertSale(TEST_OWNER, { description: "bags of rice", quantity: 3, amount: 45_000, currency: "NGN" });

    // A real client restart: close the connection, open a fresh one.
    await client1.end({ timeout: 5 });

    const client2 = createDb(TEST_DATABASE_URL);
    try {
      const store2: Store = createStore(client2);
      const reconnected = await store2.findCustomer(TEST_OWNER, "Amina");
      expect(reconnected).not.toBeNull();
      const balance = await store2.customerBalance(TEST_OWNER, reconnected!.id);
      expect(balance.outstanding).toBe(12_000);

      const tools = createBusinessTools(store2, {
        confirmAmountThreshold: 1_000_000,
        tzOffsetMinutes: 60,
      });
      const balanceReply = (await executeTool(tools.getCustomerBalance, 
        { customer_name: "Amina" },
        fakeOpOptions(),
      )) as Record<string, unknown>;
      expect(balanceReply["ok"]).toBe(true);
      expect(String(balanceReply["message"])).toContain("₦12,000");

      const summary = (await executeTool(tools.getBusinessSummary, { scope: "total" }, fakeOpOptions())) as Record<
        string,
        unknown
      >;
      expect(Number(summary["sales_total"])).toBe(45_000);
      expect(Number(summary["outstanding_debts_total"])).toBe(12_000);
    } finally {
      await client2.end({ timeout: 5 });
    }
  });
});
