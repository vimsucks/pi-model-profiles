import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type Config = Record<string, any>;
type Profile = { sport: string; eco: string };
type Profiles = Record<string, Profile>;

const NEW_PROFILE = "＋ 新建 profile…";
const SET_DEFAULT = "★ 设为默认 profile";

function paths() {
  const agentDir = getAgentDir();
  return {
    settings: join(agentDir, "settings.json"),
    profiles: join(agentDir, "model-profiles.json"),
  };
}

async function load(path: string): Promise<Config> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("需要 JSON 对象");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`无法读取 ${path}: ${(error as Error).message}`);
  }
}

async function save(path: string, value: Config) {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const mode = await stat(path).then((info) => info.mode & 0o777, () => 0o600);
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

function profilesOf(store: Config): Profiles {
  const value = store.profiles;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Profiles;
}

function providerOf(reference: string) {
  const index = reference.indexOf("/");
  return index > 0 ? reference.slice(0, index) : "";
}

function findModel(ctx: ExtensionContext, reference: string) {
  const provider = providerOf(reference);
  if (!provider) return undefined;
  return ctx.modelRegistry.find(provider, reference.slice(provider.length + 1));
}

function qualified(model: NonNullable<ExtensionContext["model"]>) {
  return `${model.provider}/${model.id}`;
}

/** Apply a profile to the current session only: no global configuration is written. */
async function activate(pi: ExtensionAPI, ctx: ExtensionContext, profile: Profile) {
  if (await ctx.ui.confirm("先 compact？", "使用当前模型压缩会话，再切换 profile")) {
    await new Promise<void>((resolve, reject) => ctx.compact({ onComplete: () => resolve(), onError: reject }));
  }
  const model = findModel(ctx, profile.sport);
  if (!model) throw new Error(`${profile.sport} 不在可用模型里`);
  if (!await pi.setModel(model)) throw new Error(`无法切换到 ${profile.sport}，请检查 provider 认证`);
}

/**
 * Widen the pi-subagents model allowlist to cover every profile's Eco model.
 * The list only grows: it grants permission, it never selects a model.
 */
async function syncScope(path: string, profiles: Profiles) {
  const settings = await load(path);
  const subagents = settings.subagents;
  const scope = subagents?.modelScope;
  if (!scope || typeof scope !== "object" || scope.enforce !== true) return;
  const allow = Array.isArray(scope.allow) ? scope.allow.filter((entry: unknown): entry is string => typeof entry === "string") : [];
  const wanted = [...new Set([...allow, ...Object.values(profiles).map((profile) => profile.eco)])];
  if (wanted.length === allow.length) return;
  await save(path, { ...settings, subagents: { ...subagents, modelScope: { ...scope, allow: wanted } } });
}

async function createProfile(ctx: ExtensionCommandContext, profiles: Profiles) {
  const models = ctx.modelRegistry.getAvailable();
  if (!models.length) throw new Error("没有可用的模型 provider");
  const providers = [...new Set(models.map((model) => model.provider))].sort();
  const pick = async (title: string, preferred?: string) => {
    const ordered = preferred && providers.includes(preferred)
      ? [preferred, ...providers.filter((provider) => provider !== preferred)]
      : providers;
    const provider = await ctx.ui.select(`${title} · provider`, ordered);
    if (!provider) return undefined;
    const ids = models.filter((model) => model.provider === provider).map((model) => model.id).sort();
    const id = await ctx.ui.select(`${title} · ${provider}`, ids);
    if (!id) return undefined;
    return `${provider}/${id}`;
  };
  const sport = await pick("Sport（主会话）");
  if (!sport) return undefined;
  const eco = await pick("Eco（子代理 / 工具）", providerOf(sport));
  if (!eco) return undefined;
  const suggestion = `${providerOf(sport)}-${sport.slice(providerOf(sport).length + 1)}`;
  for (;;) {
    const name = (await ctx.ui.input("profile 名", suggestion))?.trim();
    if (!name) return undefined;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      ctx.ui.notify("名字只能包含字母、数字、点、下划线和连字符", "warning");
      continue;
    }
    if (profiles[name]) {
      ctx.ui.notify(`${name} 已存在`, "warning");
      continue;
    }
    return { name, profile: { sport, eco } };
  }
}

export default function (pi: ExtensionAPI) {
  // The session's active profile. It is intentionally in-memory: switching
  // never writes shared configuration, so other sessions keep their models.
  let active: Profile | undefined;

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "new") return;
    try {
      const files = paths();
      const store = await load(files.profiles);
      const name = typeof store.default === "string" ? store.default : "";
      const profile = profilesOf(store)[name];
      if (!profile) return;
      active = profile;
      const settings = pi.getSettings();
      const configured = typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string"
        ? `${settings.defaultProvider}/${settings.defaultModel}`
        : "";
      const current = ctx.model ? qualified(ctx.model) : "";
      // A different current model means an explicit override such as `--model`.
      if (configured && current && current !== configured) return;
      const model = findModel(ctx, profile.sport);
      if (model) await pi.setModel(model);
    } catch {
      // A broken profile file must not break session startup.
    }
  });

  pi.on("tool_call", (event) => {
    if (!active) return;
    const input = event.input as unknown as Config;
    if (event.toolName === "subagent") {
      if (!input.model) input.model = active.eco;
      return;
    }
    if (event.toolName === "fetch_content" && input.mode === "answer" && !input.answerModel) {
      input.answerModel = active.eco;
    }
  });

  pi.registerCommand("profiles", {
    description: "切换 model profile（Sport 主会话 / Eco 子代理与工具）",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const files = paths();
      const widenScope = async (profiles: Profiles) => {
        try {
          await syncScope(files.settings, profiles);
        } catch (error) {
          ctx.ui.notify(`modelScope 白名单未更新：${(error as Error).message}`, "warning");
        }
      };
      try {
        const store = await load(files.profiles);
        const profiles = profilesOf(store);
        const names = Object.keys(profiles).sort();
        const labels = names.map((name) => (name === store.default ? `${name} (default)` : name));
        const chosen = await ctx.ui.select("选择 model profile", [...labels, NEW_PROFILE, SET_DEFAULT]);
        if (!chosen) return;

        if (chosen === SET_DEFAULT) {
          if (!names.length) throw new Error("还没有 profile，先新建一个");
          const target = await ctx.ui.select("设为默认（新会话）", labels);
          if (!target) return;
          const name = names[labels.indexOf(target)];
          await save(files.profiles, { ...store, default: name });
          ctx.ui.notify(`新会话默认：${name}`, "info");
          return;
        }

        if (chosen === NEW_PROFILE) {
          const created = await createProfile(ctx, profiles);
          if (!created) return;
          const before = ctx.model;
          await activate(pi, ctx, created.profile);
          try {
            await save(files.profiles, { ...store, profiles: { ...profiles, [created.name]: created.profile } });
          } catch (error) {
            if (before) await pi.setModel(before);
            throw error;
          }
          active = created.profile;
          await widenScope({ ...profiles, [created.name]: created.profile });
          ctx.ui.notify(`已新建并切换到 ${created.name}`, "info");
          return;
        }

        const name = names[labels.indexOf(chosen)];
        const profile = profiles[name];
        if (!profile) return;
        await activate(pi, ctx, profile);
        active = profile;
        await widenScope(profiles);
        ctx.ui.notify(`已切换到 ${name}`, "info");
      } catch (error) {
        ctx.ui.notify(`切换失败：${(error as Error).message}`, "error");
      }
    },
  });
}
