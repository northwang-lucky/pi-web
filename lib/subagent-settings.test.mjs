import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  isBuiltInSubagentsEnabled,
  readSubagentSettings,
  writeBuiltInSubagentsEnabled,
} = await createJiti(import.meta.url).import("./subagent-settings.ts");

test("subagent settings default the built-in extension to disabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: false, maxConcurrentSubagents: 4 });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
});

test("subagent settings persist both states and preserve unrelated fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: true, maxConcurrentSubagents: 4 });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  const first = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(first, { version: 1, builtInEnabled: true });

  await writeFile(settingsPath, JSON.stringify({ ...first, futureSetting: 3 }));
  writeBuiltInSubagentsEnabled(false, settingsPath);
  const second = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(second, { version: 1, builtInEnabled: false, futureSetting: 3 });
});

test("maxConcurrentSubagents defaults to 4 when absent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  const settings = readSubagentSettings(settingsPath);
  assert.equal(settings.maxConcurrentSubagents, 4);
});

test("maxConcurrentSubagents is read and validated from settings file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");
  await mkdir(join(root, "agents"), { recursive: true });

  // Valid positive integer.
  await writeFile(settingsPath, JSON.stringify({ maxConcurrentSubagents: 8 }));
  assert.equal(readSubagentSettings(settingsPath).maxConcurrentSubagents, 8);

  // Zero falls back to default.
  await writeFile(settingsPath, JSON.stringify({ maxConcurrentSubagents: 0 }));
  assert.equal(readSubagentSettings(settingsPath).maxConcurrentSubagents, 4);

  // Negative falls back to default.
  await writeFile(settingsPath, JSON.stringify({ maxConcurrentSubagents: -1 }));
  assert.equal(readSubagentSettings(settingsPath).maxConcurrentSubagents, 4);

  // Non-numeric falls back to default.
  await writeFile(settingsPath, JSON.stringify({ maxConcurrentSubagents: "oops" }));
  assert.equal(readSubagentSettings(settingsPath).maxConcurrentSubagents, 4);

  // Fractional is floored.
  await writeFile(settingsPath, JSON.stringify({ maxConcurrentSubagents: 3.7 }));
  assert.equal(readSubagentSettings(settingsPath).maxConcurrentSubagents, 3);
});

test("damaged settings fail closed and are not overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, "{");

  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  assert.throws(() => readSubagentSettings(settingsPath));
  assert.throws(() => writeBuiltInSubagentsEnabled(true, settingsPath));
  assert.equal(await readFile(settingsPath, "utf8"), "{");
});
