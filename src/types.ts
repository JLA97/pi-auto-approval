export type AutoReviewMode = "fallback" | "auto";

export interface AutoReviewConfig {
  enabled: boolean;
  mode: AutoReviewMode;
  classifierModel: string | null;
  approvalTimeoutSeconds: number;
  classifierTimeoutSeconds: number;
  maxConsecutiveDenials: number;
  safeCommandAllowlist: string[];
  allow: string[];
  deny: string[];
  environment: string;
  audit: boolean;
  jev: JevConfig;
}

export type JevMode = "off" | "cascade" | "shadow";

export interface JevConfig {
  /** off keeps the existing chat-classifier behavior untouched. */
  mode: JevMode;
  /** TypeSafe-compatible System One endpoint base. Defaults to https://api.typesafe.ai. Point at https://openrouter.ai/api to use an OpenRouter key. */
  baseUrl: string;
  /** Explicit API key. When empty, TYPESAFE_API_KEY (or OPENROUTER_API_KEY for OpenRouter base URLs) is read from the environment. */
  apiKey: string;
  /** System One model id, e.g. jev-latest. A typesafe/ prefix is added automatically on OpenRouter endpoints. */
  model: string;
  timeoutSeconds: number;
  /** In cascade mode, P(allow) at or above this threshold is approved directly by Jev. */
  allowThreshold: number;
  /** In cascade mode, P(allow) at or below this threshold is treated as a high-confidence deny. */
  denyThreshold: number;
}

export interface JevDecision {
  allowProbability: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  riskScore: number;
  riskConfidence?: number;
  userAuthorization: "unknown" | "low" | "medium" | "high";
  authorizationScore: number;
  authorizationConfidence?: number;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ReviewDecision {
  risk_level?: "low" | "medium" | "high" | "critical";
  user_authorization?: "unknown" | "low" | "medium" | "high";
  outcome: "allow" | "deny";
  rationale?: string;
}

export interface ToolCallEventLike {
  toolCallId?: string;
  tool?: unknown;
  toolName?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
}

export interface ExtensionContextLike {
  cwd?: string;
  mode?: "tui" | "rpc" | "print" | string;
  hasUI?: boolean;
  ui?: {
    select?: (title: string, options: string[], optionsOverride?: unknown) => Promise<string | undefined>;
    input?: (title: string, placeholder?: string, optionsOverride?: unknown) => Promise<string | undefined>;
    custom?: <T>(
      factory: (
        tui: any,
        theme: any,
        keybindings: any,
        done: (result: T) => void,
      ) => unknown | Promise<unknown>,
      optionsOverride?: unknown,
    ) => Promise<T>;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus?: (key: string, value: string | undefined) => void;
  };
  model?: unknown;
  modelRegistry?: {
    refresh?: () => void;
    getError?: () => string | undefined;
    find?: (provider: string, id: string) => unknown;
    getAvailable?: () => unknown[] | Promise<unknown[]>;
    completeSimple?: (model: unknown, context: unknown, options: Record<string, unknown>) => Promise<unknown>;
    complete?: (model: unknown, context: unknown, options: Record<string, unknown>) => Promise<unknown>;
  };
  sessionManager?: {
    getEntries?: () => unknown[];
    getBranch?: () => unknown[];
  };
}

export interface ReviewSubject {
  toolName: string;
  input: unknown;
  cwd: string;
  actionSummary: string;
  actionHash: string;
}

export type RouteName =
  | "disabled"
  | "readonly"
  | "workspace_write"
  | "safe_command"
  | "session_approval"
  | "classifier_cache"
  | "classifier"
  | "jev"
  | "jev_deny"
  | "human"
  | "manual_only";

export interface AuditEntry {
  event: string;
  route: RouteName;
  mode: AutoReviewMode;
  toolName: string;
  actionSummary: string;
  actionHash: string;
  outcome: "allow" | "deny";
  classifierDecision?: ReviewDecision;
  humanDecision?: string;
  reason?: string;
  durationMs?: number;
  /** Jev judgment recorded for accuracy analysis. Present in cascade decisions and in every shadow-mode classifier decision. */
  jevDecision?: JevDecision;
  /** True when cascade mode escalated an uncertain Jev band to the chat classifier. */
  jevEscalated?: boolean;
  /** Set when a Jev call failed in cascade (fell back to chat) or shadow mode. */
  jevError?: string;
}
