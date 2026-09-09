import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const { createSubagentController } = await createJiti(import.meta.url).import("./subagent-runtime.ts");

function completedRun() {
  return {
    sessionId: "child-session",
    sessionPath: "/tmp/child.jsonl",
    parentSessionId: "parent-session",
    parentToolCallId: "tool-call",
    profile: "Explore",
    description: "Inspect parser",
    task: "Find the parser",
    runInBackground: true,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: "Parser found",
  };
}

test("completion notification reopens an idle parent and uses its current session", async () => {
  const delivered = [];
  const reopened = [];
  let ready = false;
  let parent;
  const liveParent = {
    cwd: "/tmp",
    sessionFile: "/tmp/parent.jsonl",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => { ready = true; },
    inner: {
      sendCustomMessage: async (message, options) => delivered.push({ message, options }),
    },
  };
  const controller = createSubagentController({
    getSession: () => parent,
    registerSession: () => {},
    reopenSession: async (sessionId, sessionFile) => {
      reopened.push([sessionId, sessionFile]);
      parent = liveParent;
      return liveParent;
    },
    resolveSessionPath: async () => "/tmp/parent.jsonl",
    invalidateSessionList: () => {},
  });

  await controller.extensionRuntime.notifyParent(completedRun());

  assert.deepEqual(reopened, [["parent-session", "/tmp/parent.jsonl"]]);
  assert.equal(ready, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message.content, "Parser found");
  assert.equal(delivered[0].message.details.sessionId, "child-session");
  assert.deepEqual(delivered[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("disabled built-in subagents reject stale Agent calls before starting", async () => {
  const controller = createSubagentController({
    getSession: () => { throw new Error("must not inspect a parent"); },
    registerSession: () => {},
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => false,
  });

  await assert.rejects(
    controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent" } },
      parentToolCallId: "call",
      profile: "explore",
      task: "Inspect",
      description: "Inspect",
    }),
    /built-in sub-agents are disabled/,
  );
});

// ---------------------------------------------------------------------------
// G4 — Effective model/thinking surfaced in SubagentRunInfo and resourceSnapshot
// ---------------------------------------------------------------------------

test("G4: runtime resolves model via three-level fallback before resourceSnapshot", async () => {
  const source = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");

  // The three-level fallback chain for model: request.model ?? profile.model
  // resolved through parseSubagentModel, falling back to parent.inner.model.
  assert.match(source, /parseSubagentModel\(parentModelRuntime, request\.model \?\? profile\.model\)/);
  assert.match(source, /parent\.inner\.model as ReturnType<ModelRuntime\["getModel"\]>/);

  // The three-level fallback chain for thinking: request → profile → parent state.
  assert.match(source, /request\.thinking \?\? profile\.thinking \?\? parent\.inner\.agent\.state\?\.thinkingLevel/);

  // Authoritative resolvedModel is surfaced into resourceSnapshot.
  assert.match(source, /model: effectiveModel/);
  assert.match(source, /thinking: thinking \?\? null/);

  // The resourceSnapshot block must contain model and thinking assignments.
  const snapshotStart = source.indexOf("resourceSnapshot:");
  const snapshotBlock = source.slice(snapshotStart, source.indexOf("};", snapshotStart) + 2);
  assert.match(snapshotBlock, /model: effectiveModel/);
  assert.match(snapshotBlock, /thinking: thinking \?\? null/);
});

test("G4: runtime puts effective model/thinking into initialRun lifecycle event", async () => {
  const source = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");

  // The initialRun object must carry model and thinking from the resolved values.
  const runStart = source.indexOf("const initialRun: SubagentRunInfo");
  const runBlock = source.slice(runStart, source.indexOf("};", runStart) + 2);
  assert.match(runBlock, /model: effectiveModel/);
  assert.match(runBlock, /thinking: thinking \?\? null/);
});

test("G4: dispatch module reads authoritative values from the run, not transitional fallback", async () => {
  const source = await readFile(new URL("./subagent-dispatch.ts", import.meta.url), "utf8");

  // After B4 the settle() function must read model/thinking directly from
  // the run object without falling back to params or parentState.
  assert.match(source, /effectiveModel: runExtra\.model \?\? ""/);
  assert.match(source, /effectiveThinking: runExtra\.thinking \?\? null/);

  // The old transitional fallback (params.model ?? parentState.model) must
  // have been removed.
  assert.doesNotMatch(source, /params\.model \?\? parentState\.model/);
  assert.doesNotMatch(source, /params\.thinking \?\? parentState\.thinking/);
});


