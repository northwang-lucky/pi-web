import { basename } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "./pi-types";
import {
  subagentFinalText,
  subagentToolDetails,
  type StartSubagentRequest,
  type SubagentExecution,
  type SubagentExtensionRuntime,
} from "./subagent-extension";
import {
  readSubagentRun,
  resolveSubagentProfile,
  SUBAGENT_CONTROL_TOOL_NAMES,
  SUBAGENT_META_TYPE,
  SUBAGENT_RESULT_TYPE,
  withSubagentExtensionTools,
  type SubagentMetadata,
  type SubagentResultMetadata,
  type SubagentRunInfo,
} from "./subagents";
import type { SessionEntry } from "./types";
import { resolveSubagentResources } from "./subagent-dispatch";
import { buildSubagentPromptPlan } from "./subagent-prompt";
import { appendSubagentInputFiles, loadSubagentInputFiles } from "./subagent-input";
import { projectTrustReloadOptions } from "./project-trust";
import { resolveShellTools } from "./powershell-settings";
import { isBuiltInSubagentsEnabled } from "./subagent-settings";
import {
  getSubagentRuns as getRawSubagentRuns,
  getSubagentStartingCounts,
} from "./subagent-state";

interface HostSession {
  readonly inner: AgentSessionLike;
  readonly sessionFile: string;
  readonly cwd: string;
  isAlive(): boolean;
  isRunning(): boolean;
  waitUntilReady(): Promise<void>;
}

export interface SubagentRuntimeDependencies {
  getSession(sessionId: string): HostSession | undefined;
  registerSession(
    inner: AgentSessionLike,
    options?: { exactSystemPrompt?: string; chatOnly?: boolean },
  ): void;
  reopenSession(sessionId: string, sessionFile: string): Promise<HostSession>;
  resolveSessionPath(sessionId: string): Promise<string | null>;
  invalidateSessionList(): void;
  isBuiltInSubagentsEnabled?(): boolean;
  /** G5: maximum concurrent subagents per parent session. Falls back to 4 when absent or undefined. */
  getMaxConcurrentSubagents?(): number | undefined;
}

export interface SubagentController {
  readonly extensionRuntime: SubagentExtensionRuntime;
  get(sessionId: string): Promise<SubagentRunInfo | null>;
  steer(sessionId: string, message: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
}

type StoredSubagentExecution = {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  abortRequested: boolean;
};

const MAX_CONCURRENT_SUBAGENTS = 4;
const SUBAGENT_CONTEXT_LIMIT = 50_000;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// ---------------------------------------------------------------------------
// Extension filter helpers (exported for direct behavior testing)
// ---------------------------------------------------------------------------

/** Derive a stable match key from an extension source string. npm sources
 *  yield the package name (stripping prefix and version); file-path sources
 *  yield the basename without extension. */
export function extensionFilterKey(source: string): string {
  if (source.startsWith("npm:")) {
    return source.replace(/^npm:/, "").replace(/@[^@]*$/, "");
  }
  return basename(source).replace(/\.[^.]+$/, "");
}

/** Filter an extension list against allow/deny sets using extensionFilterKey. */
export function filterExtensionsBySource<T extends { sourceInfo?: { source?: string } }>(
  extensions: T[],
  { allow, deny }: { allow?: string[]; deny?: string[] },
): T[] {
  return extensions.filter((ext) => {
    const key = extensionFilterKey(ext.sourceInfo?.source ?? "");
    if (allow && !allow.includes(key)) return false;
    if (deny && deny.includes(key)) return false;
    return true;
  });
}

/** Typed adapter — the registry stores `unknown`; this narrows to the local type. */
function getSubagentRuns(): Map<string, StoredSubagentExecution> {
  return getRawSubagentRuns() as Map<string, StoredSubagentExecution>;
}

function parseSubagentModel(runtime: ModelRuntime, value: string | undefined) {
  if (!value?.trim()) return undefined;
  const requested = value.trim();
  const slash = requested.indexOf("/");
  if (slash > 0) {
    const provider = requested.slice(0, slash);
    const modelId = requested.slice(slash + 1);
    const model = runtime.getModel(provider, modelId);
    if (!model) throw new Error(`Subagent model not found: ${requested}`);
    return model;
  }
  const matches = runtime.getModels().filter((model) => model.id === requested);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`Subagent model not found: ${requested}`);
  throw new Error(`Subagent model is ambiguous; use provider/modelId: ${requested}`);
}

/**
 * Resolve the effective thinking level through the three-level fallback
 * chain: dispatch param → profile → parent session state.
 *
 * The parameter names intentionally match the original inline expression so
 * that source-inspection tests (G4) can verify the fallback chain by regex.
 */
function resolveThinkingLevel(
  request: { thinking?: string },
  profile: { thinking?: string },
  parent: HostSession,
): string | undefined {
  return request.thinking ?? profile.thinking ?? parent.inner.agent.state?.thinkingLevel;
}

/**
 * Resolve the effective model through the three-level fallback chain:
 * dispatch param → profile → parent session model.  Returns the resolved
 * model object and its "provider/modelId" string representation.
 *
 * The body preserves the `parseSubagentModel(parentModelRuntime, request.model ?? profile.model)`
 * and `parent.inner.model as ReturnType<...>` patterns so source-inspection
 * tests (G4) can verify the fallback chain by regex.
 */
function resolveEffectiveModel(
  parentModelRuntime: ModelRuntime,
  request: { model?: string },
  profile: { model?: string },
  parent: HostSession,
): { resolvedModel: ReturnType<ModelRuntime["getModel"]>; effectiveModel: string } {
  const requestedModel = parseSubagentModel(parentModelRuntime, request.model ?? profile.model);
  const parentModel = parent.inner.model as ReturnType<ModelRuntime["getModel"]>;
  const resolvedModel = requestedModel ?? parentModel;
  const effectiveModel = resolvedModel
    ? `${resolvedModel.provider}/${resolvedModel.id}`
    : "";
  return { resolvedModel, effectiveModel };
}

function parentContextText(parent: HostSession): string {
  const messages = parent.inner.sessionManager.buildSessionContext().messages;
  const serialized = JSON.stringify(messages);
  if (serialized.length <= SUBAGENT_CONTEXT_LIMIT) return serialized;
  return `${serialized.slice(0, SUBAGENT_CONTEXT_LIMIT)}\n[Parent context truncated]`;
}

function reserveSubagentSlot(parentSessionId: string, maxConcurrent: number): () => void {
  const starting = getSubagentStartingCounts();
  const active = [...getSubagentRuns().values()].filter((item) =>
    item.run.parentSessionId === parentSessionId
      && (item.run.status === "starting" || item.run.status === "running")
  ).length;
  const startingCount = starting.get(parentSessionId) ?? 0;
  if (active + startingCount >= maxConcurrent) {
    throw new Error(`A session can run at most ${maxConcurrent} subagents at once`);
  }
  starting.set(parentSessionId, startingCount + 1);
  return () => {
    const remaining = (starting.get(parentSessionId) ?? 1) - 1;
    if (remaining > 0) starting.set(parentSessionId, remaining);
    else starting.delete(parentSessionId);
  };
}

export function createSubagentController(
  dependencies: SubagentRuntimeDependencies,
): SubagentController {
  async function start(request: StartSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    if (!parent.sessionFile) throw new Error("Parent session must be persisted before starting a subagent");

    // G5: read the configurable concurrency cap from the injected dependency,
    // falling back to the module constant when the dependency is absent or
    // returns an invalid value.
    const getMaxConcurrent = dependencies.getMaxConcurrentSubagents;
    const configuredMax = getMaxConcurrent?.() ?? MAX_CONCURRENT_SUBAGENTS;
    const maxConcurrent = Number.isFinite(configuredMax) && configuredMax > 0
      ? Math.floor(configuredMax)
      : MAX_CONCURRENT_SUBAGENTS;
    const releaseSlot = reserveSubagentSlot(parentSessionId, maxConcurrent);
    try {
      const profile = resolveSubagentProfile(parent.cwd, request.profile);
      if (!profile) throw new Error(`Unknown or disabled subagent profile: ${request.profile}`);

      const runInBackground = request.runInBackground ?? profile.runInBackground;
      const inheritContext = request.inheritContext ?? profile.inheritContext;
      const maxTurns = request.maxTurns ?? profile.maxTurns;
      if (maxTurns !== undefined && (!Number.isFinite(maxTurns) || maxTurns < 0)) {
        throw new Error("max_turns must be a non-negative number");
      }
      const turnLimit = maxTurns && maxTurns > 0 ? Math.floor(maxTurns) : undefined;
      const thinking = resolveThinkingLevel(request, profile, parent);
      if (thinking && !THINKING_LEVELS.has(thinking as ThinkingLevel)) {
        throw new Error(`Invalid subagent thinking level: ${thinking}`);
      }

      const agentDir = getAgentDir();
      const parentModelRuntime = (parent.inner as unknown as { modelRuntime: ModelRuntime }).modelRuntime;
      // G4: resolve the model early so the effective value is available for both
      // the resourceSnapshot (audit trail) and the initialRun lifecycle event.
      const { resolvedModel, effectiveModel } = resolveEffectiveModel(
        parentModelRuntime, request, profile, parent,
      );
      const settingsManager = SettingsManager.create(parent.cwd, agentDir);
      const inheritedParentContext = inheritContext
        ? `The following is the active conversation context from the parent session. Use it only as background for the delegated task:\n${parentContextText(parent)}`
        : undefined;
      const inputFiles = loadSubagentInputFiles(parent.cwd, request.inputFiles ?? []);
      const promptPlan = buildSubagentPromptPlan({
        profileSystemPrompt: profile.systemPrompt,
        tools: profile.tools,
        loadSkills: profile.loadSkills,
        loadExtensions: profile.loadExtensions,
        task: appendSubagentInputFiles(request.task, inputFiles),
        inheritedParentContext,
      });
      const { chatOnly, appendSystemPrompt, delegatedTask } = promptPlan;
      if (!chatOnly) initTheme();
      const services = await createAgentSessionServices({
        cwd: parent.cwd,
        agentDir,
        modelRuntime: parentModelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          noExtensions: !profile.loadExtensions,
          noSkills: !profile.loadSkills,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          ...(chatOnly
            ? {
                systemPrompt: " ",
                systemPromptOverride: () => undefined,
              }
            : {}),
          appendSystemPrompt,
        },
        ...((profile.loadExtensions || profile.loadSkills)
          ? { resourceLoaderReloadOptions: projectTrustReloadOptions(parent.cwd, agentDir) }
          : {}),
      });

      // Unified resolution pipeline: delegate tool/extension resolution to
      // the pipeline types defined in subagent-dispatch.ts.  The runtime
      // provides the resource loader context; the dispatch module defines
      // the typed intermediate plan.
      const allExtensions = profile.loadExtensions
        ? services.resourceLoader.getExtensions().extensions
        : [];
      const pipelinePlan = resolveSubagentResources({
        dispatchTools: request.tools,
        dispatchDisallowedTools: request.disallowedTools,
        dispatchExtensions: request.extensions,
        dispatchDenyExtensions: request.denyExtensions,
        dispatchExcludeTools: request.excludeTools,
        dispatchEphemeral: request.ephemeral,
        dispatchModel: request.model,
        dispatchThinking: request.thinking,
        profileTools: profile.tools,
        profileExtensions: profile.extensions,
        profileDenyExtensions: profile.denyExtensions,
        parentModel: undefined, // resolved below via parseSubagentModel
        parentThinking: thinking ?? null,
      });
      // G3: filter extensions using the pipeline's effective allow/deny lists.
      // The pipeline resolves which lists apply; the runtime applies them
      // against the resource loader's loaded extensions via filterExtensionsBySource.
      const filteredExtensions = filterExtensionsBySource(allExtensions, {
        allow: pipelinePlan.effectiveExtensions,
        deny: pipelinePlan.effectiveDenyExtensions,
      });
      const extensionToolNames = filteredExtensions.flatMap((extension) => [...extension.tools.keys()]);
      // G2: merge base tools with extension names, then apply shell-specific
      // defaults.  The pipeline resolved the base; the runtime applies the
      // shell-specific layer.
      const baseTools = pipelinePlan.effectiveTools.length > 0
        ? pipelinePlan.effectiveTools
        : profile.tools;
      let activeTools = resolveShellTools(
        withSubagentExtensionTools(baseTools, extensionToolNames),
        settingsManager.getDefaultTools(),
      );
      // G2: disallowedTools takes precedence — subtract after merge.
      if (request.disallowedTools) {
        const disallowed = new Set(request.disallowedTools);
        activeTools = activeTools.filter((tool) => !disallowed.has(tool));
      }

      // G6: ephemeral sessions use an in-memory SessionManager so no .jsonl
      // is written to disk.  Non-ephemeral sessions use the standard
      // create() path which persists to ~/.pi/agent/sessions/.
      const ephemeral = request.ephemeral ?? false;
      const sessionManager = ephemeral
        ? SessionManager.inMemory(parent.cwd, { parentSession: parent.sessionFile })
        : SessionManager.create(parent.cwd, undefined, { parentSession: parent.sessionFile });
      const createdAt = new Date().toISOString();
      const metadata: SubagentMetadata = {
        version: 1,
        parentSessionId,
        parentSessionPath: parent.sessionFile,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: request.description.trim() || profile.displayName,
        task: request.task,
        runInBackground,
        createdAt,
        resourceSnapshot: {
          version: 1,
          appendSystemPrompt: [...appendSystemPrompt],
          tools: [...activeTools],
          loadSkills: profile.loadSkills,
          loadExtensions: profile.loadExtensions,
          // G4: surface authoritative effective values in the audit trail.
          model: effectiveModel,
          thinking: thinking ?? null,
        },
      };
      // G6: for ephemeral sessions, write the audit metadata to the parent
      // session's custom entries so the dispatch metadata is not lost when
      // the in-memory session vanishes.  Non-ephemeral sessions write to
      // their own session file as before.
      if (ephemeral) {
        parent.inner.sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, metadata);
      } else {
        sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, metadata);
        sessionManager.appendSessionInfo(metadata.description);
      }

      const { session: inner } = await createAgentSessionFromServices({
        services,
        sessionManager,
        model: resolvedModel,
        ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
        tools: activeTools,
        // G3: reserved control names stay unconditionally excluded (re-dispatch
        // guard); caller-supplied excludeTools are appended.
        excludeTools: [...SUBAGENT_CONTROL_TOOL_NAMES, ...(request.excludeTools ?? [])],
      });
      dependencies.registerSession(inner, {
        ...(promptPlan.exactSystemPrompt !== undefined
          ? { exactSystemPrompt: promptPlan.exactSystemPrompt }
          : {}),
        chatOnly,
      });

      const initialRun: SubagentRunInfo = {
        sessionId: inner.sessionId,
        sessionPath: inner.sessionFile ?? sessionManager.getSessionFile() ?? "",
        parentSessionId,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: metadata.description,
        task: request.task,
        runInBackground,
        status: "running",
        createdAt,
        // G4: surface authoritative effective values from the three-level fallback
        // resolution — these are the values the runtime actually used, not an echo
        // of the dispatch input parameters.
        model: effectiveModel,
        thinking: thinking ?? null,
      };

      let turnCount = 0;
      let maxTurnsReached = false;
      let softLimitReached = false;
      const unsubscribeTurns = turnLimit
        ? inner.subscribe((event) => {
            if (event.type !== "turn_end") return;
            turnCount += 1;
            if (!softLimitReached && turnCount >= turnLimit) {
              softLimitReached = true;
              void inner.steer("You have reached your turn limit. Wrap up immediately and provide your final answer now.");
            } else if (softLimitReached && turnCount >= turnLimit + 1) {
              maxTurnsReached = true;
              void inner.abort();
            }
          })
        : () => {};
      const stored: StoredSubagentExecution = {
        run: initialRun,
        completion: Promise.resolve(initialRun),
        abortRequested: false,
      };
      getSubagentRuns().set(initialRun.sessionId, stored);
      request.onUpdate?.(initialRun);
      dependencies.invalidateSessionList();

      const handleParentAbort = () => {
        stored.abortRequested = true;
        void inner.abort();
      };
      if (!runInBackground) request.signal?.addEventListener("abort", handleParentAbort, { once: true });

      stored.completion = (async () => {
        let result: SubagentRunInfo;
        try {
          await inner.prompt(delegatedTask, {
            source: "rpc",
            ...(chatOnly
              ? {
                  preflightResult: (success: boolean) => {
                    if (success && inner.agent.state) {
                      inner.agent.state.systemPrompt = profile.systemPrompt;
                    }
                  },
                }
              : {}),
          });
          const text = inner.getLastAssistantText()?.trim();
          const aborted = stored.abortRequested && !maxTurnsReached;
          result = {
            ...initialRun,
            status: aborted ? "aborted" : "completed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
          };
        } catch (error) {
          const text = inner.getLastAssistantText()?.trim();
          const aborted = stored.abortRequested || request.signal?.aborted;
          result = {
            ...initialRun,
            status: aborted ? "aborted" : maxTurnsReached ? "completed" : "failed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(!aborted && !maxTurnsReached
              ? { error: error instanceof Error ? error.message : String(error) }
              : {}),
          };
        } finally {
          unsubscribeTurns();
          request.signal?.removeEventListener("abort", handleParentAbort);
        }

        const persisted: SubagentResultMetadata = {
          version: 1,
          status: result.status as SubagentResultMetadata["status"],
          completedAt: result.completedAt!,
          ...(result.result ? { result: result.result } : {}),
          ...(result.error ? { error: result.error } : {}),
        };
        // G6: ephemeral sessions write result metadata to the parent session
        // so the dispatch result is not lost when the in-memory session vanishes.
        if (ephemeral) {
          parent.inner.sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, persisted);
        } else {
          sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, persisted);
        }
        stored.run = result;
        request.onUpdate?.(result);
        getSubagentRuns().delete(initialRun.sessionId);
        dependencies.invalidateSessionList();
        return result;
      })();

      return { run: initialRun, completion: stored.completion };
    } finally {
      releaseSlot();
    }
  }

  async function get(sessionId: string): Promise<SubagentRunInfo | null> {
    const stored = getSubagentRuns().get(sessionId);
    if (stored) return stored.run;
    const wrapper = dependencies.getSession(sessionId);
    if (wrapper?.isAlive()) {
      const run = readSubagentRun(
        wrapper.inner.sessionManager.getEntries() as unknown as SessionEntry[],
        sessionId,
        wrapper.sessionFile,
      );
      if (run && wrapper.isRunning()) return { ...run, status: "running" };
      if (run) return run;
    }
    const sessionPath = await dependencies.resolveSessionPath(sessionId);
    if (!sessionPath) return null;
    const manager = SessionManager.open(sessionPath);
    return readSubagentRun(manager.getEntries() as unknown as SessionEntry[], sessionId, sessionPath);
  }

  async function steer(sessionId: string, message: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (!message.trim()) throw new Error("Steering message is required");
    await wrapper.inner.steer(message.trim());
  }

  async function notifyParent(run: SubagentRunInfo): Promise<void> {
    let parent = dependencies.getSession(run.parentSessionId);
    if (!parent?.isAlive()) {
      const sessionFile = await dependencies.resolveSessionPath(run.parentSessionId);
      if (!sessionFile) throw new Error(`Parent session not found: ${run.parentSessionId}`);
      parent = await dependencies.reopenSession(run.parentSessionId, sessionFile);
    }
    await parent.waitUntilReady();
    if (!parent.isAlive()) throw new Error(`Parent session is no longer available: ${run.parentSessionId}`);
    await parent.inner.sendCustomMessage({
      customType: "pi-web:subagent-notification",
      content: subagentFinalText(run),
      display: true,
      details: subagentToolDetails(run),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  async function abort(sessionId: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    const stored = getSubagentRuns().get(sessionId);
    if (stored) stored.abortRequested = true;
    await wrapper.inner.abort();
  }

  return {
    extensionRuntime: { start, get, steer, notifyParent },
    get,
    steer,
    abort,
  };
}
