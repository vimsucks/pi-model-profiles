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
    "profile-1-gpt": { "sport": "cliproxyapi/gpt-6.1-sol", "eco": "cliproxyapi/gpt-6-luna" },
    "profile-2-deepseek": { "sport": "opencode-go/deepseek-v4.1-pro", "eco": "opencode-go/deepseek-v4.1-flash" }
  }
}
```

The `default` profile is what a new session starts with. The file from the earlier `pi-switch-provider` package (`switch-provider.json`) is not read and can be deleted.

## Command

`/profiles` lists every profile, marks the default one, and offers two extra entries:

- **Pick a profile** to switch the current session. You can compact with the old model first; the switch happens only if compaction succeeds.
- **+ New profile…** asks for a provider and a model per tier, then for a profile name. Model names accept letters, digits, dots, underscores, and hyphens.
- **★ Set as default profile** changes which profile new sessions start with.

The command never writes `settings.json`, `web-search.json`, or any other package's configuration. The single exception is the pi-subagents allowlist described below.

## Session behavior

- On `session_start` for a new or initial session with no saved profile, the default profile is applied through `pi.setModel()`. A starting model that differs from the configured default means an explicit override such as `--model`, and the extension leaves it alone.
- Each successful profile selection saves its name and Sport/Eco snapshot in a session-local `model-profile` entry. These entries are excluded from model context. Reload, resume, fork, and tree navigation restore the latest valid snapshot on the active branch without changing the current main model. Editing or deleting the shared profile definition does not change an existing snapshot.
- A new session with no saved selection uses the default profile. Sessions created before this persistence support need one successful `/profiles` selection before reload can restore their profile.
- On `tool_call`, a `subagent` call without a `model` gets the Eco model, and a `fetch_content` call in `answer` mode without `answerModel` gets the Eco model. An explicit model on the call always wins.
- Session naming, pi-background-tasks, and the Pi status line read the current session model, so they follow the profile without any extra configuration.

## Boundary

- pi-subagents paths that do not go through the `subagent` tool — the `/run` command, schedules, and background runs — keep the global `subagents.defaultModel`.
- pi-web-access summaries are generated inside the `search` tool, before any tool event fires. There is no session-level channel for `summaryModel`, so it keeps its configured value.
- Image models, Fusion multi-model tasks, and explicitly pinned run models do not follow a profile.

## pi-subagents allowlist

An enforced `subagents.modelScope` rejects models outside its `allow` list, which would block an Eco model from another provider. When `subagents.modelScope.enforce` is `true`, the extension widens `allow` to cover every profile's Eco model. The list only grows: it grants permission and never selects a model.

## Development

Run `pnpm test` in the repository to check switching, session startup, injection, and failure paths.
