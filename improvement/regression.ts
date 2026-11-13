/**
 * The regression gate for improvement candidates (Phase 4 Step 4). Cases cover
 * the demonstration shorthand, the already-working forms, and the refusals.
 * Nothing here runs a shell: the candidate config is evaluated in-process via
 * parseAmountWithConfig. A candidate that fails ANY required case is rejected.
 */
import { parseAmountWithConfig } from "../tools/amounts.js";
import { isValidParserConfig, type AmountParserConfig } from "../lib/parser-config.js";

interface RegressionCase {
  name: string;
  input: string;
  expected: { ok: true; value: number } | { ok: false; mustFail: true };
}

export const REQUIRED_REGRESSION_CASES: RegressionCase[] = [
  { name: "shorthand k", input: "5k", expected: { ok: true, value: 5_000 } },
  { name: "fractional shorthand k", input: "2.5k", expected: { ok: true, value: 2_500 } },
  { name: "naira grouped", input: "₦5,000", expected: { ok: true, value: 5_000 } },
  { name: "plain integer", input: "5000", expected: { ok: true, value: 5_000 } },
  { name: "decimal", input: "₦12,000.50", expected: { ok: true, value: 12_000.5 } },
  { name: "existing successful form", input: "₦45,000", expected: { ok: true, value: 45_000 } },
  { name: "ambiguous text is still refused", input: "some rice", expected: { ok: false, mustFail: true } },
  { name: "negative refused", input: "-12", expected: { ok: false, mustFail: true } },
  { name: "zero refused", input: "0", expected: { ok: false, mustFail: true } },
  { name: "excessive refused", input: "2,000,000,000", expected: { ok: false, mustFail: true } },
  { name: "foreign currency refused", input: "$50", expected: { ok: false, mustFail: true } },
];

export interface TestCaseResult {
  name: string;
  input: string;
  pass: boolean;
  actual: { ok: true; value: number } | { ok: false; reason: string } | null;
  expected: string;
}

export interface RegressionReport {
  validConfig: boolean;
  passed: boolean;
  results: TestCaseResult[];
}

export function runRegression(candidiateConfig: unknown): RegressionReport {
  if (!isValidParserConfig(candidiateConfig)) {
    return { validConfig: false, passed: false, results: [] };
  }
  const config = candidiateConfig as AmountParserConfig;
  const results: TestCaseResult[] = REQUIRED_REGRESSION_CASES.map((testCase) => {
    const outcome = parseAmountWithConfig(testCase.input, config);
    if (outcome.ok) {
      const pass =
        testCase.expected.ok && Math.abs(outcome.value - testCase.expected.value) < 0.001;
      return {
        name: testCase.name,
        input: testCase.input,
        pass,
        actual: { ok: true, value: outcome.value } as const,
        expected: testCase.expected.ok ? `${testCase.expected.value}` : "refusal",
      };
    }
    const pass = !testCase.expected.ok;
    return {
      name: testCase.name,
      input: testCase.input,
      pass,
      actual: { ok: false, reason: outcome.reason } as const,
      expected: testCase.expected.ok ? `${testCase.expected.value}` : "refusal",
    };
  });
  return { validConfig: true, passed: results.every((testCase) => testCase.pass), results };
}

/** The improvement agent must output shorthand rules within these bounds. */
export function isAllowlistedPatch(patch: unknown): boolean {
  if (!patch || typeof patch !== "object") return false;
  const rules = (patch as { shorthand?: unknown }).shorthand;
  return isValidParserConfig({ shorthand: rules });
}
