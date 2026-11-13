import { beforeAll, describe, expect, it } from "vitest";
import { parseAmount } from "../tools/amounts.js";
import { setActiveParserOverride } from "../lib/parser-config.js";

describe("amount parser with baseline config pinned", () => {
  beforeAll(() => setActiveParserOverride({ shorthand: [] }));
  it("parses Naira-prefixed and grouped amounts", async () => {
    expect(await parseAmount("₦45,000")).toMatchObject({ ok: true, value: 45_000, currency: "NGN" });
    expect(await parseAmount("₦ 45,000")).toMatchObject({ ok: true, value: 45_000 });
    expect(await parseAmount("45,000")).toMatchObject({ ok: true, value: 45_000 });
    expect(await parseAmount("45000")).toMatchObject({ ok: true, value: 45_000 });
    expect(await parseAmount("₦12,000.50")).toMatchObject({ ok: true, value: 12_000.5 });
    expect(await parseAmount("8,000 ngn")).toMatchObject({ ok: true, value: 8_000 });
  });

  it("parses bare-N Naira prefixes (discovered live in the WhatsApp E2E tests)", async () => {
    expect((await parseAmount("N45,000")).ok).toBe(true);
    const result = await parseAmount("N5,000");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(5_000);
    expect((await parseAmount("Nova")).ok).toBe(false);
  });

  it("rejects the known 'k' shorthand (seeded limitation for the later improvement demo)", async () => {
    const result = await parseAmount("5k");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unparsable");
      expect(result.message).toContain("restate");
    }
  });

  it("rejects unsupported currency symbols", async () => {
    const result = await parseAmount("$50");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported_currency");
  });

  it("rejects non-positive, malformed, and oversized amounts", async () => {
    expect((await parseAmount("0")).ok).toBe(false);
    expect((await parseAmount("-12")).ok).toBe(false);
    expect((await parseAmount("abc")).ok).toBe(false);
    expect((await parseAmount("")).ok).toBe(false);
    expect((await parseAmount("2,000,000,000")).ok).toBe(false);
  });
});
