/**
 * Official PostHog MCP driver (Phase 5): drives `mcp.posthog.com/mcp` using the
 * CLI-style `exec` grammar the PostHog setup skill specifies
 * (search / info / schema / call). Auth: Bearer <POSTHOG_API_TOKEN>.
 *
 *   POSTHOG_API_TOKEN=phx_... npx tsx scripts/posthog-mcp.ts exec "tools"
 *   POSTHOG_API_TOKEN=phx_... npx tsx scripts/posthog-mcp.ts exec "info scout-project-profile-get"
 *   POSTHOG_API_TOKEN=phx_... npx tsx scripts/posthog-mcp.ts exec "call scout-project-profile-get {}"
 *   POSTHOG_API_TOKEN=phx_... npx tsx scripts/posthog-mcp.ts raw <tool_name> {"json":"input"}
 */
import { writeSync } from "node:fs";

const MCP_URL = process.env["POSTHOG_MCP_URL"] ?? "https://mcp.posthog.com/mcp";
const TOKEN = process.env["POSTHOG_API_TOKEN"]?.trim();
let sessionId: string | undefined;

function print(line: string): void {
  writeSync(1, line + "\n");
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function rpc(payload: Record<string, unknown>): Promise<JsonRpcResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  const headerSession = response.headers.get("mcp-session-id");
  if (headerSession) sessionId = headerSession;

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${rawText.slice(0, 400)}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    for (const block of rawText.split("\n\n")) {
      const dataLine = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (dataLine) {
        return JSON.parse(dataLine) as JsonRpcResponse;
      }
    }
    return {};
  }
  return JSON.parse(rawText || "{}") as JsonRpcResponse;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = argv[0] ?? "exec";
  if (!TOKEN) {
    print("posthog-mcp: POSTHOG_API_TOKEN is not set (Settings -> Personal API keys; phx_...).");
    process.exit(1);
  }

  const init = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "afbiz-autopilot", version: "0.1.0" },
    },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);

  let result: unknown;
  if (mode === "raw") {
    const toolName = argv[1] ?? "";
    const toolInput = argv[2] ?? "{}";
    if (!toolName) throw new Error("raw mode: <tool_name> required");
    result = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: {
          ...JSON.parse(toolInput),
          context: "afbiz-autopilot: verifying Self-driving inbox, scout runs, and reports for the 5k payment-failure signal",
          llm_model: "glm-5.3-flash",
        },
      },
    });
  } else if (mode === "exec") {
    const command = argv.slice(1).join(" ");
    if (!command) throw new Error('exec mode: <command> required, e.g. "search inbox|scout" or "info <tool>"');
    result = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "exec",
        arguments: {
          command,
          context: "afbiz-autopilot: verifying Self-driving inbox, scout runs, and reports for the 5k payment-failure signal",
          llm_model: "glm-5.3-flash",
        },
      },
    });
  } else if (mode === "list") {
    result = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  } else {
    throw new Error("modes: raw | exec | list");
  }

  print(JSON.stringify(result, null, 2));
  process.exit(0);
}

void main().catch((error) => {
  print(`posthog-mcp failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
