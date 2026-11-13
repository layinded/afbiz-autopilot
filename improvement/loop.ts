/**
 * The Phase 4 self-improvement loop: observe -> diagnose -> generate -> test
 * -> persist an approval-gated proposal. NOTHING activates here - activation
 * is a separate audited, token-gated command (scripts/approve.ts). The loop is
 * allowed to READ the event ledger and WRITE one proposal row; it never
 * touches financial records.
 */
import type { Agent } from "@voltagent/core";
import { createHash, randomBytes } from "node:crypto";
import type { Store } from "../db/store.js";
import { getActiveParserConfig, isValidParserConfig } from "../lib/parser-config.js";
import { isAllowlistedPatch, runRegression, type RegressionReport } from "./regression.js";
import {
  createImprovementAgent,
  evidencePrompt,
  parseProposalText,
  type ImprovementEvidence,
  type ImprovementProposal,
} from "./agent.js";
import type { Emitter } from "../lib/observability.js";
import { logger } from "../lib/config.js";

export type LoopStatus = "proposed" | "no_evidence" | "generation_rejected" | "tests_failed";

export interface LoopResult {
  status: LoopStatus;
  proposalId?: string;
  version?: string;
  token?: string;
  diagnosis?: string;
  regression?: RegressionReport;
  detail: string;
}

function nextVersion(versions: { version: string }[]): string {
  const max = versions.reduce((acc, v) => {
    const m = /^parser_v(\d+)$/.exec(v.version);
    return m ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return `parser_v${max + 1}`;
}

function buildCandidate(currentConf: unknown, patch: ImprovementProposal["patch"]): unknown {
  const base: { shorthand: { suffix: "k" | "m"; factor: number }[] } =
    isValidParserConfig(currentConf) ? { shorthand: [...currentConf.shorthand] } : { shorthand: [] };
  const merged = [...base.shorthand];
  for (const rule of patch.shorthand) {
    const typed = rule as { suffix: "k" | "m"; factor: number };
    const idx = merged.findIndex((existing) => existing.suffix === typed.suffix);
    if (idx >= 0 && merged[idx]) merged[idx] = typed;
    else merged.push(typed);
  }
  return { shorthand: merged };
}

export async function runImprovementLoop(deps: {
  store: Store;
  emitter: Emitter;
  improver?: Agent;
  model: import("ai").LanguageModel;
  agentVersion: string;
}): Promise<LoopResult> {
  const { store, emitter, model, agentVersion } = deps;
  const improver = deps.improver ?? createImprovementAgent({ model });

  const failures = await store.recentFailures(15);
  const parseFailure = failures.find((row) => row["failure_category"] === "amount_parsing" && (row["payload"] as { raw_input?: string })?.["raw_input"]);
  const clarificationFailure = failures.find(
    (row) => row["failure_category"] === "missing_information" && (row["payload"] as { raw_input?: string })?.["raw_input"],
  );
  const chosen = parseFailure ?? clarificationFailure;
  if (!chosen) {
    return {
      status: "no_evidence",
      detail:
        "No recent failure evidence with raw input exists in the event ledger. Run the failing interaction first, then re-run the improvement loop.",
    };
  }

  const payload = (chosen["payload"] ?? {}) as { raw_input?: string; reply_preview?: string };
  const evidence: ImprovementEvidence = {
    traceId: chosen.trace_id,
    failureCategory: String(chosen.failure_category),
    agentVersion: chosen.agent_version,
    observedAt: chosen.created_at.toISOString(),
    rawInput: payload["raw_input"] ?? "",
    expectedBehavior:
      "The assistant resolves the owner's amount text and proceeds through the matching business flow, asking for information only when genuinely missing.",
    actualBehavior: `The turn ended as a clarification/refusal instead of a parsed amount (reply: ${payload["reply_preview"] ?? "see trace"}).`,
    recentExamples: failures
      .filter((row) => (row["payload"] as { raw_input?: unknown })?.["raw_input"])
      .slice(0, 5)
      .map((row) => {
        const raw = (row["payload"] as { raw_input?: string })["raw_input"] ?? "";
        return { rawInput: raw, category: String(row["failure_category"] ?? ""), observedAt: row.created_at.toISOString() };
      }),
  };

  const generationTimeoutMs = 150_000;
  const generationCall = improver
    .generateText(evidencePrompt(evidence), { maxOutputTokens: 700, temperature: 0.2 })
    .then((result) => result.text ?? "");
  const generationGuard = new Promise<{ error: string }>((resolve) => {
    setTimeout(() => resolve({ error: `model call exceeded ${generationTimeoutMs / 1000}s` }), generationTimeoutMs);
  });
  // VoltAgent 2.11 model calls can fail without ever settling (the streamText
  // hang documented in agent/turn.ts): race a watchdog and attach the catch so
  // neither path can wedge the CLI or leak an unhandled rejection.
  const generationSettled = await Promise.race([
    generationCall.catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
    generationGuard,
  ]);
  const generationText = typeof generationSettled === "string" ? generationSettled : null;
  const generationError = typeof generationSettled === "string" ? null : generationSettled.error;
  void generationCall.catch(() => undefined);

  const generation = generationText === null
    ? ({ invalid: generationError ?? "model call did not settle" } as const)
    : parseProposalText(generationText);

  if ("invalid" in generation) {
    logger.warn("improvement_generation_rejected", { reason: generation.invalid });
    await store.insertImprovementAudit({
      action: "generation_rejected",
      actor: "improvement-agent",
      detail: { reason: generation.invalid, traceId: evidence.traceId },
    });
    return { status: "generation_rejected", detail: `The improvement agent's output was not allowlisted: ${generation.invalid}` };
  }

  const currentConf = await store.getActiveParserConfig("amount_parser");
  const candidate = buildCandidate(currentConf, (generation as ImprovementProposal).patch);
  if (!isAllowlistedPatch(candidate)) {
    await store.insertImprovementAudit({
      action: "patch_rejected",
      actor: "improvement-agent",
      detail: { reason: "candidate config outside allowlist", traceId: evidence.traceId },
    });
    return { status: "generation_rejected", detail: "The generated patch fell outside the allowlist." };
  }

  const report = runRegression(candidate);
  const versions = await store.listParserVersions();
  const version = nextVersion(versions);

  const token = randomBytes(12).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");

  const proposalText = generation as ImprovementProposal;
  if (!report.passed) {
    const proposalId = await store.saveProposal({
      version,
      config: candidate,
      rationale: proposalText.rationale,
      evidence: evidence as unknown,
      diagnosis: proposalText.diagnosis,
      testsPassed: false,
      testReport: report,
      approvalTokenHash: tokenHash,
    });
    await store.setProposalStatus(proposalId, "rejected");
    await emitter.emit("improvement_tested", {
      traceId: evidence.traceId,
      status: "failure",
      improvementVersion: version,
      outcome: "regression_failed",
      failureCategory: "tool_execution",
      ledgerExtra: { failedCases: report.results.filter((c) => !c.pass).map((c) => c.name) },
    });
    await store.insertImprovementAudit({
      action: "candidate_rejected_by_tests",
      version,
      proposalId,
      actor: "regression-gate",
      detail: { failedCases: report.results.filter((c) => !c.pass).map((c) => c.name) },
    });
    return { status: "tests_failed", proposalId, version, regression: report, detail: "The candidate failed required regression cases and was discarded." };
  }

  const proposalId = await store.saveProposal({
    version,
    config: candidate,
    rationale: proposalText.rationale,
    evidence: evidence as unknown,
    diagnosis: proposalText.diagnosis,
    testsPassed: true,
    testReport: report,
    approvalTokenHash: tokenHash,
  });
  await emitter.emit("improvement_proposed", {
    traceId: evidence.traceId,
    status: "info",
    improvementVersion: version,
    outcome: "proposal_pending_approval",
    ledgerExtra: { proposalId, rationale: proposalText.rationale },
  });
  await emitter.emit("improvement_tested", {
    traceId: evidence.traceId,
    status: "success",
    improvementVersion: version,
    outcome: "regression_passed",
    ledgerExtra: { casesPassed: report.results.length },
  });
  await store.insertImprovementAudit({
    action: "proposed",
    version,
    proposalId,
    actor: "improvement-agent",
    detail: { traceId: evidence.traceId },
  });

  return {
    status: "proposed",
    proposalId,
    version,
    token,
    diagnosis: proposalText.diagnosis,
    regression: report,
    detail: "Proposal persisted and pending admin approval (npm run approve).",
  };
}
