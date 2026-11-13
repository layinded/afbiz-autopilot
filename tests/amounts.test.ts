import { describe, expect, it } from "vitest";
import { parseAmount } from "../tools/amounts.js";

describe("amount parser", () => {
  it("parses Naira-prefixed and grouped amounts", () => {
    expect(parseAmount("₦45,000")).toMatchObject({ ok: true, value: 45_000, currency: "NGN" });
    expect(parseAmount("₦ 45,000")).toMatchObject({ ok: true, value: 45_000 });
    expect(parseAmount("45,000")).toMatchObject({ ok: true, value: 45_000 });
    expect(parseAmount("45000")).toMatchObject({ ok: true, value: 45_000 });
    expect(parseAmount("₦12,000.50")).toMatchObject({ ok: true, value: 12_000.5 });
    expect(parseAmount("8,000 ngn")).toMatchObject({ ok: true, value: 8_000 });
  });

  it("rejects the known 'k' shorthand (seeded limitation for the later improvement demo)", () => {
    const result = parseAmount("5k");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unparsable");
      expect(result.message).toContain("restate");
    }
  });

  it("rejects unsupported currency symbols", () => {
    const result = parseAmount("$50");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported_currency");
  });

  it("rejects non-positive, malformed, and oversized amounts", () => {
    expect(parseAmount("0").ok).toBe(false);
    expect(parseAmount("-12").ok).toBe(false);
    expect(parseAmount("abc").ok).toBe(false);
    expect(parseAmount("").ok).toBe(false);
    expect(parseAmount("2,000,000,000").ok).toBe(false);
  });
});
