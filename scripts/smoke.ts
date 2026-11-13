/**
 * Phase 1 scaffold smoke check.
 *
 * Proves only: dependencies resolve, core APIs import and construct offline.
 * No network calls, no secrets required, no business logic, no integrations claimed.
 * The real agent, WhatsApp client, and PostHog wiring arrive in Phases 2-4 (see PLAN.md).
 */
import { readFileSync, existsSync } from "node:fs";
import * as voltagent from "@voltagent/core";
import { createTool } from "@voltagent/core";
import { honoServer } from "@voltagent/server-hono";
import { z } from "zod";
import { Hono } from "hono";
import { PostHog } from "posthog-node";
import postgres from "postgres";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(label: string, ok: boolean): void {
  if (ok) {
    console.log(`  PASS ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

// 1. Node version
const [major] = process.versions.node.split(".").map(Number) as [number, ...number[]];
check(`node >= 20 (actual ${process.versions.node})`, Number.isFinite(major) && major >= 20);

// 2. Env template documents every required key (nothing here needs a real value yet)
const REQUIRED_ENV_KEYS = [
  "MODEL_API_KEY",
  "MODEL_BASE_URL",
  "MODEL_NAME",
  "DATABASE_URL",
  "WHATSAPP_ENABLED",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_GRAPH_VERSION",
  "POSTHOG_PUBLIC_KEY",
  "POSTHOG_HOST",
  "POSTHOG_SECRET_KEY",
  "PORT",
];
const envPath = fileURLToPath(new URL("../.env.example", import.meta.url));
const envOk =
  existsSync(envPath) && REQUIRED_ENV_KEYS.every((k) => readFileSync(envPath, "utf8").includes(k));
check(".env.example exists and documents all required keys", envOk);

// 3. zod schema accepts the raw demo input the Phase 4 demo targets ("5k" is unresolved on purpose)
const amountInput = z.object({ item: z.string().min(1), amount: z.union([z.number(), z.string()]) });
const parsed = amountInput.parse({ item: "tomatoes", amount: "5k" });
check("zod schema parses raw '5k' input (Phase 2 parser target)", parsed.amount === "5k");

// 4. VoltAgent tool API wires up
const smokeTool = createTool({
  name: "smoke_echo",
  description:
    "Scaffold-only tool: proves the VoltAgent createTool API installs and typechecks. Never invoked.",
  parameters: amountInput,
  execute: async (args) => ({ echoed: args.item }),
});
check("createTool wires with zod parameters", typeof smokeTool === "object");

// 5. Agent / VoltAgent classes are exported (constructed in Phase 2; import-shape check here)
check(
  "Agent + VoltAgent exported from @voltagent/core",
  typeof (voltagent as Record<string, unknown>).Agent === "function" &&
    typeof (voltagent as Record<string, unknown>).VoltAgent === "function",
);

// 6. honoServer export present
check(
  "honoServer exported from @voltagent/server-hono",
  typeof honoServer === "function" || typeof honoServer === "object",
);

// 7. Hono app mounts a route (webhook chassis lives here in Phase 2)
const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));
check("Hono app mounts /health", typeof app.fetch === "function");

// 8. PostHog client constructs offline (Phase 3 wiring; no events sent here)
const ph = new PostHog("phc_smoke_placeholder", { host: "https://us.i.posthog.com" });
check("PostHog client constructs (posthog-node)", typeof ph.capture === "function");
await ph.shutdown();

// 9. postgres client constructs offline (no connection attempted)
const sql = postgres("postgres://postgres:postgres@localhost:5432/afbiz_autopilot", {
  connect_timeout: 1,
});
check("postgres client constructs", typeof sql === "function" && typeof sql.unsafe === "function");
await sql.end({ timeout: 1 });

if (failures > 0) {
  console.error(`\nSmoke check FAILED: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nSmoke check PASSED: scaffold installs, resolves, and constructs offline.");
