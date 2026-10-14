import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import extension from "../index.ts";

let dir: string;
const originalHome = process.env.HOME;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-switch-provider-"));
  process.env.HOME = dir;
  process.env.PI_CODING_AGENT_DIR = dir;
  await mkdir(join(dir, ".pi", "agent"), { recursive: true });
  await writeFile(join(dir, "pi-autoname.json"), JSON.stringify({ model: "gpt/small", fallbackModels: ["backup/other"] }));
  await writeFile(join(dir, "settings.json"), JSON.stringify({
    defaultProvider: "gpt", defaultModel: "big",
    packages: ["npm:pi-subagents@0.49.0"],
    subagents: { defaultModel: "gpt/small", modelScope: { enforce: true, strict: true, allow: ["gpt/small"] } },
  }));
  await writeFile(join(dir, "web-search.json"), JSON.stringify({
    summaryModel: "elsewhere/small", fetch: { answerProvider: "gpt", answerModel: "small", other: true }, untouched: true,
  }));
});
afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(dir, { recursive: true, force: true });
});

function run(choices: (string | undefined)[], confirmations: boolean[], compactError?: Error, auth = true) {
  let handler: Function;
  let beforeAgentStart: Function | undefined;
  const models = ["gpt/big", "gpt/small", "zhipu/glm-large", "zhipu/glm-air"].map((id) => {
    const [provider, name] = id.split("/");
    return { provider, id: name };
  });
  let active = models[0];
  let reloaded = false;
  const prompts: string[][] = [];
  const notices: string[] = [];
  const pi = {
    on: (event: string, hook: Function) => { if (event === "before_agent_start") beforeAgentStart = hook; },
    getActiveTools: () => ["subagent"],
    registerCommand: (name: string, command: { handler: Function }) => { assert.equal(name, "providers"); handler = command.handler; },
    setModel: async (model: typeof active) => { if (!auth) return false; active = model; return true; },
  };
  extension(pi as never);
  const ctx = {
    cwd: dir,
    hasUI: true,
    model: active,
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    },
    ui: {
      select: async (_title: string, options: string[]) => { prompts.push(options); return choices.shift(); },
      confirm: async () => confirmations.shift() ?? false,
      notify: (message: string) => { notices.push(message); },
    },
    compact: ({ onComplete, onError }: { onComplete: () => void; onError: (error: Error) => void }) => {
      if (compactError) onError(compactError); else onComplete();
    },
    reload: async () => { reloaded = true; },
  };
  return {
    execute: () => handler!("", ctx),
    inject: async (systemPrompt = "base prompt") => {
      const systemPromptOptions = { promptGuidelines: [] as string[] };
      await beforeAgentStart?.({ systemPrompt, systemPromptOptions }, ctx);
      return systemPromptOptions.promptGuidelines;
    },
    prompts,
    notices,
    get active() { return active; },
    get reloaded() { return reloaded; },
  };
}

test("switches both tiers across model families and stores the preset", async () => {
  const session = run(["zhipu", "glm-large", "glm-air"], [true, true]);
  await session.execute();
  assert.equal(session.active.provider, "zhipu");
  assert.equal(session.reloaded, true);
  const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
  assert.equal(settings.defaultModel, "glm-large");
  assert.equal(settings.subagents.defaultModel, "zhipu/glm-air");
  assert.deepEqual(settings.subagents.modelScope.allow, ["zhipu/glm-air"]);
  const web = JSON.parse(await readFile(join(dir, "web-search.json"), "utf8"));
  assert.equal(web.summaryModel, "zhipu/glm-air");
  assert.equal(web.fetch.answerProvider, "zhipu");
  assert.equal(web.fetch.answerModel, "glm-air");
  assert.equal(web.fetch.other, true);
  assert.equal(web.untouched, true);
  const autoname = JSON.parse(await readFile(join(dir, "pi-autoname.json"), "utf8"));
  assert.equal(autoname.model, "zhipu/glm-air");
  assert.deepEqual(autoname.fallbackModels, ["backup/other"]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "switch-provider.json"), "utf8")), {
    zhipu: { sport: "glm-large", eco: "glm-air" },
  });
  const next = run(["zhipu", undefined], []);
  await next.execute();
  assert.equal(next.prompts[1][0], "glm-large");
});

test("cancel and compact failure leave config and session unchanged", async () => {
  const before = await readFile(join(dir, "settings.json"), "utf8");
  const cancelled = run(["zhipu", undefined], []);
  await cancelled.execute();
  assert.equal(cancelled.active.provider, "gpt");
  const failed = run(["zhipu", "glm-large", "glm-air"], [true, true], new Error("quota"));
  await failed.execute();
  assert.equal(failed.active.provider, "gpt");
  assert.equal(failed.reloaded, false);
  assert.equal(await readFile(join(dir, "settings.json"), "utf8"), before);
  await assert.rejects(readFile(join(dir, "switch-provider.json"), "utf8"), { code: "ENOENT" });
});

test("authentication failure does not save the provider preset", async () => {
  const session = run(["zhipu", "glm-large", "glm-air"], [false], undefined, false);
  await session.execute();
  assert.equal(session.active.provider, "gpt");
  assert.equal(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).defaultProvider, "gpt");
  await assert.rejects(readFile(join(dir, "switch-provider.json"), "utf8"), { code: "ENOENT" });
});

test("does not enable webaccess answer mode when no standing model was configured", async () => {
  await writeFile(join(dir, "web-search.json"), JSON.stringify({ summaryModel: "gpt/small", fetch: { timeout: 10 } }));
  await run(["zhipu", "glm-large", "glm-air"], [false]).execute();
  const web = JSON.parse(await readFile(join(dir, "web-search.json"), "utf8"));
  assert.deepEqual(web.fetch, { timeout: 10 });
});

test("preserves stale Nico settings when only Gotgenes is installed", async () => {
  const before = { defaultModel: "gpt/small", modelScope: { enforce: true, strict: true, allow: ["gpt/small"] } };
  await writeFile(join(dir, "settings.json"), JSON.stringify({
    defaultProvider: "gpt", defaultModel: "big", packages: ["npm:@gotgenes/pi-subagents"], subagents: before,
  }));
  await run(["zhipu", "glm-large", "glm-air"], [false]).execute();
  const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
  assert.deepEqual(settings.subagents, before);
});

test("injects the saved Eco model for Gotgenes installed at project scope", async () => {
  await writeFile(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "gpt", defaultModel: "big", packages: [] }));
  await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
    packages: [{ source: "npm:@gotgenes/pi-subagents@21.7.5" }],
  }));
  await writeFile(join(dir, "switch-provider.json"), JSON.stringify({ gpt: { sport: "big", eco: "small" } }));
  const guidelines = await run([], []).inject();
  assert.match(guidelines.join("\n"), /pass model: "gpt\/small"/);
  assert.match(guidelines.join("\n"), /explicitly requested another model/);
});

test("does not inject a Gotgenes model before an Eco preset exists", async () => {
  await writeFile(join(dir, "settings.json"), JSON.stringify({
    defaultProvider: "gpt", defaultModel: "big", packages: ["npm:@gotgenes/pi-subagents"],
  }));
  assert.deepEqual(await run([], []).inject(), []);
});
