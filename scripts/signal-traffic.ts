/**
 * Bounded traffic generator for the Phase 5 signal window: drives the REAL
 * WhatsApp pipeline (signed local webhook -> agent -> ledger -> PostHog EU)
 * N times, sequentially, with deterministic message ids. Used to generate the
 * attempt/completion evidence the official silent-failure scout watches after
 * Self-driving setup lands.
 *
 *   npm run traffic -- --count 15 --text "Amina bought goods worth ₦12,000 on credit."
 *   npm run traffic -- --count 15 --text "Amina paid me 5k from what she owes." --delay 25000
 *
 * Output: one line per delivered message (receipt claimed is printed by the
 * server log, not here). Never sends more than --cap messages.
 */
import { spawnSync } from "node:child_process";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? (process.argv[index + 1] as string) : fallback;
}

const count = Math.min(Number(arg("count", "12")) || 12, Number(arg("cap", "40")) || 40);
const text = arg("text", "Amina paid me 5k from what she owes.");
const prefix = arg("id-prefix", "traffic");
const delayMs = Number(arg("delay", "30000")) || 30000;
const from = arg("from", "+2349000000001");

let delivered = 0;
let rejected = 0;
for (let i = 1; i <= count; i++) {
  const id = `${prefix}-${String(i).padStart(3, "0")}`;
  const result = spawnSync(
    "npx",
    [
      "tsx",
      "--env-file-if-exists=.env",
      "scripts/dev-send.ts",
      "--text",
      text,
      "--from",
      from,
      "--id",
      id,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0 && out.includes("SEND status=200")) {
    delivered += 1;
  } else {
    rejected += 1;
    console.error(`${id}: delivery problem (HTTP/status ${result.status}) - ${out.split("\n")[0] ?? ""}`);
  }
  if (i < count && delayMs > 0) {
    spawnSync("sleep", [String(Math.round(delayMs / 1000))]);
  }
}
console.log(`traffic: delivered ${delivered}/${count} (rejected ${rejected}) with text "${text.slice(0, 60)}"`);
process.exit(0);
