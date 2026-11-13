/**
 * Phase 4 Step 1-4 CLI: observe -> diagnose (VoltAgent improver) -> generate
 * -> regression test -> persist an approval-gated proposal. The one-time
 * approval token is printed ONCE here, for the machine's administrator.
 * Output is written synchronously so piped invocation still shows it before
 * the explicit exit (the posthog client keeps the loop alive otherwise).
 *   npm run improve
 */
import { writeSync } from "node:fs";
import { createDb } from "../db/client.js";
import { createStore } from "../db/store.js";
import { logger, resolveConfig } from "../lib/config.js";
import { createPostHogObservability } from "../integrations/posthog.js";
import { createEmitter } from "../lib/observability.js";
import { createImprovementAgent } from "../improvement/agent.js";
import { runImprovementLoop } from "../improvement/loop.js";

function print(line: string): void {
  writeSync(1, line + "\n");
}

async function main(): Promise<void> {
  const { config } = resolveConfig();
  const sql = createDb(config.databaseUrl);
  const store = createStore(sql);
  const observability = createPostHogObservability({
    publicKey: config.posthog?.publicKey,
    host: config.posthog?.host ?? "https://eu.i.posthog.com",
    onProblem: (detail) => logger.warn("posthog_problem", { detail }),
  });
  const emitter = createEmitter({ store, observability, agentVersion: config.agentVersion });

  if (!config.modelApiKey) {
    print("improve: MODEL_API_KEY is not resolved - the improver agent needs a model endpoint.");
    process.exit(1);
  }

  const { createChatModel } = await import("../agent/model.js");
  const { model } = createChatModel(config);
  const improver = createImprovementAgent({ model });

  const result = await runImprovementLoop({ store, emitter, improver, model, agentVersion: config.agentVersion });
  await observability.flush();

  print(`\nimprove: ${result.status}`);
  if (result.regression) {
    print(`regression: ${result.regression.passed ? "PASSED" : "FAILED"} (${result.regression.results.length} cases)`);
    for (const caseResult of result.regression.results) {
      const actual =
        caseResult.actual && caseResult.actual.ok
          ? String(caseResult.actual.value)
          : (caseResult.actual as { reason?: string } | null)?.reason ?? "no-candidate";
      print(`  ${caseResult.pass ? "PASS" : "FAIL"} ${caseResult.name}: "${caseResult.input}" -> ${caseResult.pass ? actual : actual}`);
    }
  }
  if (result.diagnosis) print(`diagnosis: ${result.diagnosis}`);
  if (result.status === "proposed") {
    print(`proposal: ${result.proposalId} version=${result.version}`);
    print(`APPROVAL TOKEN (one-time, administrator only): ${result.token}`);
    print("approve with: npm run approve -- --proposal <id> --token <token> --version " + result.version);
  } else {
    print(`improve outcome: ${result.detail}`);
  }
}

void main()
  .catch((error) => {
    logger.error("improve_failed", { error: error instanceof Error ? error.message : String(error) });
    print(`improve failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  })
  .finally(() => process.exit(0));
