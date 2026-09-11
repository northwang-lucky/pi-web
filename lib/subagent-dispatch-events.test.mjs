import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const { createDispatchRuntime } = await jiti.import("./subagent-dispatch.ts");

// ---------------------------------------------------------------------------
// Fake dependency factories — same convention as subagent-dispatch.test.mjs
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

        // Three-level fallback: dispatch param → profile → parent session state.
        const parentState = request._getParentState?.() ?? {};
        const effectiveModel =
          request.model ?? profile.model ?? parentState.model ?? "zenmux/default";
        const effectiveThinking =
          request.thinking ?? profile.thinking ?? parentState.thinking ?? null;

        // Tool resolution: per-dispatch allowlist (or profile defaults), merged
        // with extension tool names, minus disallowedTools, minus the reserved
        // control-tool base set, minus any caller-supplied excludeTools.
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
          activeTools: effectiveTools,
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
// P1: default profile resolves to "general-purpose", not "default"
// ---------------------------------------------------------------------------

test("P1: default profile resolves to general-purpose when params.profile is omitted", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Default profile task",
    description: "Default profile",
    runInBackground: true,
  });

  // The request sent to the controller must carry "general-purpose", not "default".
  assert.equal(controller._calls.start[0].profile, "general-purpose");

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Done");
  await handle.completion;
});

test("P1: explicit profile is forwarded unchanged", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Explore task",
    description: "Explore",
    profile: "explore",
    runInBackground: true,
  });

  assert.equal(controller._calls.start[0].profile, "explore");

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Done");
  await handle.completion;
});

// ---------------------------------------------------------------------------
// P1: started event fires before terminal and carries effective values
// ---------------------------------------------------------------------------

test("P1: started event fires before completed and carries effective values", async () => {
  const controller = createFakeController({ profile: { model: "zenmux/profile-m" } });
  const runtime = createTestRuntime({ controller });
  const events = [];

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Lifecycle test",
    description: "Lifecycle",
    model: "zenmux/explicit-m",
    thinking: "high",
    runInBackground: true,
    onUpdate: (e) => events.push(e),
  });

  // started must have fired synchronously during startSubagentDispatch.
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, "started");
  assert.equal(events[0].effectiveModel, "zenmux/explicit-m");
  assert.equal(events[0].effectiveThinking, "high");
  assert.equal(typeof events[0].childSessionId, "string");

  // Resolve the child; completed event must follow.
  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Final answer");

  const event = await handle.completion;
  assert.equal(event.phase, "completed");
  assert.equal(events.length, 2);
  assert.equal(events[1].phase, "completed");
  assert.equal(events[1].result, "Final answer");
  assert.equal(events[1].effectiveModel, "zenmux/explicit-m");
});

// ---------------------------------------------------------------------------
// P1: started event carries profile-fallback values, not input echoes
// ---------------------------------------------------------------------------

test("P1: started event carries profile-fallback effective model/thinking, not input params", async () => {
  // Profile provides model and thinking; dispatch params omit both.
  // The started event must carry the profile values — not the parent session's
  // values and not a re-echo of absent input parameters.
  const controller = createFakeController({
    profile: { model: "zenmux/profile-m", thinking: "medium" },
  });
  const runtime = createTestRuntime({
    controller,
    parentState: { model: "zenmux/parent-model", thinking: "low" },
  });
  const events = [];

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Profile fallback task",
    description: "Profile fallback",
    // No model or thinking — must fall back to profile.
    runInBackground: true,
    onUpdate: (e) => events.push(e),
  });

  // started must have fired with profile values, not parent values.
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, "started");
  assert.equal(events[0].effectiveModel, "zenmux/profile-m",
    "started must carry profile model, not parent session model");
  assert.equal(events[0].effectiveThinking, "medium",
    "started must carry profile thinking, not parent session thinking");

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Done");
  await handle.completion;
});

// ---------------------------------------------------------------------------
// P1: onUpdate exceptions never break dispatch completion
// ---------------------------------------------------------------------------

test("P1: onUpdate throwing in started phase does not break dispatch", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });
  let terminalEvents = [];

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Throw test",
    description: "Throw",
    runInBackground: true,
    onUpdate: (e) => {
      if (e.phase === "started") throw new Error("subscriber boom");
      terminalEvents.push(e);
    },
  });

  // The started event was attempted (exception swallowed).
  assert.equal(typeof handle.dispatchId, "string");

  // Complete the child — must still resolve without error.
  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Survived");

  const event = await handle.completion;
  assert.equal(event.phase, "completed");
  assert.equal(event.result, "Survived");
  // The completed event must still reach the subscriber.
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].phase, "completed");
});

test("P1: onUpdate throwing in completed phase does not break completion promise", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Throw in terminal",
    description: "Throw terminal",
    runInBackground: true,
    onUpdate: () => { throw new Error("terminal boom"); },
  });

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Result");

  // Must resolve without throwing.
  const event = await handle.completion;
  assert.equal(event.phase, "completed");
  assert.equal(event.result, "Result");
});

// ---------------------------------------------------------------------------
// P2: AbortSignal listener is removed after settle
// ---------------------------------------------------------------------------

test("P2: AbortSignal handler is detached after settle (abort after settle is harmless)", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });
  const ac = new AbortController();

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Signal leak test",
    description: "Signal leak",
    signal: ac.signal,
    runInBackground: true,
  });

  // Complete the child — settle detaches the listener.
  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Done");

  const event = await handle.completion;
  assert.equal(event.phase, "completed");

  // Abort the signal AFTER settle — the detached listener must prevent it from
  // reaching the controller, and the settled event must not change phase.
  ac.abort();
  assert.equal(controller._calls.abort.length, 0,
    "abort after settle must not reach the controller (listener detached)");
  const finalEvent = await handle.completion;
  assert.equal(finalEvent.phase, "completed",
    "signal abort after settle must not change the terminal phase");
});

test("P2: AbortSignal listener removed when start() throws", async () => {
  let abortCount = 0;
  const failingController = {
    extensionRuntime: {
      start: async () => { throw new Error("controller unavailable"); },
    },
    steer: async () => {},
    abort: async () => { abortCount++; },
  };
  const runtime = createDispatchRuntime({
    getController: () => failingController,
    readSettings: () => ({}),
    getParentState: () => ({}),
  });
  const ac = new AbortController();

  await assert.rejects(
    runtime.startSubagentDispatch("parent-session", {
      task: "Failing start",
      description: "Failing",
      signal: ac.signal,
      runInBackground: true,
    }),
    /controller unavailable/,
  );

  // Abort after the failed start must be harmless — the detached listener
  // prevents the signal from reaching the controller's abort method.
  ac.abort();
  assert.equal(abortCount, 0,
    "abort after failed start must not reach the controller");
});

// ---------------------------------------------------------------------------
// P2: effectiveTools reads activeTools from the run, not tools
// ---------------------------------------------------------------------------

test("P2: effectiveTools on events reads activeTools from the run object", async () => {
  const controller = createFakeController({
    extensionToolNames: ["lsp_diagnostics"],
  });
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Tools test",
    description: "Tools",
    tools: ["read", "lsp_diagnostics"],
    runInBackground: true,
  });

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Done");

  const event = await handle.completion;
  assert.ok(Array.isArray(event.effectiveTools), "effectiveTools must be an array");
  assert.ok(event.effectiveTools.includes("lsp_diagnostics"),
    "effectiveTools must contain extension tools from activeTools");
  assert.ok(event.effectiveTools.includes("read"),
    "effectiveTools must contain built-in tools from activeTools");
});
