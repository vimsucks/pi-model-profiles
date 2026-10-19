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

const NEW_PROFILE = "+ New profile…";
const SET_DEFAULT = "★ Set as default profile";

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
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
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
  if (await ctx.ui.confirm("Compact first?", "Compress the session with the current model before switching profiles")) {
    await new Promise<void>((resolve, reject) => ctx.compact({ onComplete: () => resolve(), onError: reject }));
  }
  const model = findModel(ctx, profile.sport);
  if (!model) throw new Error(`${profile.sport} is not an available model`);
  if (!await pi.setModel(model)) throw new Error(`Cannot switch to ${profile.sport}; check the provider authentication`);
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
  if (!models.length) throw new Error("No model provider is available");
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
  const sport = await pick("Sport (main session)");
  if (!sport) return undefined;
  const eco = await pick("Eco (subagents and tools)", providerOf(sport));
  if (!eco) return undefined;
  const suggestion = `${providerOf(sport)}-${sport.slice(providerOf(sport).length + 1)}`;
  for (;;) {
    const name = (await ctx.ui.input("Profile name", suggestion))?.trim();
    if (!name) return undefined;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      ctx.ui.notify("Use only letters, digits, dots, underscores, and hyphens", "warning");
      continue;
    }
    if (profiles[name]) {
      ctx.ui.notify(`${name} already exists`, "warning");
      continue;
    }
    return { name, profile: { sport, eco } };
  }
}

export default function (pi: ExtensionAPI) {
  let active: Profile | undefined;

  const remember = (name: string, profile: Profile) => {
    pi.appendEntry("model-profile", { name, sport: profile.sport, eco: profile.eco });
    active = { ...profile };
  };

  const restore = (ctx: ExtensionContext) => {
    active = undefined;
    for (const entry of ctx.sessionManager.getBranch().slice().reverse()) {
      if (entry.type !== "custom" || entry.customType !== "model-profile") continue;
      const data = entry.data as { name?: unknown; sport?: unknown; eco?: unknown } | undefined;
      if (!data || typeof data.name !== "string" || !data.name ||
          typeof data.sport !== "string" || !providerOf(data.sport) || data.sport.endsWith("/") ||
          typeof data.eco !== "string" || !providerOf(data.eco) || data.eco.endsWith("/")) continue;
      active = { sport: data.sport, eco: data.eco };
      break;
    }
  };

  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_start", async (event, ctx) => {
    restore(ctx);
    if (active || (event.reason !== "startup" && event.reason !== "new")) return;
    try {
      const files = paths();
      const store = await load(files.profiles);
      const name = typeof store.default === "string" ? store.default : "";
      const profile = profilesOf(store)[name];
      if (!profile) return;
      const settings = pi.getSettings();
      const configured = typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string"
        ? `${settings.defaultProvider}/${settings.defaultModel}`
        : "";
      const current = ctx.model ? qualified(ctx.model) : "";
      // A different current model means an explicit override such as `--model`.
      if (configured && current && current !== configured) {
        remember(name, profile);
        return;
      }
      const model = findModel(ctx, profile.sport);
      if (model && await pi.setModel(model)) remember(name, profile);
    } catch {
      // A broken profile file must not break session startup.
    }
  });

  pi.on("tool_call", (event) => {
    if (!active) return;
    const input = event.input as unknown as Config;
    if (event.toolName === "subagent") {
      if (input.action === undefined && !input.model) input.model = active.eco;
      return;
    }
    if (event.toolName === "fetch_content" && input.mode === "answer" && !input.answerModel) {
      input.answerModel = active.eco;
    }
  });

  pi.registerCommand("profiles", {
    description: "Switch the model profile (Sport for the main session, Eco for subagents and tools)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const files = paths();
      const widenScope = async (profiles: Profiles) => {
        try {
          await syncScope(files.settings, profiles);
        } catch (error) {
          ctx.ui.notify(`modelScope allowlist not updated: ${(error as Error).message}`, "warning");
        }
      };
      try {
        const store = await load(files.profiles);
        const profiles = profilesOf(store);
        const names = Object.keys(profiles).sort();
        const labels = names.map((name) => (name === store.default ? `${name} (default)` : name));
        const chosen = await ctx.ui.select("Select a model profile", [...labels, NEW_PROFILE, SET_DEFAULT]);
        if (!chosen) return;

        if (chosen === SET_DEFAULT) {
          if (!names.length) throw new Error("No profile yet; create one first");
          const target = await ctx.ui.select("Set as default for new sessions", labels);
          if (!target) return;
          const name = names[labels.indexOf(target)];
          await save(files.profiles, { ...store, default: name });
          ctx.ui.notify(`New sessions now default to ${name}`, "info");
          return;
        }

        if (chosen === NEW_PROFILE) {
          const created = await createProfile(ctx, profiles);
          if (!created) return;
          const switchNow = await ctx.ui.confirm("Switch to this profile now?", created.name);
          const before = ctx.model;
          if (switchNow) await activate(pi, ctx, created.profile);
          try {
            await save(files.profiles, { ...store, profiles: { ...profiles, [created.name]: created.profile } });
          } catch (error) {
            if (switchNow && before) await pi.setModel(before);
            throw error;
          }
          if (switchNow) remember(created.name, created.profile);
          await widenScope({ ...profiles, [created.name]: created.profile });
          ctx.ui.notify(switchNow ? `Created and switched to ${created.name}` : `Created profile ${created.name}`, "info");
          return;
        }

        const name = names[labels.indexOf(chosen)];
        const profile = profiles[name];
        if (!profile) return;
        await activate(pi, ctx, profile);
        remember(name, profile);
        await widenScope(profiles);
        ctx.ui.notify(`Switched to ${name}`, "info");
      } catch (error) {
        ctx.ui.notify(`Switch failed: ${(error as Error).message}`, "error");
      }
    },
  });
}
