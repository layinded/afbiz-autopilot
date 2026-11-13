/** Scripted LanguageModelV3 for offline integration tests (reference-repo pattern).
 * VoltAgent's REAL agent machinery runs; only the model is replaced. Each
 * doStream call consumes one queued step. */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";

const DEFAULT_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

function resultOf(parts: LanguageModelV3StreamPart[]): LanguageModelV3StreamResult {
  return {
    stream: simulateReadableStream<LanguageModelV3StreamPart>({
      chunks: parts,
      initialDelayInMs: 0,
      chunkDelayInMs: null,
    }),
  };
}

// ai@6's stream loop reads finishReason as { unified, raw }, while the installed
// @ai-sdk/provider still types it as a plain string. Adapter marks exactly that
// packaging-drift boundary (same as the reference test helper).
interface VersionedFinishReason {
  unified: string;
  raw: string;
}

function finishPart(reason: string, usage: LanguageModelV3Usage): LanguageModelV3StreamPart {
  return {
    type: "finish",
    finishReason: { unified: reason, raw: reason } as unknown as LanguageModelV3StreamPart extends {
      finishReason: infer F;
    }
      ? F
      : never,
    usage,
  };
}

let serial = 0;
function nextSerial(): number {
  serial += 1;
  return serial;
}

export function toolCallStep(
  toolName: string,
  input: unknown,
  usage: LanguageModelV3Usage = DEFAULT_USAGE,
): LanguageModelV3StreamResult {
  return resultOf([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: `call_${toolName}_${nextSerial()}`,
      toolName,
      input: JSON.stringify(input),
    },
    finishPart("tool-calls", usage),
  ]);
}

export function textStep(text: string, usage: LanguageModelV3Usage = DEFAULT_USAGE): LanguageModelV3StreamResult {
  return resultOf([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    finishPart("stop", usage),
  ]);
}

export interface ScriptedModel extends LanguageModelV3 {
  push(steps: LanguageModelV3StreamResult[]): void;
  pushGenerate(texts: string[]): void;
  pushedCalls: number;
  consumedCalls: number;
}

export function createScriptedModel(initial: LanguageModelV3StreamResult[] = []): ScriptedModel {
  let queue: LanguageModelV3StreamResult[] = [];
  const generateQueue: string[] = [];
  const model: ScriptedModel = {
    provider: "scripted-afbiz",
    modelId: "scripted-model-v3",
    specificationVersion: "v3",
    supportedUrls: {},
    pushedCalls: 0,
    consumedCalls: 0,
    push(steps: LanguageModelV3StreamResult[]): void {
      queue.push(...steps);
      model.pushedCalls += steps.length;
    },
    pushGenerate(texts: string[]): void {
      generateQueue.push(...texts);
    },
    async doStream(_callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      model.consumedCalls += 1;
      const step = queue.shift();
      if (!step) {
        return resultOf([
          { type: "stream-start", warnings: [] },
          { type: "error", error: new Error("scripted queue exhausted") },
        ]);
      }
      return step;
    },
    async doGenerate(_callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      model.consumedCalls += 1;
      const text = generateQueue.shift();
      if (text === undefined) {
        throw new Error("scripted generate queue exhausted");
      }
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" } as never,
        usage: DEFAULT_USAGE,
        warnings: [],
      };
    },
  };
  model.push(initial);
  return model;
}
