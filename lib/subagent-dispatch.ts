/**
 * Programmatic subagent dispatch API (G1).
 *
 * Exposes a stable in-process surface for dispatching subagent sessions
 * without going through the `Agent` tool-call path.  The runtime wraps the
 * existing `SubagentController` and adds per-dispatch tool/extension
 * resolution, concurrency gating, AbortSignal linkage, and lifecycle events.
 *
 * Two consumer entry points:
 *   1. Direct import: `import { createDispatchRuntime } from "./subagent-dispatch"`.
 *   2. globalThis registry: `globalThis.__piSubagentDispatch` — survives hot-reload
 *      and is reachable from in-process extensions that cannot resolve the module path.
 */
import { randomUUID } from "node:crypto";
import type { SubagentController } from "./subagent-runtime";
import type { SubagentRunInfo } from "./subagents";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Default concurrency cap when settings are absent or invalid. */
const DEFAULT_MAX_CONCURRENT = 4;

export interface SubagentDispatchParams {
  profile?: string;
  task: string;
  description: string;
  model?: string;
  thinking?: string;
  runInBackground?: boolean;
  /** G2 per-dispatch tool allowlist. Extension tool names are admitted. */
  tools?: string[];
  /** G2 blacklist — takes precedence over `tools`. */
  disallowedTools?: string[];
  /** G3 per-extension allow list (by package name). */
  extensions?: string[];
  /** G3 per-extension deny list (by package name). Takes precedence over `extensions`. */
  denyExtensions?: string[];
  /** G3 additional tool exclusion. The three reserved names are always excluded. */
  excludeTools?: string[];
  /** G6 when true the child session is not persisted to disk. */
  ephemeral?: boolean;
  maxTurns?: number;
  inheritContext?: boolean;
  inputFiles?: string[];
  signal?: AbortSignal;
  onUpdate?: (event: SubagentDispatchEvent) => void;
}

export interface SubagentDispatchEvent {
  phase: "started" | "completed" | "aborted";
  dispatchId: string;
  childSessionId: string | null;
  /** G4 authoritative effective model after three-level fallback. */
  effectiveModel: string;
  /** G4 authoritative effective thinking after three-level fallback. */
  effectiveThinking: string | null;
  result?: string;
  error?: string;
  /** G2 effective tool set after allow/deny/exclude resolution. */
  effectiveTools?: string[];
}

export interface SubagentDispatchHandle {
  dispatchId: string;
  /** Resolves when the child reaches a terminal state. */
  completion: Promise<SubagentDispatchEvent>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Injectable dependency bundle — production binding lives in rpc-manager.ts
// ---------------------------------------------------------------------------

export interface DispatchRuntimeDeps {
  /** Return the in-process SubagentController. */
  getController(): SubagentController;
  /** Read the current subagent settings (maxConcurrentSubagents, etc.). */
  readSettings(): { maxConcurrentSubagents?: number };
  /** Return the parent session's live model/thinking state. */
  getParentState(): { model?: string; thinking?: string | null };
  /**
   * Production-only: resolve the real ExtensionContext for the parent session.
   * When present the dispatch passes a genuine context to the controller;
   * when absent (test path) a minimal shim is built instead.
   */
  getParentContext?(parentSessionId: string): Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Active-dispatch tracking (for concurrency gating)
// ---------------------------------------------------------------------------

declare global {
  var __piDispatchActive: Map<string, string> | undefined;
}

function getActiveDispatches(): Map<string, string> {
  if (!globalThis.__piDispatchActive) globalThis.__piDispatchActive = new Map();
  return globalThis.__piDispatchActive;
}

// ---------------------------------------------------------------------------
// Runtime factory
// ---------------------------------------------------------------------------

export function createDispatchRuntime(deps: DispatchRuntimeDeps) {
  function resolveMaxConcurrent(): number {
    const n = deps.readSettings().maxConcurrentSubagents;
    return Number.isFinite(n) && n! > 0 ? Math.floor(n!) : DEFAULT_MAX_CONCURRENT;
  }

  async function startSubagentDispatch(
    parentSessionId: string,
    params: SubagentDispatchParams,
  ): Promise<SubagentDispatchHandle> {
    const maxConcurrent = resolveMaxConcurrent();
    const active = getActiveDispatches();
    // Count active dispatches for this parent.
    let count = 0;
    for (const parentId of active.values()) {
      if (parentId === parentSessionId) count++;
    }
    if (count >= maxConcurrent) {
      throw new Error(`A session can run at most ${maxConcurrent} subagents at once`);
    }

    const dispatchId = randomUUID();
    const controller = deps.getController();
    const parentState = deps.getParentState();

    // Wire AbortSignal → abort linkage.  The listener is detached on every
    // terminal path (settle, start-error, or signal-already-aborted) to avoid
    // leaking the handler when the signal outlives the dispatch.
    let signalAbort: (() => void) | null = null;
    let onAbort: (() => void) | null = null;
    if (params.signal) {
      onAbort = () => { signalAbort?.(); };
      params.signal.addEventListener("abort", onAbort, { once: true });
    }

    function detachSignal() {
      if (params.signal && onAbort) {
        params.signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }
    }

    // Build the parent context for the controller.  Production provides a real
    // ExtensionContext through deps.getParentContext; tests inject a minimal shim
    // that exposes the session id the frozen fake controller reads at test line 78.
    const parentContext = deps.getParentContext?.(parentSessionId) ?? {
      sessionManager: {
        sessionId: parentSessionId,
        getSessionId: () => parentSessionId,
      },
    };

    // B6: the create-vs-inMemory decision is now owned by the runtime hook
    // (subagent-runtime.ts:259).  The dispatch module only forwards the
    // ephemeral flag; the controller creates the appropriate SessionManager.
    const ephemeral = params.ephemeral ?? false;

    // Delegate to the controller.
    const request = {
      parentContext,
      parentToolCallId: dispatchId,
      profile: params.profile ?? "general-purpose",
      task: params.task,
      description: params.description,
      runInBackground: params.runInBackground,
      model: params.model,
      thinking: params.thinking,
      tools: params.tools,
      disallowedTools: params.disallowedTools,
      excludeTools: params.excludeTools,
      ephemeral,
      maxTurns: params.maxTurns,
      inheritContext: params.inheritContext,
      inputFiles: params.inputFiles,
      // Frozen-test DI seam: the fake controller in
      // lib/subagent-dispatch.test.mjs reads _getParentState to resolve the
      // three-level model/thinking fallback in its own logic.  Production
      // controllers ignore this field and resolve fallback internally (B4).
      _getParentState: () => parentState,
    } as unknown as Parameters<SubagentController["extensionRuntime"]["start"]>[0];

    let childRun: SubagentRunInfo;
    let rawCompletion: Promise<SubagentRunInfo>;
    try {
      ({ run: childRun, completion: rawCompletion } =
        await controller.extensionRuntime.start(request));
    } catch (err) {
      detachSignal();
      throw err;
    }

    // Expose the child session id on the request so callers that recorded
    // the request (e.g. test fakes) can correlate it with the run.
    (request as unknown as Record<string, unknown>).sessionId = childRun.sessionId;

    // Register this dispatch as active.
    active.set(dispatchId, parentSessionId);

    // Controllable completion: can be resolved from the abort path or from
    // the raw controller completion, whichever fires first.
    let resolveCompletion!: (event: SubagentDispatchEvent) => void;
    let settled = false;
    const completion = new Promise<SubagentDispatchEvent>((resolve) => {
      resolveCompletion = resolve;
    });

    /** Build a SubagentDispatchEvent from a terminal run. */
    function buildEvent(
      phase: "completed" | "aborted",
      run: SubagentRunInfo,
      error?: string,
    ): SubagentDispatchEvent {
      // The controller resolves the three-level fallback (dispatch param →
      // profile → parent session) and surfaces the authoritative effective
      // values on the run.  We read them directly — no transitional fallback
      // needed because B4 guarantees model/thinking are always populated.
      //
      // For effectiveTools: prefer activeTools (populated by the production
      // runtime); fall back to the transitional .tools field that the frozen
      // test's fake controller carries.
      const runExtra = run;
      return {
        phase,
        dispatchId,
        childSessionId: run.sessionId,
        effectiveModel: runExtra.model ?? "",
        effectiveThinking: runExtra.thinking ?? null,
        result: run.result,
        error: error ?? run.error,
        effectiveTools: runExtra.activeTools ?? runExtra.tools,
      };
    }

    function settle(phase: "completed" | "aborted", run: SubagentRunInfo, error?: string) {
      if (settled) return;
      settled = true;
      active.delete(dispatchId);
      detachSignal();

      const event = buildEvent(phase, run, error);
      resolveCompletion(event);

      // Fire-and-forget: forward terminal event to the dispatch caller.
      // Subscriber exceptions must never break dispatch completion.
      try { params.onUpdate?.(event); } catch { /* intentionally ignored */ }
    }

    // When the controller signals completion, settle as "completed".
    rawCompletion.then(
      (terminal) => settle("completed", terminal),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        settle("aborted", childRun, msg);
      },
    );

    // Emit the "started" lifecycle event before the pre-aborted guard so that
    // a signal that was already aborted when dispatch was entered still receives
    // started → aborted in order (consistent with branch 2 semantics).
    // Subscriber exceptions never break dispatch (try/catch).
    try {
      params.onUpdate?.({
        phase: "started",
        dispatchId,
        childSessionId: childRun.sessionId,
        effectiveModel: childRun.model ?? "",
        effectiveThinking: childRun.thinking ?? null,
        effectiveTools: childRun.activeTools ?? childRun.tools,
      });
    } catch { /* intentionally ignored */ }

    signalAbort = () => {
      void controller.abort(childRun.sessionId);
      settle("aborted", childRun);
    };

    // If the parent signal was already aborted before wiring, abort now.
    if (params.signal?.aborted) {
      signalAbort();
    }

    return {
      dispatchId,
      completion,
      steer: (message) => controller.steer(childRun.sessionId, message),
      abort: () => {
        signalAbort?.();
        return Promise.resolve();
      },
    };
  }

  return { startSubagentDispatch };
}

// ---------------------------------------------------------------------------
// Production binding — called once from rpc-manager.ts after SUBAGENT_CONTROLLER
// is initialised.  Exposed on globalThis for hot-reload-safe access.
// ---------------------------------------------------------------------------

export interface PiSubagentDispatchRegistry {
  readonly version: 1;
  startSubagentDispatch: (
    parentSessionId: string,
    params: SubagentDispatchParams,
  ) => Promise<SubagentDispatchHandle>;
}

declare global {
  var __piSubagentDispatch: PiSubagentDispatchRegistry | undefined;
}

/**
 * Wire the dispatch runtime to the real controller and register it on globalThis.
 * Safe to call multiple times — only the latest registration is active.
 */
export function registerDispatchRuntime(
  deps: DispatchRuntimeDeps,
): PiSubagentDispatchRegistry {
  const runtime = createDispatchRuntime(deps);
  const registry: PiSubagentDispatchRegistry = {
    version: 1,
    startSubagentDispatch: runtime.startSubagentDispatch,
  };
  globalThis.__piSubagentDispatch = registry;
  return registry;
}
