import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const THINKING_MODELS = [
  { provider: "p", id: "gpt-big", reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" } },
  { provider: "p", id: "gpt-small", reasoning: true, thinkingLevelMap: { off: null, minimal: null, high: null, xhigh: null, max: null } },
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
  thinking?: string;
  models?: { provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> }[];
  auth?: boolean;
  compactError?: Error;
  onSetModel?: (model: { provider: string; id: string }) => Promise<void>;
  branch?: { type: string; customType?: string; data?: unknown }[];
} = {}) {
  const hooks: Record<string, Function> = {};
  const choices = [...(options.choices ?? [])];
  const confirmations = [...(options.confirmations ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const prompts: string[][] = [];
  const confirmationPrompts: string[] = [];
  const notices: string[] = [];
  let handler: Function | undefined;
  let current = options.current ?? { provider: "old", id: "base" };
  let thinking = options.thinking ?? "medium";
  const models = options.models ?? MODELS;
  const settings = options.settings ?? { defaultProvider: "old", defaultModel: "base" };
  const branch = options.branch ?? [];

  const pi = {
    on: (event: string, hook: Function) => { hooks[event] = hook; },
    getSettings: () => settings,
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level: string) => { thinking = level; },
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
      await options.onSetModel?.(model);
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
      getAvailable: () => models,
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    },
    ui: {
      select: async (_title: string, options: string[]) => { prompts.push(options); return choices.shift(); },
      confirm: async (title: string) => { confirmationPrompts.push(title); return confirmations.shift() ?? false; },
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
    confirmationPrompts,
    notices,
    start: (reason = "startup") => hooks.session_start({ reason }, ctx),
    toolCall: (toolName: string, input: Record<string, unknown>) => hooks.tool_call({ toolName, input }, ctx),
    execute: () => handler!("", ctx),
    get current() { return current; },
    get thinking() { return thinking; },
  };
}

test("session_start applies the default profile model", async () => {
  await write("model-profiles.json", { default: "gpt", profiles: { gpt: { sport: "p/gpt-big", eco: "p/gpt-small" } } });
  const run = session();
  await run.start();
  assert.deepEqual(run.current, { provider: "p", id: "gpt-big" });
});

test("startup applies Sport thinking only when it applies the default profile", async () => {
  await write("model-profiles.json", {
    default: "gpt", profiles: { gpt: { sport: "p/gpt-big", eco: "p/gpt-small", sportThinking: "off" } },
  });
  for (const reason of ["startup", "new"]) {
    const run = session({ thinking: "high" });
    await run.start(reason);
    assert.equal(run.thinking, "off");
  }
  const explicit = session({ current: { provider: "q", id: "deep-big" }, thinking: "low" });
  await explicit.start();
  assert.equal(explicit.thinking, "low");
  const failed = session({ auth: false, thinking: "high" });
  await failed.start();
  assert.equal(failed.thinking, "high");
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

test("resumed profiles leave subagent management calls unchanged", async () => {
  const run = session({
    branch: [{ type: "custom", customType: "model-profile", data: { name: "gpt", sport: "p/gpt-big", eco: "p/gpt-small" } }],
  });
  await run.start("resume");

  for (const action of ["resume", "steer", "status", "guide"]) {
    const input = { action, id: "child-1", message: "Continue" };
    assert.equal(await run.toolCall("subagent", input), undefined);
    assert.deepEqual(input, { action, id: "child-1", message: "Continue" });
  }

  const execution: Record<string, unknown> = { agent: "scout", task: "Inspect the repository" };
  await run.toolCall("subagent", execution);
  assert.equal(execution.model, "p/gpt-small");
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
    confirmations: [true, true],
    inputs: ["gpt"],
  });
  await run.execute();

  assert.deepEqual(JSON.parse(await read("model-profiles.json")).profiles, {
    gpt: { sport: "p/gpt-big", eco: "p/gpt-small" },
  });
  assert.deepEqual(run.current, { provider: "p", id: "gpt-big" });
  assert.deepEqual(JSON.parse(await read("settings.json")).subagents.modelScope.allow, ["old/base", "p/gpt-small"]);
  assert.match(run.notices.at(-1) ?? "", /Created and switched to gpt/);
  assert.deepEqual(run.confirmationPrompts, ["Switch to this profile now?", "Compact first?"]);
  const reloaded = session({ branch, current: run.current });
  await reloaded.start("reload");
  const subagent: Record<string, unknown> = {};
  await reloaded.toolCall("subagent", subagent);
  assert.equal(subagent.model, "p/gpt-small");
});

test("creating a profile selects supported thinking levels after each model", async () => {
  await write("model-profiles.json", {});
  const run = session({
    models: THINKING_MODELS,
    choices: ["+ New profile…", "p", "gpt-big", "high", "p", "gpt-small", "low"],
    confirmations: [true, false],
    inputs: ["reasoning"],
  });
  await run.execute();

  assert.deepEqual(JSON.parse(await read("model-profiles.json")).profiles.reasoning, {
    sport: "p/gpt-big", eco: "p/gpt-small", sportThinking: "high", ecoThinking: "low",
  });
  assert.equal(run.thinking, "high");
  assert.deepEqual(run.prompts[3], ["Do not override", "off", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(run.prompts[6], ["Do not override", "low", "medium"]);
});

test("cancelling either thinking picker leaves the profile and session unchanged", async () => {
  for (const choices of [
    ["+ New profile…", "p", "gpt-big", undefined],
    ["+ New profile…", "p", "gpt-big", "high", "p", "gpt-small", undefined],
  ]) {
    await write("model-profiles.json", {});
    const run = session({ models: THINKING_MODELS, choices, thinking: "low" });
    await run.execute();
    assert.deepEqual(JSON.parse(await read("model-profiles.json")), {});
    assert.deepEqual(run.current, { provider: "old", id: "base" });
    assert.equal(run.thinking, "low");
    assert.deepEqual(run.confirmationPrompts, []);
  }
});

test("saving thinking choices without switching preserves the active profile", async () => {
  const legacy = { sport: "p/gpt-big", eco: "p/gpt-small" };
  for (const [sportThinking, ecoThinking] of [["Do not override", "Do not override"], ["off", "low"]]) {
    await write("model-profiles.json", { default: "legacy", profiles: { legacy } });
    const run = session({
      models: THINKING_MODELS, thinking: "high",
      choices: ["+ New profile…", "p", "gpt-big", sportThinking, "p", "gpt-small", ecoThinking],
      confirmations: [false], inputs: ["saved"],
    });
    await run.start();
    await run.execute();
    const store = JSON.parse(await read("model-profiles.json"));
    assert.deepEqual(store.profiles.saved, sportThinking === "off"
      ? { ...legacy, sportThinking: "off", ecoThinking: "low" } : legacy);
    assert.deepEqual(store.profiles.legacy, legacy);
    assert.equal(run.thinking, "high");
    const input: Record<string, unknown> = { agent: "scout" };
    await run.toolCall("subagent", input);
    assert.equal(input.model, "p/gpt-small");
    assert.deepEqual(run.confirmationPrompts, ["Switch to this profile now?"]);
  }
});

test("a failed profile save restores the previous model and thinking", async () => {
  await write("model-profiles.json", {});
  const run = session({
    models: THINKING_MODELS, thinking: "low",
    choices: ["+ New profile…", "p", "gpt-big", "high", "p", "gpt-small", "low"],
    confirmations: [true, false], inputs: ["unsaved"],
    onSetModel: async (model) => {
      if (model.provider !== "p") return;
      await rm(join(dir, "model-profiles.json"));
      await mkdir(join(dir, "model-profiles.json"));
    },
  });
  await run.execute();
  assert.match(run.notices.at(-1) ?? "", /Switch failed:/);
  assert.deepEqual(run.current, { provider: "old", id: "base" });
  assert.equal(run.thinking, "low");
  assert.deepEqual(run.ctx.sessionManager.getBranch(), []);
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


test("thinking snapshots survive restoration without resetting the main session", async () => {
  const profile = { sport: "p/gpt-big", eco: "p/gpt-small", sportThinking: "high", ecoThinking: "low" };
  const branch: { type: string; customType?: string; data?: unknown }[] = [];
  await write("model-profiles.json", { default: "gpt", profiles: { gpt: profile } });
  const first = session({ branch, choices: ["gpt (default)"] });
  await first.execute();
  assert.equal(first.thinking, "high");
  assert.deepEqual(branch.at(-1)?.data, { name: "gpt", ...profile });
  await write("model-profiles.json", { default: "gpt", profiles: { gpt: { ...profile, ecoThinking: "high" } } });

  for (const reason of ["startup", "reload", "resume", "fork"]) {
    const run = session({ branch, thinking: "off", current: { provider: "q", id: "deep-big" } });
    await run.start(reason);
    assert.equal(run.thinking, "off");
    assert.deepEqual(run.current, { provider: "q", id: "deep-big" });
    const child: Record<string, unknown> = { agent: "scout" };
    await run.toolCall("subagent", child);
    assert.equal(child.model, "p/gpt-small:low");
    for (const model of ["q/deep-big:high", "p/gpt-small", "inherit"]) {
      const pinned = { agent: "scout", model };
      await run.toolCall("subagent", pinned);
      assert.equal(pinned.model, model);
    }
    const resume = { action: "resume", id: "child-1", message: "Continue" };
    await run.toolCall("subagent", resume);
    assert.deepEqual(resume, { action: "resume", id: "child-1", message: "Continue" });
    const answer: Record<string, unknown> = { mode: "answer" };
    await run.toolCall("fetch_content", answer);
    assert.equal(answer.answerModel, "p/gpt-small");
  }
  const reselected = session({ branch, thinking: "off", choices: ["gpt (default)"] });
  await reselected.start("resume");
  await reselected.execute();
  const updated: Record<string, unknown> = { agent: "scout" };
  await reselected.toolCall("subagent", updated);
  assert.equal(updated.model, "p/gpt-small:high");
  assert.equal(reselected.thinking, "high");
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

test("legacy or malformed snapshots clear stale Eco thinking on tree navigation", async () => {
  const profile = { name: "gpt", sport: "p/gpt-big", eco: "p/gpt-small" };
  const branch: { type: string; customType?: string; data?: unknown }[] = [
    { type: "custom", customType: "model-profile", data: { ...profile, ecoThinking: "off" } },
  ];
  const run = session({ branch, thinking: "high" });
  await run.start("resume");
  const first: Record<string, unknown> = { agent: "scout" };
  await run.toolCall("subagent", first);
  assert.equal(first.model, "p/gpt-small:off");
  for (const ecoThinking of [undefined, "invalid", 42, null]) {
    branch[0].data = { ...profile, ecoThinking };
    await run.hooks.session_tree({}, run.ctx);
    const input: Record<string, unknown> = { agent: "scout" };
    await run.toolCall("subagent", input);
    assert.equal(input.model, "p/gpt-small");
    assert.equal(run.thinking, "high");
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


test("creating a profile without switching preserves the current model and Eco", async () => {
  await write("model-profiles.json", {
    default: "gpt",
    profiles: { gpt: { sport: "p/gpt-big", eco: "p/gpt-small" } },
  });
  const run = session({
    choices: ["+ New profile…", "q", "deep-big", "q", "deep-big"],
    confirmations: [false],
    inputs: ["deep"],
  });
  await run.start();
  await run.execute();
  const store = JSON.parse(await read("model-profiles.json"));
  assert.deepEqual(store.profiles.deep, { sport: "q/deep-big", eco: "q/deep-big" });
  assert.equal(store.default, "gpt");
  assert.deepEqual(run.current, { provider: "p", id: "gpt-big" });
  const subagent: Record<string, unknown> = {};
  await run.toolCall("subagent", subagent);
  assert.equal(subagent.model, "p/gpt-small");
  assert.deepEqual(run.confirmationPrompts, ["Switch to this profile now?"]);
  assert.equal(run.notices.at(-1), "Created profile deep");
});
