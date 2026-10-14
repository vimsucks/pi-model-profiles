# pi-model-profiles

Switching providers in a shared Pi setup easily misses the subagent or extension models that are pinned elsewhere. This extension adds `/providers`, which remembers two model tiers per provider: Sport for the main Pi session and Eco for cost-sensitive callers.

Install the package, run `/reload` once, then run `/providers`.

```bash
pi install git:github.com/vimsucks/pi-model-profiles
```

The command first asks for a provider, then for the Sport and Eco models. Models you already picked for that provider come first. A new choice becomes the preset for the next time. Pressing Esc exits without changing configuration. Both tiers may use the same model.

Sport updates the Pi default model and the current session model. When [pi-subagents](https://pi.dev/packages/pi-subagents) is installed, Eco is written to its `defaultModel`, and the strict `modelScope.allow` list is narrowed to that model. Subagents that pin a model in their agent file or call arguments keep their own rules and the strict allowlist may reject them; adjust those agents separately.

When [@gotgenes/pi-subagents](https://pi.dev/packages/@gotgenes/pi-subagents) is installed and the current provider already has an Eco preset, the extension tells the parent agent to pass that Eco model to the `subagent` tool. An explicit user choice wins, and an agent that locks its model is respected. Gotgenes has no global subagent default model, so this is a model-call instruction rather than a runtime restriction; other extensions that call `SubagentsService` directly are not covered. Nothing is injected until `/providers` has run, and stale Nico configuration left after an uninstall is ignored.

[pi-web-access](https://pi.dev/packages/pi-web-access) `summaryModel` also switches to Eco for search-result summaries and Curator drafts. When `fetch.answerProvider` and `fetch.answerModel` are configured, both change to Eco for `fetch_content` answer mode. Without a pinned answer model, the command adds no answer configuration and answer mode keeps using the current Pi model by its own rules. Search services, video understanding, and PDF extraction keep their own service choices, and an explicit `answerModel` on a tool call is unaffected.

When pi-autoname is installed and `~/.pi/agent/pi-autoname.json` exists, the command also sets its `model` to Eco and keeps `fallbackModels`. The extension names sessions with that model, which was easy to leave on the old provider after switching.

After picking models you can choose to `/reload`. If you reload, you can also compact with the old model first. The switch happens only after compaction succeeds, which reduces the context carried into the first request on another provider; compaction itself costs a model call. Cancelling, a failed compaction, and missing authentication for the new provider save no configuration. Without a reload, the current Pi session switches immediately, and extensions that re-read configuration may need a manual `/reload` later.

Presets live in `~/.pi/agent/switch-provider.json`. The original Pi, subagent, and webaccess configuration stays in its own files, and the command updates them together. Other extensions that pin their own text model need separate handling for their own configuration format. Image models, Fusion multi-model tasks, and explicitly pinned run models do not follow Sport/Eco.

Run `pnpm test` in the repository to check the switch, cancel, and failure paths.
