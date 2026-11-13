/**
 * Phase 4 Step 5+6 (approver side): validates the one-time token, marks the
 * proposal approved, stores the configuration version, flips the active
 * pointer (running agent picks it up within one 5 s TTL read - no restart),
 * and emits improvement_activated. Administrator-only: whoever can run this
 * command on the machine.
 *   npm run approve -- --proposal <id> --token <one-time-token> --version <version>
 */
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { createDb } from "../db/client.js";
import { createStore } from "../db/store.js";
import { logger, resolveConfig } from "../lib/config.js";
import { createPostHogObservability } from "../integrations/posthog.js";
import { createEmitter } from "../lib/observability.js";

function print(line: string): void {
  writeSync(1, line + "\n");
}
function printErr(line: string): void {
  writeSync(2, line + "\n");
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const { config } = resolveConfig();
  const proposalId = arg("proposal");
  const token = arg("token");
  if (!proposalId || !token) {
    printErr("approve: --proposal <id> and --token <one-time-token> are required");
    process.exitCode = 1;
    return;
  }

  const sql = createDb(config.databaseUrl);
  const store = createStore(sql);
  const observability = createPostHogObservability({
    publicKey: config.posthog?.publicKey,
    host: config.posthog?.host ?? "https://us.i.posthog.com",
    onProblem: (detail) => logger.warn("posthog_problem", { detail }),
  });
  const emitter = createEmitter({ store, observability, agentVersion: config.agentVersion });

  try {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const approved = await store.approveProposal(proposalId, tokenHash);
    if (!approved) {
      printErr("approve: no pending proposal matched that id/token (wrong token, already decided, or unknown id). Nothing was activated.");
      process.exitCode = 1;
      return;
    }

    const requestedVersion = arg("version");
    const version = requestedVersion && requestedVersion !== approved.version ? requestedVersion : approved.version;
    const previous = await store.getActiveParserVersion("amount_parser");
    await store.insertParserConfig(version, approved.config);
    await store.setActiveParserConfig("amount_parser", version);
    await store.insertImprovementAudit({
      action: "activated",
      version,
      proposalId,
      actor: "admin-cli",
      detail: { previousVersion: previous, rationale: approved.rationale },
    });
    await emitter.emit("improvement_activated", {
      traceId: String(approved.evidence["traceId"] ?? "approval"),
      status: "success",
      improvementVersion: version,
      outcome: "activated",
      ledgerExtra: { previousVersion: previous, proposalId, rationale: approved.rationale },
    });
    await observability.flush();
  process.exit(0);

    print(`approved + activated: config ${version} is live (previous: ${previous})`);
    print("the running agent picks the new version up within ~5 s - no restart needed");
  process.exit(0);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

void main().catch((error) => {
  logger.error("approve_failed", { error: error instanceof Error ? error.message : String(error) });
  printErr(`approve failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
