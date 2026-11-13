/**
 * The improvement agent (Phase 4 Step 2+3): a dedicated VoltAgent agent that
 * inspects failure evidence and produces a structured, RESTRICTED proposal as
 * JSON. It has no tools and no shell/code execution surface; the only shape it
 * can emit is the allowlisted amount-normalization patch, validated downstream.
 */
import { Agent } from "@voltagent/core";
import type { Agent as AgentType, Memory } from "@voltagent/core";
import type { LanguageModel } from "ai";
import { readFileSync } from "node:fs";

export interface ImprovementEvidence {
  traceId: string;
  failureCategory: string;
  agentVersion: string;
  observedAt: string;
  rawInput: string;
  expectedBehavior: string;
  actualBehavior: string;
  recentExamples: { rawInput: string; category: string; observedAt: string }[];
}

export interface ImprovementProposal {
  changeType: "amount_normalization";
  patch: { shorthand: { suffix: string; factor: number }[] };
  diagnosis: string;
  rationale: string;
  risks: string;
}

export function improvementInstructions(): string {
  return readFileSync(new URL("./prompt.md", import.meta.url), "utf8").trim();
}

export function createImprovementAgent(options: { model: LanguageModel; memory?: Memory }): AgentType {
  return new Agent({
    name: "afbiz-improver",
    purpose:
      "Diagnose recorded agent failures and propose a restricted amount-parser configuration improvement (versioned, test-gated, human-approved).",
    instructions: improvementInstructions(),
    model: options.model,
    tools: [],
    memory: options.memory ?? false,
    temperature: 0.2,
  });
}

/** The improver replies with a JSON object; extract and shape-validate it. */
export function parseProposalText(text: string): ImprovementProposal | { invalid: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { invalid: "no JSON object found in the reply" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return { invalid: `unparseable JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const candidate = parsed as { changeType?: unknown; patch?: unknown; diagnosis?: unknown; rationale?: unknown; risks?: unknown };
  if (candidate["changeType"] !== "amount_normalization") {
    return { invalid: `changeType "${String(candidate["changeType"])}" is not allowlisted (only amount_normalization)` };
  }
  const patch = candidate["patch"] as { shorthand?: unknown } | undefined;
  if (!patch || !Array.isArray(patch["shorthand"])) {
    return { invalid: "patch.shorthand array missing" };
  }
  for (const rule of patch["shorthand"] as unknown[]) {
    const shaped = rule as { suffix?: unknown; factor?: unknown };
    if (shaped["suffix"] !== "k" && shaped["suffix"] !== "m") {
      return { invalid: `shorthand suffix "${String(shaped["suffix"])}" not allowlisted (k or m only)` };
    }
    if (typeof shaped["factor"] !== "number" || [1000, 1_000_000].includes(shaped["factor"]) === false) {
      return { invalid: `shorthand factor must be exactly 1000 (k) or 1000000 (m), got ${String(shaped["factor"])}` };
    }
  }
  if (typeof candidate["diagnosis"] !== "string" || candidate["diagnosis"].length < 10) {
    return { invalid: "diagnosis must be a meaningful string" };
  }
  if (typeof candidate["rationale"] !== "string" || candidate["rationale"].length < 10) {
    return { invalid: "rationale must be a meaningful string" };
  }
  return {
    changeType: "amount_normalization",
    patch: { shorthand: patch["shorthand"] as { suffix: string; factor: number }[] },
    diagnosis: candidate["diagnosis"],
    rationale: candidate["rationale"],
    risks: typeof candidate["risks"] === "string" ? candidate["risks"] : "none stated",
  };
}

export function evidencePrompt(evidence: ImprovementEvidence): string {
  const recent = evidence.recentExamples
    .map((example) => `  - ${example.observedAt} raw="${example.rawInput}" [${example.category}]`)
    .join("\n");
  return [
    "Failure evidence to diagnose:",
    `- trace: ${evidence.traceId}`,
    `- failure category: ${evidence.failureCategory}`,
    `- agent version: ${evidence.agentVersion}`,
    `- observed at: ${evidence.observedAt}`,
    `- raw amount text the owner wrote: "${evidence.rawInput}"`,
    `- expected behavior: ${evidence.expectedBehavior}`,
    `- actual behavior: ${evidence.actualBehavior}`,
    "- recent related failures:",
    recent || "  (none)",
    "",
    "Diagnose the root cause and propose the smallest allowlisted change. Reply with ONLY the JSON object.",
  ].join("\n");
}
