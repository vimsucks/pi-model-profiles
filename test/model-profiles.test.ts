import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import extension from "../index.ts";

let dir: string;
const originalHome = process.env.HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-model-profiles-"));
  process.env.HOME = dir;
  process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(dir, { recursive: true, force: true });
});

const MODELS = [
  { provider: "old", id: "base" },
  { provider: "p", id: "gpt-big" },
  { provider: "p", id: "gpt-small" },
  { provider: "q", id: "deep-big" },
];

function write(name: string, value: unknown) {
  return writeFile(join(dir, name), JSON.stringify(value, null, 2));
}

function read(name: string) {
  return readFile(join(dir, name), "utf8");
}

function session(options: {
  choices?: (string | undefined)[];
  confirmations?: boolean[];
  inputs?: string[];
  settings?: Record<string, unknown>;
  current?: { provider: string; id: string };
  auth?: boolean;
  compactError?: Error;
  branch?: { type: string; customType?: string; data?: unknown }[];
} = {}) {
  const hooks: Record<string, Function> = {};
  const choices = [...(options.choices ?? [])];
  const confirmations = [...(options.confirmations ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const prompts: string[][] = [];
  const notices: string[] = [];
  let handler: Function | undefined;
  let current = options.current ?? { provider: "old", id: "base" };
  const settings = options.settings ?? { defaultProvider: "old", defaultModel: "base" };
  const branch = options.branch ?? [];

  const pi = {
    on: (event: string, hook: Function) => { hooks[event] = hook; },
    getSettings: () => settings,
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ type: "custom", customType, data: structuredClone(data) });
    },
    registerCommand: (name: string, command: { handler: Function }) => {
      assert.equal(name, "profiles");
      handler = command.handler;
    },
    setModel: async (model: { provider: string; id: string }) => {
      if (options.auth === false) return false;
      current = model;
      return true;
    },
  };
  extension(pi as never);

  const ctx = {
    cwd: dir,
    hasUI: true,
    sessionManager: { getBranch: () => branch },
    get model() { return current; },
    modelRegistry: {
      getAvailable: () => MODELS,
      find: (provider: string, id: string) => MODELS.find((model) => model.provider === provider && model.id === id),
    },
    ui: {
      select: async (_title: string, options: string[]) => { prompts.push(options); return choices.shift(); },
      confirm: async () => confirmations.shift() ?? false,
      input: async () => inputs.shift(),
      notify: (message: string) => { notices.push(message); },
    },
    compact: ({ onComplete, onError }: { onComplete: () => void; onError: (error: Error) => void }) => {
      if (options.compactError) onError(options.compactError); else onComplete();
    },
  };

  return {
    hooks,
    ctx,
    prompts,
    notices,
    start: (reason = "startup") => hooks.session_start({ reason }, ctx),
    toolCall: (toolName: string, input: Record<string, unknown>) => hooks.tool_call({ toolName, input }, ctx),
    execute: () => handler!("", ctx),
    get current() { return current; },
  };
}

test("session_start applies the default profile model", async () => {
  await write("model-profiles.json", { default: "gpt", profiles: { gpt: { sport: "p/gpt-big", eco: "p/gpt-small" } } });
  const run = session();
  await run.start();
  assert.deepEqual(run.current, { provider: "p", id: "gpt-big" });
});

test("session_start leaves an explicitly chosen model alone", async () => {
  await write("model-profiles.json", { default: "gpt", profiles: { gpt: { sport: "p/gpt-big", eco: "p/gpt-small" } } });
  const run = session({ current: { provider: "q", id: "deep-big" } });
  await run.start();
  assert.deepEqual(run.current, { provider: "q", id: "deep-big" });
});

test("tool calls use the Eco model of the active profile", async () => {
  await write("model-profiles.json", { default: "gpt", profiles: { gpt: { sport: "p/gpt-big", eco: "p/gpt-small" } } });
  const run = session();
  await run.start();

  const subagent: Record<string, unknown> = { agent: "scout" };
  await run.toolCall("subagent", subagent);
  assert.equal(subagent.model, "p/gpt-small");

  const pinned: Record<string, unknown> = { agent: "scout", model: "q/deep-big" };
  await run.toolCall("subagent", pinned);
  assert.equal(pinned.model, "q/deep-big");

  const answer: Record<string, unknown> = { url: "https://example.com", mode: "answer" };
  await run.toolCall("fetch_content", answer);
  assert.equal(answer.answerModel, "p/gpt-small");

  const readable: Record<string, unknown> = { url: "https://example.com", mode: "readable" };
  await run.toolCall("fetch_content", readable);
  assert.equal(readable.answerModel, undefined);
});

test("a new profile is stored, applied and widens the subagent allowlist", async () => {
  const branch: { type: string; customType?: string; data?: unknown }[] = [];
  await write("model-profiles.json", {});
  await write("settings.json", {
    defaultProvider: "old",
    defaultModel: "base",
    subagents: { modelScope: { enforce: true, strict: true, allow: ["old/base"] } },
  });
  const run = session({
    branch,
    choices: ["+ New profile…", "p", "gpt-big", "p", "gpt-small"],
    confirmations: [true],
    inputs: ["gpt"],
  });
  await run.execute();

  assert.deepEqual(JSON.parse(await read("model-profiles.json")).profiles, {
    gpt: { sport: "p/gpt-big", eco: "p/gpt-small" },
  });
  assert.deepEqual(run.current, { provider: "p", id: "gpt-big" });
  assert.deepEqual(JSON.parse(await read("settings.json")).subagents.modelScope.allow, ["old/base", "p/gpt-small"]);
  assert.match(run.notices.at(-1) ?? "", /Created and switched to gpt/);
  const reloaded = session({ branch, current: run.current });
  await reloaded.start("reload");
  const subagent: Record<string, unknown> = {};
  await reloaded.toolCall("subagent", subagent);
  assert.equal(subagent.model, "p/gpt-small");
});

test("switching an existing profile keeps the profile file untouched", async () => {
  const store = { default: "gpt", profiles: { gpt: { sport: "p/gpt-big", eco: "p/gpt-small" } } };
  await write("model-profiles.json", store);
  const run = session({ choices: ["gpt (default)"], confirmations: [false] });
  await run.execute();

  assert.deepEqual(run.current, { provider: "p", id: "gpt-big" });
  assert.deepEqual(JSON.parse(await read("model-profiles.json")), store);
  assert.match(run.notices.at(-1) ?? "", /Switched to gpt/);
});

test("a failed model switch changes nothing", async () => {
  const store = { default: "gpt", profiles: { gpt: { sport: "p/gpt-big", eco: "p/gpt-small" } } };
  await write("model-profiles.json", store);
  const run = session({ choices: ["gpt (default)"], confirmations: [false], auth: false });
  await run.execute();

  assert.deepEqual(run.current, { provider: "old", id: "base" });
  assert.deepEqual(JSON.parse(await read("model-profiles.json")), store);
  assert.match(run.notices.at(-1) ?? "", /Switch failed/);

  const subagent: Record<string, unknown> = { agent: "scout" };
  await run.toolCall("subagent", subagent);
  assert.equal(subagent.model, undefined);
});

test("setting a default only updates the profile file", async () => {
  await write("model-profiles.json", {
    default: "gpt",
    profiles: { gpt: { sport: "p/gpt-big", eco: "p/gpt-small" }, deep: { sport: "q/deep-big", eco: "q/deep-big" } },
  });
  const run = session({ choices: ["★ Set as default profile", "deep"] });
  await run.execute();

  assert.equal(JSON.parse(await read("model-profiles.json")).default, "deep");
  assert.deepEqual(run.current, { provider: "old", id: "base" });
  assert.match(run.notices.at(-1) ?? "", /New sessions now default to deep/);
});

test("a compact failure aborts the switch", async () => {
  const store = { default: "gpt", profiles: { gpt: { sport: "p/gpt-big", eco: "p/gpt-small" } } };
  await write("model-profiles.json", store);
  const run = session({ choices: ["gpt (default)"], confirmations: [true], compactError: new Error("quota") });
  await run.execute();

  assert.deepEqual(run.current, { provider: "old", id: "base" });
  assert.match(run.notices.at(-1) ?? "", /Switch failed: quota/);
});


test("reload restores the selected Eco snapshot without changing the current model", async () => {
  const branch: { type: string; customType?: string; data?: unknown }[] = [];
  await write("model-profiles.json", {
    default: "deep",
    profiles: {
      gpt: { sport: "p/gpt-big", eco: "p/gpt-small" },
      deep: { sport: "q/deep-big", eco: "q/deep-big" },
    },
  });
  const first = session({ branch, choices: ["gpt"] });
  await first.execute();
  // Editing or deleting the shared profile must not change a saved session.
  await write("model-profiles.json", { default: "deep", profiles: {} });
  const reloaded = session({ branch, current: { provider: "q", id: "deep-big" } });
  await reloaded.start("reload");
  const subagent: Record<string, unknown> = { agent: "delegate" };
  await reloaded.toolCall("subagent", subagent);
  assert.equal(subagent.model, "p/gpt-small");
  assert.deepEqual(reloaded.current, { provider: "q", id: "deep-big" });
  const answer: Record<string, unknown> = { mode: "answer" };
  await reloaded.toolCall("fetch_content", answer);
  assert.equal(answer.answerModel, "p/gpt-small");
});


test("restoration uses the latest valid profile on the active branch", async () => {
  const branch = [
    { type: "custom", customType: "model-profile", data: { name: "gpt", sport: "p/gpt-big", eco: "p/gpt-small" } },
    { type: "custom", customType: "other-extension", data: { eco: "old/base" } },
    { type: "custom", customType: "model-profile", data: { name: "deep", sport: "q/deep-big", eco: "q/deep-big" } },
    { type: "custom", customType: "model-profile", data: { name: "broken", sport: "p/", eco: 42 } },
  ];
  for (const reason of ["startup", "reload", "resume", "fork"]) {
    const restored = session({ branch, current: { provider: "p", id: "gpt-big" } });
    await restored.start(reason);
    const subagent: Record<string, unknown> = {};
    await restored.toolCall("subagent", subagent);
    assert.equal(subagent.model, "q/deep-big");
    assert.deepEqual(restored.current, { provider: "p", id: "gpt-big" });
  }
});

test("switching sessions and branches clears stale profile state", async () => {
  const branch = [
    { type: "custom", customType: "model-profile", data: { name: "gpt", sport: "p/gpt-big", eco: "p/gpt-small" } },
  ];
  const run = session({ branch });
  await run.start("resume");
  branch.length = 0;
  await run.hooks.session_tree({}, run.ctx);
  const afterTree: Record<string, unknown> = {};
  await run.toolCall("subagent", afterTree);
  assert.equal(afterTree.model, undefined);
  branch.push({ type: "custom", customType: "model-profile", data: { name: "gpt", sport: "p/gpt-big", eco: "p/gpt-small" } });
  await run.hooks.session_tree({}, run.ctx);
  branch.length = 0;
  await run.start("new");
  const afterNew: Record<string, unknown> = {};
  await run.toolCall("subagent", afterNew);
  assert.equal(afterNew.model, undefined);
});

test("a default profile snapshot survives reload after its shared definition is deleted", async () => {
  const branch: { type: string; customType?: string; data?: unknown }[] = [];
  await write("model-profiles.json", { default: "gpt", profiles: { gpt: { sport: "p/gpt-big", eco: "p/gpt-small" } } });
  const first = session({ branch });
  await first.start();
  await rm(join(dir, "model-profiles.json"));
  const restored = session({ branch, current: first.current });
  await restored.start("reload");
  const subagent: Record<string, unknown> = {};
  await restored.toolCall("subagent", subagent);
  assert.equal(subagent.model, "p/gpt-small");
});
