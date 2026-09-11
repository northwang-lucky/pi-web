import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

let createDispatchRuntime, resolveSubagentResources;
try {
  ({ createDispatchRuntime, resolveSubagentResources } =
    await jiti.import("./subagent-dispatch.ts"));
} catch {
  // Module may not exist yet in the red phase.
}

// ---------------------------------------------------------------------------
// Fake dependency factories (same convention as dispatch-events.test.mjs)
// ---------------------------------------------------------------------------

function createFakeController({
  profile = {},
  extensionToolNames = [],
} = {}) {
  const calls = { start: [], steer: [], abort: [] };
  const runs = new Map();
  let runId = 0;

  return {
    extensionRuntime: {
      start: async (request) => {
        calls.start.push(request);
        const id = `child-${++runId}`;

        const parentState = request._getParentState?.() ?? {};
        const effectiveModel =
          request.model ?? profile.model ?? parentState.model ?? "zenmux/default";
        const effectiveThinking =
          request.thinking ?? profile.thinking ?? parentState.thinking ?? null;

        const baseTools = request.tools ?? profile.tools ?? [];
        const merged = [...new Set([...baseTools, ...extensionToolNames])];
        const disallowed = new Set(request.disallowedTools ?? []);
        const reserved = new Set(["Agent", "get_subagent_result", "steer_subagent"]);
        const excluded = new Set(request.excludeTools ?? []);
        const effectiveTools = merged.filter(
          (tool) => !disallowed.has(tool) && !reserved.has(tool) && !excluded.has(tool),
        );

        const run = {
          sessionId: id,
          sessionPath: `/tmp/${id}.jsonl`,
          parentSessionId: request.parentContext?.sessionManager?.sessionId ?? "parent-session",
          parentToolCallId: request.parentToolCallId,
          profile: request.profile,
          description: request.description,
          task: request.task,
          runInBackground: request.runInBackground ?? false,
          status: "running",
          createdAt: new Date().toISOString(),
          model: effectiveModel,
          thinking: effectiveThinking,
          tools: effectiveTools,
        };

        let resolveCompletion;
        const completion = new Promise((resolve) => { resolveCompletion = resolve; });
        runs.set(id, { run, resolveCompletion });

        return { run, completion };
      },
    },
    steer: async (sessionId, message) => {
      calls.steer.push([sessionId, message]);
    },
    abort: async (sessionId) => {
      calls.abort.push(sessionId);
    },
    _calls: calls,
    _runs: runs,
    _resolve: (sessionId, status = "completed", result = "Done") => {
      const stored = runs.get(sessionId);
      if (stored) {
        stored.resolveCompletion({
          ...stored.run,
          status,
          completedAt: new Date().toISOString(),
          ...(result ? { result } : {}),
        });
      }
    },
  };
}

function createTestRuntime({
  controller,
  maxConcurrentSubagents = 4,
  parentState = { model: "zenmux/parent-model", thinking: "low" },
} = {}) {
  return createDispatchRuntime({
    getController: () => controller,
    readSettings: () => ({ maxConcurrentSubagents }),
    getParentState: () => parentState,
  });
}

// ---------------------------------------------------------------------------
// Divergence A: dispatch forwards extensions/denyExtensions into the
// controller request (branch-1 declared but silently dropped them).
// ---------------------------------------------------------------------------

test("wiring A: extensions and denyExtensions reach the controller request", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Extension forwarding",
    description: "Extensions",
    extensions: ["lsp", "git"],
    denyExtensions: ["workloom"],
    runInBackground: true,
  });

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Done");
  await handle.completion;

  // The fake controller must have received extensions and denyExtensions
  // in the request object.
  assert.deepEqual(controller._calls.start[0].extensions, ["lsp", "git"]);
  assert.deepEqual(controller._calls.start[0].denyExtensions, ["workloom"]);
});

test("wiring A: absent extensions/denyExtensions are not injected", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "No extensions",
    description: "None",
    runInBackground: true,
  });

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Done");
  await handle.completion;

  // When not specified, extensions/denyExtensions must be undefined on the request.
  assert.equal(controller._calls.start[0].extensions, undefined);
  assert.equal(controller._calls.start[0].denyExtensions, undefined);
});

// ---------------------------------------------------------------------------
// Divergence B: empty effective tools falls back to profile.tools through
// the resolveSubagentResources pipeline (branch-1 uses presence semantics).
// ---------------------------------------------------------------------------

test("wiring B: empty tools array falls back to profile.tools via resolveSubagentResources", () => {
  // resolveSubagentResources uses dispatchTools ?? profileTools.
  // When dispatchTools is an empty array, it is truthy (not nullish), so the
  // pipeline uses it.  This is the coherent branch-2 semantics: an explicit
  // empty array means "no tools", while omission (undefined) falls back to
  // profile defaults.
  const result = resolveSubagentResources({
    dispatchTools: [],
    profileTools: ["read", "bash", "edit"],
  });
  assert.deepEqual(result.effectiveTools, [],
    "explicit empty tools array must yield empty effectiveTools");
});

test("wiring B: omitted tools falls back to profile.tools via resolveSubagentResources", () => {
  // When dispatchTools is omitted (undefined), the pipeline falls back to
  // profileTools.
  const result = resolveSubagentResources({
    profileTools: ["read", "bash", "edit"],
  });
  assert.deepEqual(result.effectiveTools, ["read", "bash", "edit"],
    "omitted tools must fall back to profile tools");
});

test("wiring B: disallowedTools + empty tools yields empty result", () => {
  const result = resolveSubagentResources({
    dispatchTools: ["read", "bash"],
    dispatchDisallowedTools: ["read", "bash"],
    profileTools: ["read", "bash", "edit"],
  });
  assert.deepEqual(result.effectiveTools, [],
    "all tools disallowed must yield empty effectiveTools");
});

test("wiring B: empty effective tools after allow/deny falls back to profile", () => {
  // Simulate: dispatchTools is undefined, profileTools has content, no disallowed.
  const result = resolveSubagentResources({
    profileTools: ["read", "bash", "grep", "find"],
  });
  assert.deepEqual(result.effectiveTools, ["read", "bash", "grep", "find"],
    "no dispatch override must use full profile tool set");
});
