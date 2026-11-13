/**
 * Phase 4 Step 8 (rollback): restores the previous parser configuration
 * version and records an audit row + improvement_activated (rollback) event.
 * Verify the restored behavior via the isolated evaluation (npm run improve's
 * regression output or parse checks) - the brief forbids re-breaking production.
 *   npm run rollback                 # back to the most recent other version
 *   npm run rollback -- --version parser_v1
 */
import { createDb } from "../db/client.js";
import { createStore } from "../db/store.js";
import { writeSync } from "node:fs";
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
  const sql = createDb(config.databaseUrl);
  const store = createStore(sql);
  const observability = createPostHogObservability({
    publicKey: config.posthog?.publicKey,
    host: config.posthog?.host ?? "https://us.i.posthog.com",
    onProblem: (detail) => logger.warn("posthog_problem", { detail }),
  });
  const emitter = createEmitter({ store, observability, agentVersion: config.agentVersion });

  try {
    const current = await store.getActiveParserVersion("amount_parser");
    const requested = arg("version");
    const versions = await store.listParserVersions();
    const target =
      requested ?? [...versions].reverse().find((entry) => entry.version !== current)?.version;
    if (!target || target === current) {
      printErr("rollback: no other version found to roll back to (supply --version <v>).");
      process.exitCode = 1;
      return;
    }

    const exists = versions.some((entry) => entry.version === target);
    if (!exists) {
      printErr(`rollback: version ${target} is not stored. Nothing changed.`);
      process.exitCode = 1;
      return;
    }

    await store.setActiveParserConfig("amount_parser", target);
    await store.insertImprovementAudit({
      action: "rollback",
      version: target,
      actor: "admin-cli",
      detail: { previousVersion: current },
    });
    await emitter.emit("improvement_activated", {
      traceId: "rollback",
      status: "info",
      improvementVersion: target,
      outcome: `rollback_from_${current}`,
      ledgerExtra: { previousVersion: current, restored: target },
    });
    await observability.flush();
  process.exit(0);

    print(`rolled back: active config ${current} -> ${target}`);
    print("the running agent resumes the restored behavior within ~5 s");
  process.exit(0);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

void main().catch((error) => {
  logger.error("rollback_failed", { error: error instanceof Error ? error.message : String(error) });
  printErr(`rollback failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
