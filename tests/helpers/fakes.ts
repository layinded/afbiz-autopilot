/** Shared in-memory fakes for direct tool tests. */
import type { Tool, ToolExecuteOptions } from "@voltagent/core";
import { TEST_OWNER, TEST_TODAY } from "./test-db.js";

export function fakeOpOptions(userId: string = TEST_OWNER, today: string = TEST_TODAY): ToolExecuteOptions {
  return {
    userId,
    context: new Map<string, unknown>([
      ["today", today],
      ["traceId", "t_test"],
      ["source", "test"],
    ]),
  } as unknown as ToolExecuteOptions;
}

export async function executeTool(
  tool: Tool<any, any>,
  args: Record<string, unknown>,
  options?: ToolExecuteOptions,
): Promise<unknown> {
  if (!tool.execute) throw new Error(`tool "${tool.name}" has no server-side execute`);
  return await tool.execute(args, options);
}
