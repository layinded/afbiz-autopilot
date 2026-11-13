import { readFileSync } from "node:fs";
import { Agent } from "@voltagent/core";
import type { Agent as AgentType, Memory, Tool } from "@voltagent/core";
import type { LanguageModel } from "ai";

export function supervisorInstructions(): string {
  return readFileSync(new URL("./prompts/supervisor.md", import.meta.url), "utf8").trim();
}

export function createSupervisorAgent(options: {
  model: LanguageModel;
  memory: Memory;
  tools: Tool<any, any>[];
  instructions?: string;
}): AgentType {
  return new Agent({
    name: "afbiz-supervisor",
    purpose:
      "Business assistant for a small Nigerian retail business over WhatsApp: records sales, expenses and customer debts, and reads business summaries and customer balances.",
    instructions: options.instructions ?? supervisorInstructions(),
    model: options.model,
    tools: options.tools,
    memory: options.memory,
    maxSteps: 6,
  });
}
