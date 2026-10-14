import { existsSync } from "node:fs";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Config = Record<string, any>;
type Preset = { sport: string; eco: string };

function paths() {
  const agentDir = getAgentDir();
  const legacyDir = join(homedir(), CONFIG_DIR_NAME);
  const xdgDir = process.env.XDG_CONFIG_HOME && join(process.env.XDG_CONFIG_HOME, "pi");
  const webDir = process.env.PI_CODING_AGENT_DIR
    ? agentDir
    : xdgDir
      ? (existsSync(join(xdgDir, "web-search.json")) ? xdgDir : existsSync(join(legacyDir, "web-search.json")) ? legacyDir : xdgDir)
      : existsSync(join(agentDir, "web-search.json")) ? agentDir : existsSync(join(legacyDir, "web-search.json")) ? legacyDir : agentDir;
  return {
    settings: join(agentDir, "settings.json"),
    presets: join(agentDir, "switch-provider.json"),
    web: join(webDir, "web-search.json"),
    autoname: join(agentDir, "pi-autoname.json"),
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

function qualified(provider: string, id: string) {
  return `${provider}/${id}`;
}

function hasPackage(configs: Config[], name: string) {
  return configs.some((config) => Array.isArray(config.packages) && config.packages.some((entry: unknown) => {
    const source = typeof entry === "string"
      ? entry
      : entry && typeof entry === "object" && typeof (entry as Config).source === "string"
        ? (entry as Config).source
        : "";
    if (!source.startsWith(`npm:${name}`)) return false;
    const suffix = source.slice(`npm:${name}`.length);
    return suffix === "" || suffix.startsWith("@");
  }));
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    if (!pi.getActiveTools().includes("subagent")) return;
    const files = paths();
    const [settings, projectSettings, presets] = await Promise.all([
      load(files.settings),
      load(join(ctx.cwd, ".pi", "settings.json")),
      load(files.presets),
    ]);
    if (!hasPackage([settings, projectSettings], "@gotgenes/pi-subagents")) return;
    const provider = settings.defaultProvider;
    const eco = typeof provider === "string" ? presets[provider]?.eco : undefined;
    if (typeof eco !== "string" || !eco) return;
    event.systemPromptOptions.promptGuidelines.push(
      `When calling the Gotgenes subagent tool, pass model: "${qualified(provider, eco)}" unless the user explicitly requested another model. Respect an agent that locks its model.`,
    );
  });

  pi.registerCommand("providers", {
    description: "切换 provider 的 Sport/Eco 模型预设",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const files = paths();
      try {
        const [settings, projectSettings, web, presets] = await Promise.all([
          load(files.settings),
          load(join(ctx.cwd, ".pi", "settings.json")),
          load(files.web),
          load(files.presets),
        ]);
        const hasNicoSubagents = hasPackage([settings, projectSettings], "pi-subagents");
        const autoname = existsSync(files.autoname) ? await load(files.autoname) : undefined;
        const models = ctx.modelRegistry.getAvailable();
        const providers = [...new Set(models.map((model) => model.provider))].sort();
        if (!providers.length) throw new Error("没有可用的模型 provider");

        const current = settings.defaultProvider;
        const provider = await ctx.ui.select("选择 provider", [current, ...providers].filter((id, index, all) => id && all.indexOf(id) === index));
        if (!provider) return;
        const available = models.filter((model) => model.provider === provider);
        if (!available.length) throw new Error(`${provider} 没有可用模型`);
        const ids = available.map((model) => model.id).sort();
        const saved: Preset | undefined = presets[provider];
        const pick = async (tier: "sport" | "eco", fallback: string | undefined) => {
          const preferred = saved?.[tier] ?? fallback;
          const options = [preferred, ...ids].filter((id, index, all): id is string => !!id && ids.includes(id) && all.indexOf(id) === index);
          return ctx.ui.select(`${tier === "sport" ? "Sport (Pi)" : "Eco (subagent / webaccess)"} · ${provider}`, options);
        };
        const sport = await pick("sport", provider === current ? settings.defaultModel : undefined);
        if (!sport) return;
        const oldEco = hasNicoSubagents && typeof settings.subagents?.defaultModel === "string" ? settings.subagents.defaultModel : "";
        const eco = await pick("eco", oldEco.startsWith(`${provider}/`) ? oldEco.slice(provider.length + 1) : undefined);
        if (!eco) return;
        const reload = await ctx.ui.confirm("切换后 reload？", `${provider}: Sport ${sport} / Eco ${eco}`);
        const compact = reload && await ctx.ui.confirm("先 compact？", "使用当前 provider 压缩会话，再切换模型并 reload");
        if (compact) {
          await new Promise<void>((resolve, reject) => ctx.compact({ onComplete: () => resolve(), onError: reject }));
        }

        const nextSettings: Config = {
          ...settings,
          defaultProvider: provider,
          defaultModel: sport,
          ...(hasNicoSubagents ? {
            subagents: {
              ...settings.subagents,
              defaultModel: qualified(provider, eco),
              modelScope: { ...settings.subagents?.modelScope, enforce: true, strict: true, allow: [qualified(provider, eco)] },
            },
          } : {}),
        };
        const changes: [string, Config, Config][] = [
          [files.settings, nextSettings, settings],
          [files.web, {
            ...web,
            summaryModel: qualified(provider, eco),
            ...(typeof web.fetch?.answerProvider === "string" && typeof web.fetch?.answerModel === "string"
              ? { fetch: { ...web.fetch, answerProvider: provider, answerModel: eco } }
              : {}),
          }, web],
          [files.presets, { ...presets, [provider]: { sport, eco } }, presets],
        ];
        if (autoname) {
          changes.push([files.autoname, { ...autoname, model: qualified(provider, eco) }, autoname]);
        }
        const original = ctx.model;
        const selected = ctx.modelRegistry.find(provider, sport);
        if (!selected || !await pi.setModel(selected)) throw new Error("无法切换当前会话模型，请检查 provider 认证");
        const written: [string, Config][] = [];
        try {
          for (const [path, value, before] of changes) {
            await save(path, value);
            written.push([path, before]);
          }
        } catch (error) {
          for (const [path, before] of written.reverse()) await save(path, before);
          if (original) await pi.setModel(original);
          throw error;
        }
        if (reload) {
          await ctx.reload();
          return;
        }
        ctx.ui.notify("已切换；webaccess 等扩展可能需要 /reload 才会读取新配置", "info");
      } catch (error) {
        ctx.ui.notify(`切换失败：${(error as Error).message}`, "error");
      }
    },
  });
}