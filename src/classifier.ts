import type { AutoReviewConfig, ExtensionContextLike, ReviewDecision, ReviewSubject } from "./types.js";
import { buildProjectedContext } from "./context-projection.js";
import { buildSystemPrompt } from "./prompt.js";
import { toRecord } from "./common.js";

export type ClassifierClient = (
  model: unknown,
  context: unknown,
  options: Record<string, unknown>,
) => Promise<unknown>;

type ClassifierModuleLoader = (specifier: string) => Promise<unknown>;
type ClassifierModuleResolver = (specifier: string) => string;

function moduleCompleteSimple(moduleValue: unknown): ClassifierClient | undefined {
  const mod = toRecord(moduleValue);
  if (typeof mod.completeSimple === "function") {
    return mod.completeSimple as ClassifierClient;
  }
  const defaultExport = toRecord(mod.default);
  return typeof defaultExport.completeSimple === "function"
    ? defaultExport.completeSimple as ClassifierClient
    : undefined;
}

export async function loadCompleteSimple(
  importModule: ClassifierModuleLoader = (specifier) => import(specifier),
  resolveModule: ClassifierModuleResolver = (specifier) => import.meta.resolve(specifier),
): Promise<ClassifierClient> {
  const candidates = [
    "@oh-my-pi/pi-ai/compat",
    "@earendil-works/pi-ai/compat",
    "@oh-my-pi/pi-ai",
    "@earendil-works/pi-ai",
  ];
  for (const packageName of candidates) {
    try {
      const completeSimple = moduleCompleteSimple(await importModule(packageName));
      if (completeSimple) {
        return completeSimple;
      }
    } catch {
      // Try the next exported entry point.
    }
  }

  for (const packageName of ["@oh-my-pi/pi-ai", "@earendil-works/pi-ai"]) {
    try {
      const rootUrl = resolveModule(packageName);
      if (!rootUrl.includes("/dist/index.js")) {
        continue;
      }
      const compatUrl = rootUrl.replace("/dist/index.js", "/dist/compat.js");
      const completeSimple = moduleCompleteSimple(await importModule(compatUrl));
      if (completeSimple) {
        return completeSimple;
      }
    } catch {
      // Try the next package scope before reporting the combined failure.
    }
  }
  throw new Error(
    "Could not load completeSimple from pi-ai; tried both root and /compat entries for @oh-my-pi/pi-ai and @earendil-works/pi-ai.",
  );
}

export async function resolveClassifierClient(
  ctx: ExtensionContextLike,
  client?: ClassifierClient,
): Promise<ClassifierClient> {
  if (client) {
    return client;
  }

  const registry = ctx.modelRegistry;
  if (registry && typeof registry.completeSimple === "function") {
    return registry.completeSimple.bind(registry) as ClassifierClient;
  }
  if (registry && typeof registry.complete === "function") {
    return registry.complete.bind(registry) as ClassifierClient;
  }
  return loadCompleteSimple();
}

function appendTextFragments(value: unknown, fragments: string[]): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    const itemRecord = toRecord(item);
    const fragment = [itemRecord.text, itemRecord.thinking, itemRecord.content]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
    if (fragment) {
      fragments.push(fragment);
    }
  }
}

export function extractAssistantText(message: unknown): string | undefined {
  const record = toRecord(message);
  const fragments: string[] = [];

  if (typeof record.content === "string" && record.content.trim()) {
    fragments.push(record.content);
  } else {
    appendTextFragments(record.content, fragments);
  }
  if (typeof record.output === "string" && record.output.trim()) {
    fragments.push(record.output);
  } else {
    appendTextFragments(record.output, fragments);
  }
  for (const value of [record.text, record.thinking]) {
    if (typeof value === "string" && value.trim()) {
      fragments.push(value);
    }
  }

  return fragments.length > 0 ? fragments.join("") : undefined;
}

function blockTypes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    const type = toRecord(item).type;
    return typeof type === "string" ? type : typeof item;
  });
}

function responseDiagnostics(message: unknown): string {
  const record = toRecord(message);
  const diagnostics = {
    stopReason: record.stopReason,
    errorMessage: record.errorMessage,
    api: record.api,
    provider: record.provider,
    model: record.model,
    contentBlockTypes: blockTypes(record.content),
    outputBlockTypes: blockTypes(record.output),
    topLevelKeys: Object.keys(record),
  };
  const seen = new WeakSet<object>();
  let serialized: string;
  try {
    serialized = JSON.stringify(diagnostics, (_key, value: unknown) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    });
  } catch {
    serialized = "{\"diagnostics\":\"unserializable response\"}";
  }
  return serialized.length > 600 ? `${serialized.slice(0, 600)}…` : serialized;
}

export function parseReviewDecision(text: string | undefined): ReviewDecision {
  if (!text) {
    throw new Error("Classifier returned no text.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("Classifier output was not valid JSON.");
    }
    payload = JSON.parse(text.slice(start, end + 1));
  }

  const record = toRecord(payload);
  if (record.outcome !== "allow" && record.outcome !== "deny") {
    throw new Error("Classifier JSON is missing outcome allow/deny.");
  }
  const decision: ReviewDecision = { outcome: record.outcome };
  if (["low", "medium", "high", "critical"].includes(String(record.risk_level))) {
    decision.risk_level = record.risk_level as ReviewDecision["risk_level"];
  }
  if (["unknown", "low", "medium", "high"].includes(String(record.user_authorization))) {
    decision.user_authorization = record.user_authorization as ReviewDecision["user_authorization"];
  }
  if (typeof record.rationale === "string" && record.rationale.trim()) {
    decision.rationale = record.rationale.trim();
  }
  return decision;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`classifier timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function splitModelRef(modelRef: string, currentModel: Record<string, unknown>): { provider?: string; id: string } {
  const slashIndex = modelRef.indexOf("/");
  if (slashIndex > 0) {
    return {
      provider: modelRef.slice(0, slashIndex),
      id: modelRef.slice(slashIndex + 1),
    };
  }
  return {
    provider: typeof currentModel.provider === "string" ? currentModel.provider : undefined,
    id: modelRef,
  };
}

function resolveClassifierModel(ctx: ExtensionContextLike, config: AutoReviewConfig): unknown {
  const currentModel = ctx.model;
  if (!config.classifierModel) {
    return currentModel;
  }

  const currentModelRecord = toRecord(currentModel);
  const { provider, id } = splitModelRef(config.classifierModel, currentModelRecord);
  const registry = toRecord(ctx.modelRegistry);
  if (provider && typeof registry.find === "function") {
    const found = registry.find(provider, id);
    if (found) {
      return found;
    }
  }

  return provider
    ? { ...currentModelRecord, provider, id }
    : { ...currentModelRecord, id };
}

export async function classifyAction(
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  subject: ReviewSubject,
  client?: ClassifierClient,
): Promise<ReviewDecision> {
  const completeSimple = await resolveClassifierClient(ctx, client);
  const model = resolveClassifierModel(ctx, config);
  if (!model) {
    throw new Error("No active model is available for auto approval.");
  }

  const response = await withTimeout(
    completeSimple(model, {
      systemPrompt: buildSystemPrompt(config),
      messages: [{
        role: "user",
        content: buildProjectedContext(ctx, subject),
        timestamp: Date.now(),
      }],
    }, {
      temperature: 0,
    }),
    config.classifierTimeoutSeconds * 1000,
  );

  const responseText = extractAssistantText(response);
  if (!responseText) {
    const responseRecord = toRecord(response);
    const providerError = typeof responseRecord.errorMessage === "string" && responseRecord.errorMessage.trim()
      ? ` Provider error: ${responseRecord.errorMessage.trim()}.`
      : "";
    throw new Error(
      `Classifier returned no text.${providerError} Response diagnostics: ${responseDiagnostics(response)}`,
    );
  }
  return parseReviewDecision(responseText);
}
