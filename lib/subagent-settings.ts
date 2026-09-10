import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubagentSettings {
  builtInEnabled: boolean;
  /** G5: configurable concurrency cap per parent session. */
  maxConcurrentSubagents: number;
}

type StoredSubagentSettings = Record<string, unknown> & {
  version?: unknown;
  builtInEnabled?: unknown;
  maxConcurrentSubagents?: unknown;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 4;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getSubagentSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "agents", "settings.json");
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

function readStoredSettings(settingsPath: string): StoredSubagentSettings {
  if (!existsSync(settingsPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid subagent settings: expected an object");
  }
  return parsed as StoredSubagentSettings;
}

/** Validate and floor the raw concurrency value; return default when absent or invalid. */
function sanitizeMaxConcurrent(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_MAX_CONCURRENT_SUBAGENTS;
}

export function readSubagentSettings(
  settingsPath = getSubagentSettingsPath(),
): SubagentSettings {
  const stored = readStoredSettings(settingsPath);
  return {
    builtInEnabled: stored.builtInEnabled === true,
    maxConcurrentSubagents: sanitizeMaxConcurrent(stored.maxConcurrentSubagents),
  };
}

export function isBuiltInSubagentsEnabled(
  settingsPath = getSubagentSettingsPath(),
): boolean {
  try {
    return readSubagentSettings(settingsPath).builtInEnabled;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

export function writeBuiltInSubagentsEnabled(
  enabled: boolean,
  settingsPath = getSubagentSettingsPath(),
): SubagentSettings {
  const stored = readStoredSettings(settingsPath);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify({
    ...stored,
    version: 1,
    builtInEnabled: enabled,
  }, null, 2));
  return readSubagentSettings(settingsPath);
}
