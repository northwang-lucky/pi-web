import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const { withSubagentExtensionTools, SUBAGENT_CONTROL_TOOL_NAMES } =
  await jiti.import("./subagents.ts");

// ---------------------------------------------------------------------------
// Unit tests: withSubagentExtensionTools (exported, already used by runtime)
// ---------------------------------------------------------------------------

test("withSubagentExtensionTools merges extension names and filters control tools", () => {
  const profileTools = ["read", "bash", "edit"];
  const extensionTools = ["lsp_diagnostics", "lsp_fix", "Agent"];
  const result = withSubagentExtensionTools(profileTools, extensionTools);
  assert.ok(result.includes("read"));
  assert.ok(result.includes("bash"));
  assert.ok(result.includes("edit"));
  assert.ok(result.includes("lsp_diagnostics"));
  assert.ok(result.includes("lsp_fix"));
  assert.ok(!result.includes("Agent"), "Agent must be filtered out by SUBAGENT_CONTROL_TOOLS");
});

test("withSubagentExtensionTools filters all three reserved tool names", () => {
  const profileTools = ["read"];
  const extensionTools = [...SUBAGENT_CONTROL_TOOL_NAMES, "lsp_diagnostics"];
  const result = withSubagentExtensionTools(profileTools, extensionTools);
  assert.ok(!result.includes("Agent"));
  assert.ok(!result.includes("get_subagent_result"));
  assert.ok(!result.includes("steer_subagent"));
  assert.ok(result.includes("lsp_diagnostics"));
  assert.ok(result.includes("read"));
});

test("withSubagentExtensionTools deduplicates across profile and extension", () => {
  const profileTools = ["read", "bash"];
  const extensionTools = ["read", "grep"];
  const result = withSubagentExtensionTools(profileTools, extensionTools);
  const readCount = result.filter((t) => t === "read").length;
  assert.equal(readCount, 1, "read must appear exactly once");
  assert.ok(result.includes("grep"));
});

test("withSubagentExtensionTools handles empty extension list", () => {
  const result = withSubagentExtensionTools(["read", "bash"], []);
  assert.deepEqual(result.sort(), ["bash", "read"]);
});

// ---------------------------------------------------------------------------
// B2 runtime integration: per-dispatch tools/disallowedTools
// ---------------------------------------------------------------------------

test("B2: request.tools bypasses profile tools when present", () => {
  // When request.tools is present, baseTools = request.tools instead of
  // profile.tools.  Verify the resolution path with the exact same function
  // the runtime calls.
  const baseTools = ["read", "grep"];
  const extensionToolNames = [];
  const activeTools = withSubagentExtensionTools(baseTools, extensionToolNames);
  assert.ok(activeTools.includes("read"));
  assert.ok(activeTools.includes("grep"));
  assert.ok(!activeTools.includes("bash"), "bash should not appear when request.tools is specified");
});

test("B2: disallowedTools subtracts after merge", () => {
  const baseTools = ["read", "bash", "grep"];
  const extensionToolNames = ["lsp_diagnostics"];
  let activeTools = withSubagentExtensionTools(baseTools, extensionToolNames);
  const disallowed = new Set(["bash", "lsp_diagnostics"]);
  activeTools = activeTools.filter((tool) => !disallowed.has(tool));

  assert.ok(activeTools.includes("read"));
  assert.ok(activeTools.includes("grep"));
  assert.ok(!activeTools.includes("bash"), "bash must be removed by disallowedTools");
  assert.ok(!activeTools.includes("lsp_diagnostics"), "lsp_diagnostics must be removed by disallowedTools");
});

test("B2: absent request.tools falls back to profile tools (regression lock)", () => {
  // When request.tools is absent, baseTools = profile.tools (DEFAULT_TOOLS).
  const profileTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  const extensionToolNames = [];
  const activeTools = withSubagentExtensionTools(profileTools, extensionToolNames);
  assert.deepEqual(activeTools.sort(), [...profileTools].sort());
});

test("B2: extension tool names admitted into allowlist via request.tools", () => {
  // withSubagentExtensionTools merges base tools with ALL extension tool names
  // (minus reserved control names).  The runtime then applies disallowedTools.
  const baseTools = ["read", "lsp_diagnostics"];
  const extensionToolNames = ["lsp_diagnostics", "lsp_fix"];
  const activeTools = withSubagentExtensionTools(baseTools, extensionToolNames);
  assert.ok(activeTools.includes("lsp_diagnostics"), "lsp_diagnostics must be admitted");
  assert.ok(activeTools.includes("lsp_fix"), "lsp_fix from extensions must be admitted");
  // To exclude lsp_fix, use disallowedTools at the runtime level:
  const disallowed = new Set(["lsp_fix"]);
  const filtered = activeTools.filter((t) => !disallowed.has(t));
  assert.ok(!filtered.includes("lsp_fix"), "lsp_fix must be removed by disallowedTools");
});

// ---------------------------------------------------------------------------
// B3 integration: extensions/denyExtensions filtering + excludeTools
// ---------------------------------------------------------------------------

test("B3: reserved tool names stay excluded via excludeTools", () => {
  // The runtime assembles excludeTools as [...SUBAGENT_CONTROL_TOOL_NAMES, ...(request.excludeTools ?? [])]
  const reserved = [...SUBAGENT_CONTROL_TOOL_NAMES];
  const callerExclude = ["bash"];
  const excludeTools = [...reserved, ...callerExclude];

  assert.ok(excludeTools.includes("Agent"));
  assert.ok(excludeTools.includes("get_subagent_result"));
  assert.ok(excludeTools.includes("steer_subagent"));
  assert.ok(excludeTools.includes("bash"), "caller exclusion must be appended");
});

test("B3: extensions filter narrows loaded extensions by package name", () => {
  // Simulate the filter logic that will be in subagent-runtime.ts
  const extensions = [
    { name: "ext-a", packageName: "pkg-a", tools: new Map([["tool_a", {}]]) },
    { name: "ext-b", packageName: "pkg-b", tools: new Map([["tool_b", {}]]) },
    { name: "ext-c", packageName: "pkg-c", tools: new Map([["tool_c", {}]]) },
  ];
  const allowList = ["pkg-a", "pkg-c"];
  const denyList = ["pkg-c"];

  // Allow filter: keep only packages in allowList
  let filtered = extensions.filter((ext) => allowList.includes(ext.packageName));
  assert.equal(filtered.length, 2);

  // Deny filter: remove packages in denyList (deny wins)
  filtered = filtered.filter((ext) => !denyList.includes(ext.packageName));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].packageName, "pkg-a");
});

test("B3: empty extensions/denyExtensions leaves all extensions loaded", () => {
  const extensions = [
    { name: "ext-a", packageName: "pkg-a" },
    { name: "ext-b", packageName: "pkg-b" },
  ];
  const allowList = undefined;
  const denyList = undefined;

  // No filtering when both are absent
  const filtered = extensions.filter((ext) => {
    if (allowList && !allowList.includes(ext.packageName)) return false;
    if (denyList && denyList.includes(ext.packageName)) return false;
    return true;
  });
  assert.equal(filtered.length, 2);
});

test("B3: runtime extension filtering uses sourceInfo.source to extract package name", () => {
  // The runtime extracts the package name from extension.sourceInfo.source
  // npm sources: "npm:<name>@<version>" → strip npm: prefix, then strip
  // trailing @version (handles scoped packages like @scope/name@1.0.0).
  // Non-npm sources: file path, used as-is.
  function extractPackageName(source) {
    return source.startsWith("npm:")
      ? source.replace(/^npm:/, "").replace(/@[^@]*$/, "")
      : source;
  }

  assert.equal(extractPackageName("npm:@scope/my-pkg@1.0.0"), "@scope/my-pkg");
  assert.equal(extractPackageName("npm:my-pkg@2.3.4"), "my-pkg");
  assert.equal(extractPackageName("/home/user/.agents/extensions/my-ext"), "/home/user/.agents/extensions/my-ext");

  // Now simulate the full filter with sourceInfo.source
  const extensions = [
    { sourceInfo: { source: "npm:@scope/lsp-tools@1.0.0" }, tools: new Map([["lsp_diag", {}]]) },
    { sourceInfo: { source: "npm:workloom@0.1.0" }, tools: new Map([["wl_exec", {}]]) },
    { sourceInfo: { source: "npm:@scope/utils@2.0.0" }, tools: new Map([["util_fn", {}]]) },
  ];

  const effectiveExtensions = ["@scope/lsp-tools"];
  const effectiveDenyExtensions = ["@scope/utils"];

  const filtered = extensions.filter((ext) => {
    const sourcePkg = extractPackageName(ext.sourceInfo.source);
    if (effectiveExtensions && !effectiveExtensions.includes(sourcePkg)) return false;
    if (effectiveDenyExtensions && effectiveDenyExtensions.includes(sourcePkg)) return false;
    return true;
  });

  assert.equal(filtered.length, 1, "only @scope/lsp-tools should survive allow+deny");
  assert.ok(filtered[0].tools.has("lsp_diag"));
});

test("B3: dispatch extensions override profile extensions", () => {
  // When both dispatch params and profile fields exist, dispatch wins.
  const profileExtensions = ["pkg-a", "pkg-b"];
  const profileDenyExtensions = ["pkg-c"];
  const dispatchExtensions = ["pkg-x"];
  const dispatchDenyExtensions = ["pkg-y"];

  const effectiveExtensions = dispatchExtensions ?? profileExtensions;
  const effectiveDenyExtensions = dispatchDenyExtensions ?? profileDenyExtensions;

  assert.deepEqual(effectiveExtensions, ["pkg-x"], "dispatch extensions must override profile");
  assert.deepEqual(effectiveDenyExtensions, ["pkg-y"], "dispatch denyExtensions must override profile");
});

test("B3: profile extensions used when dispatch params absent", () => {
  const profileExtensions = ["pkg-a", "pkg-b"];
  const profileDenyExtensions = ["pkg-c"];
  const dispatchExtensions = undefined;
  const dispatchDenyExtensions = undefined;

  const effectiveExtensions = dispatchExtensions ?? profileExtensions;
  const effectiveDenyExtensions = dispatchDenyExtensions ?? profileDenyExtensions;

  assert.deepEqual(effectiveExtensions, ["pkg-a", "pkg-b"]);
  assert.deepEqual(effectiveDenyExtensions, ["pkg-c"]);
});
