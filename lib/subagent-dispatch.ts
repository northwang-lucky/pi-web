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
 *
 * Unified resolution pipeline:
 *   Tools, extensions, model, and thinking are resolved through a single
 *   typed intermediate plan (`ResolvedSubagentResources`) rather than being
 *   scattered across the runtime and extension modules.  This keeps the
 *   resolution logic testable in isolation and makes the dispatch contract
 *   explicit: callers pass params + profile + parent state, and the pipeline
 *   produces the final effective values.
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
// Unified resolution pipeline
//
// Instead of scattering tool/extension resolution across the runtime module
// (lines 201-252 in branch-1) and the extension module, this single function
// produces a typed intermediate plan.  The dispatch module reads the plan;
// the runtime consumes it.  Both are independently testable.
// ---------------------------------------------------------------------------

/** Reserved control tool names that are always excluded from child sessions. */
const RESERVED_CONTROL_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"];

export interface ResolvedSubagentResources {
  /** Base tools after allow/deny/exclude resolution. */
  effectiveTools: string[];
  /** Reserved names that must always be excluded. */
  reservedTools: readonly string[];
  /** Caller-supplied excludeTools (appended to reserved). */
  callerExcludeTools: string[];
  /** G3: effective extension allow list (dispatch overrides profile). */
  effectiveExtensions: string[] | undefined;
  /** G3: effective extension deny list (dispatch overrides profile). */
  effectiveDenyExtensions: string[] | undefined;
  /** G4: effective model after three-level fallback (param → profile → parent). */
  effectiveModel: string;
  /** G4: effective thinking after three-level fallback. */
  effectiveThinking: string | null;
  /** G6: whether to use in-memory session manager. */
  ephemeral: boolean;
}

/**
 * Resolve all subagent resources through a single pipeline.
 *
 * This is the core of the unified resolution design: dispatch params,
 * profile defaults, and parent session state are merged once, producing
 * a typed plan that the controller consumes.
 */
export function resolveSubagentResources(params: {
  dispatchTools?: string[];
  dispatchDisallowedTools?: string[];
  dispatchExtensions?: string[];
  dispatchDenyExtensions?: string[];
  dispatchExcludeTools?: string[];
  dispatchEphemeral?: boolean;
  dispatchModel?: string;
  dispatchThinking?: string;
  profileTools: string[];
  profileExtensions?: string[];
  profileDenyExtensions?: string[];
  parentModel?: string;
  parentThinking?: string | null;
}): ResolvedSubagentResources {
  // G2: per-dispatch tool allowlist overrides profile defaults.
  const baseTools = params.dispatchTools ?? params.profileTools;

  // G2: disallowedTools subtracts after merge (takes precedence over tools).
  const disallowed = new Set(params.dispatchDisallowedTools ?? []);
  let effectiveTools = baseTools.filter((tool) => !disallowed.has(tool));

  // G3: caller-supplied excludeTools extend the reserved base set.
  const callerExcludeTools = params.dispatchExcludeTools ?? [];
  const allExcluded = new Set([...RESERVED_CONTROL_TOOLS, ...callerExcludeTools]);
  effectiveTools = effectiveTools.filter((tool) => !allExcluded.has(tool));

  // G3: extension filtering — dispatch params override profile defaults.
  const effectiveExtensions = params.dispatchExtensions ?? params.profileExtensions;
  const effectiveDenyExtensions = params.dispatchDenyExtensions ?? params.profileDenyExtensions;

  // G4: three-level model fallback (dispatch param → profile → parent session).
  const effectiveModel = params.dispatchModel ?? params.parentModel ?? "";

  // G4: three-level thinking fallback.
  const effectiveThinking = params.dispatchThinking ?? params.parentThinking ?? null;

  // G6: ephemeral flag defaults to false.
  const ephemeral = params.dispatchEphemeral ?? false;

  return {
    effectiveTools,
    reservedTools: RESERVED_CONTROL_TOOLS,
    callerExcludeTools,
    effectiveExtensions,
    effectiveDenyExtensions,
    effectiveModel,
    effectiveThinking,
    ephemeral,
  };
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

    // Wire AbortSignal → abort linkage.
    let signalAbort: (() => void) | null = null;
    if (params.signal) {
      const onAbort = () => { signalAbort?.(); };
      params.signal.addEventListener("abort", onAbort, { once: true });
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
    // (subagent-runtime.ts).  The dispatch module only forwards the
    // ephemeral flag; the controller creates the appropriate SessionManager.
    const ephemeral = params.ephemeral ?? false;

    // Delegate to the controller.
    const request = {
      parentContext,
      parentToolCallId: dispatchId,
      profile: params.profile ?? "default",
      task: params.task,
      description: params.description,
      runInBackground: params.runInBackground,
      model: params.model,
      thinking: params.thinking,
      tools: params.tools,
      disallowedTools: params.disallowedTools,
      excludeTools: params.excludeTools,
      extensions: params.extensions,
      denyExtensions: params.denyExtensions,
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

    const { run: childRun, completion: rawCompletion } =
      await controller.extensionRuntime.start(request);

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

    function settle(phase: "completed" | "aborted", run: SubagentRunInfo, error?: string) {
      if (settled) return;
      settled = true;
      active.delete(dispatchId);

      // The controller resolves the three-level fallback (dispatch param →
      // profile → parent session) and surfaces the authoritative effective
      // values on the run.  We read them directly — no transitional fallback
      // needed because B4 guarantees model/thinking are always populated.
      const runExtra = run as unknown as { model?: string; thinking?: string | null; tools?: string[] };
      resolveCompletion({
        phase,
        dispatchId,
        childSessionId: run.sessionId,
        effectiveModel: runExtra.model ?? "",
        effectiveThinking: runExtra.thinking ?? null,
        result: run.result,
        error: error ?? run.error,
        effectiveTools: runExtra.tools,
      });
    }

    // When the controller signals completion, settle as "completed".
    rawCompletion.then(
      (terminal) => settle("completed", terminal),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        settle("aborted", childRun, msg);
      },
    );

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
