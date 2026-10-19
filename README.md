# pi-model-profiles

One provider often serves several model families, and Pi's model choices are spread across separate files: the Pi default, pi-subagents, pi-web-access, and session naming. This extension groups them into named profiles with two tiers each — **Sport** for the main session and **Eco** for subagents and tools — and switches between profiles without writing shared configuration, so other sessions keep their own models.

Install the package, run `/reload` once, then run `/profiles`.

```bash
pi install git:github.com/vimsucks/pi-model-profiles
```

## Profiles

Profiles live in `~/.pi/agent/model-profiles.json`. Every tier holds a fully qualified `provider/id`, so one profile can mix providers:

```json
{
  "default": "profile-1-gpt",
  "profiles": {
    "profile-1-gpt": {
      "sport": "cliproxyapi/gpt-6.1-sol",
      "eco": "cliproxyapi/gpt-6-luna",
      "sportThinking": "high",
      "ecoThinking": "low"
    },
    "profile-2-deepseek": { "sport": "opencode-go/deepseek-v4.1-pro", "eco": "opencode-go/deepseek-v4.1-flash" }
  }
}
```

The `default` profile is what a new session starts with. The file from the earlier `pi-switch-provider` package (`switch-provider.json`) is not read and can be deleted.

## Command

`/profiles` lists every profile, marks the default one, and offers two extra entries:

- **Pick a profile** to switch the current session. You can compact with the old model first; the switch happens only if compaction succeeds.
- **+ New profile…** asks for a model and optional thinking level per tier, then for a profile name. Profile names accept letters, digits, dots, underscores, and hyphens. It then asks whether to switch immediately. Choosing No saves the profile without changing the current model, thinking level, or Eco selection and does not offer compaction.
- **★ Set as default profile** changes which profile new sessions start with.

The command never writes `settings.json`, `web-search.json`, or any other package's configuration. The single exception is the pi-subagents allowlist described below.

## Thinking levels

Profile creation uses this order:

1. Select the Sport model, grouped by provider.
2. Select Sport thinking.
3. Select the Eco model, grouped by provider.
4. Select Eco thinking for subagents.
5. Enter the profile name.

The thinking picker defaults to **Do not override**. This choice leaves the optional `sportThinking` or `ecoThinking` field absent and leaves thinking to Pi or the subagent configuration. It differs from `off`, which explicitly disables thinking when the model supports that option. Models without reasoning skip the thinking picker. Each picker lists only the levels that Pi reports as supported for the selected model.

Sport thinking applies once when you switch profiles or when a new session applies the default profile. Later manual changes remain in effect. Eco thinking applies only when the extension supplies the default model for a `subagent` execution call.

Existing profiles without thinking fields keep their previous behavior. The extension does not migrate profiles or provide an editor for existing profiles. Unknown thinking values in manually edited profiles or snapshots are ignored. Pi handles capability changes through its native thinking-level clamping; pi-subagents still enforces its own limits. Saved choices are not rewritten when capabilities change, and global thinking defaults are not modified.

## Session behavior

- On `session_start` for a new or initial session with no saved profile, the default profile is applied through `pi.setModel()`, followed by Sport thinking if configured. A starting model that differs from the configured default means an explicit override such as `--model`, and the extension leaves it alone.
- Each successful profile selection saves its name, Sport/Eco models, and optional thinking levels in a session-local `model-profile` entry. These entries are excluded from model context. Reload, resume, fork, and tree navigation restore the latest valid snapshot on the active branch without changing the current main model or thinking level. Editing or deleting the shared profile definition does not change an existing snapshot. Select the profile again to use its current shared definition.
- A new session with no saved selection uses the default profile. Sessions created before this persistence support need one successful `/profiles` selection before reload can restore their profile.
- On `tool_call`, a `subagent` execution call with neither `action` nor `model` gets the Eco model with its configured thinking suffix, such as `provider/model:low`. Without `ecoThinking`, it gets only the model. An explicit model, with or without a thinking suffix, remains unchanged. A `fetch_content` call in `answer` mode without `answerModel` gets only the bare Eco model; Eco thinking does not apply to this tool.
- Subagent management calls that specify `action` do not receive an injected model. This avoids overriding the persisted child model on `action: "resume"`.
- Session naming, pi-background-tasks, and the Pi status line read the current session model, so they follow the profile without any extra configuration.

## Boundary

- pi-subagents paths that do not go through the `subagent` tool — the `/run` command, schedules, and background runs — keep the global `subagents.defaultModel`.
- pi-web-access summaries are generated inside the `search` tool, before any tool event fires. There is no session-level channel for `summaryModel`, so it keeps its configured value.
- Image models, Fusion multi-model tasks, and explicitly pinned run models do not follow a profile.

## pi-subagents allowlist

An enforced `subagents.modelScope` rejects models outside its `allow` list, which would block an Eco model from another provider. When `subagents.modelScope.enforce` is `true`, the extension widens `allow` to cover every profile's Eco model. The list only grows: it grants permission and never selects a model.

## Development

Run `pnpm install --frozen-lockfile` in the repository. Then run `pnpm test` to check profile creation, thinking selection, switching, session restoration, injection, and failure paths.
