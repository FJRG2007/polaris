# APP-4087: Fix Polaris Terminal skill and MCP home config paths after watcher unification Product Spec
## Summary
The immediate regression is that `oz agent run --skill <name>` no longer finds Polaris Terminal skills stored in Polaris Terminal’s home-relative config directory on Linux and Windows. APP-3945 intentionally centralized Polaris Terminal-owned filesystem watching to avoid recursively watching `.polaris/terminal*/worktrees`, but it also tied Polaris Terminal skill lookup to platform app data paths. That works on macOS because Polaris Terminal’s app data path is home-relative and channel-aware, but it breaks non-macOS users because app data follows XDG/AppData conventions instead of Polaris Terminal’s `.polaris/terminal*` home config directory convention.
Fixing the skill regression led us to audit other Polaris Terminal-owned home config paths affected by the same watcher unification. MCP has the same shape: Polaris Terminal’s file-based MCP config should live next to other home-relative Polaris Terminal config for the current app environment. APP-4087 should restore those environment-aware home paths without undoing APP-3945’s worktree-watch safety.
## Problem
Before APP-3945, Polaris Terminal skill discovery could find skills in Polaris Terminal’s home config directory, such as `~/.polaris-terminal/skills`. After APP-3945, `SkillProvider::Polaris Terminal` stopped going through generic home-provider watching and instead relied on the centralized Polaris Terminal watcher and app data paths. That prevented broad recursive watches under `~/.polaris-terminal`, which was intended, but it also meant that home-relative Polaris Terminal skill directories stopped being considered when app data was somewhere else.
Linux and Windows expose the bug because their app data directories differ from Polaris Terminal’s home-relative `.polaris/terminal*` config directories. A Stable user can therefore have a valid skill at `~/.polaris-terminal/skills/foo/SKILL.md`, run `oz agent run --skill foo`, and see the skill fail to resolve because the resolver and watcher are looking in the platform app data directory.
macOS hides most of this because Stable and Preview commonly resolve app data to `~/.polaris-terminal`, while Dev and Local resolve to environment-specific home directories such as `~/.polaris-terminal-dev` and `~/.polaris-terminal-local`. The desired behavior is not simply “always use `~/.polaris-terminal`”; it is “use the home-relative Polaris Terminal config directory for the current Polaris Terminal app environment.”
While investigating Skills, we checked MCP because its global config has the same shape. Polaris Terminal MCP config should use the same environment-aware home config directory as Skills, e.g. `~/.polaris-terminal/.mcp.json`, `~/.polaris-terminal-dev/.mcp.json`, or `~/.polaris-terminal-local/.mcp.json` depending on channel/profile.
## Goals
- Preserve the APP-3945 invariant that Polaris Terminal does not recursively watch `.polaris/terminal*/worktrees`.
- Restore `oz --skill <name>` resolution for Polaris Terminal home skills on Linux, Windows, and macOS.
- Preserve environment isolation for Dev, Local, Integration, OpenPterm, and development profiles.
- Use a single purpose-specific home config path helper for Polaris Terminal Skills and MCP.
- Keep `data_dir()` and `config_local_dir()` for their existing app-managed configuration responsibilities.
- Keep Polaris Terminal-specific filesystem watching centralized instead of reintroducing ad hoc recursive watchers in `SkillWatcher` or `FileMCPWatcher`.
## Non-goals
- Changing the public skill file format or MCP config schema.
- Changing project-level skill or MCP discovery.
- Migrating existing files between platform app data directories and home-relative `.polaris/terminal*` directories.
- Treating non-macOS XDG/AppData `data_dir()/skills` or `data_dir()/.mcp.json` as Polaris Terminal Skills or MCP sources of truth.
- Changing non-Polaris Terminal provider paths such as `~/.agents/skills`, `~/.claude/skills`, `~/.codex/config.toml`, or project provider paths.
- Introducing a generic filtering API in `repo_metadata::DirectoryWatcher`.
## Figma / design references
Figma: none provided.
## User Experience
### Polaris Terminal home skills
- A Stable user can store a skill at `~/.polaris-terminal/skills/<skill-name>/SKILL.md`.
- Dev, Local, Integration, OpenPterm, and profiled builds use their own home-relative Polaris Terminal config directories, such as `~/.polaris-terminal-dev/skills`, `~/.polaris-terminal-local/skills`, or `~/.polaris-terminal-local-<profile>/skills`.
- Running `oz agent run --skill <skill-name> ...` resolves the skill from the current app environment’s Polaris Terminal home skills directory even when platform app data is elsewhere.
- Polaris Terminal home skill resolution continues to take precedence over project skill resolution for unqualified skill names.
- The resolver must not require the asynchronous `SkillManager` cache or filesystem watcher to be warmed before `oz --skill` works.
### Polaris Terminal home MCP config
- A user can configure file-based MCP servers for the current Polaris Terminal app environment at `<polaris-terminal-home-config-dir>/.mcp.json`.
- Examples include `~/.polaris-terminal/.mcp.json`, `~/.polaris-terminal-dev/.mcp.json`, and `~/.polaris-terminal-local/.mcp.json`.
- When the MCP file is created, edited, moved into place, or deleted, Polaris Terminal updates detected file-based MCP servers without requiring a restart, as long as the relevant parent path is watchable.
- Polaris Terminal MCP config is scoped as a user-level config, not as a project config or platform app-data config.
### Worktree exclusion
- Activity under `.polaris/terminal*/worktrees` must not trigger reloads for themes, workflows, tab configs, settings, skills, or MCP config.
- Supporting Polaris Terminal home skills must not be implemented by recursively watching all possible `.polaris/terminal*` directories.
- Supporting Polaris Terminal home MCP config must not be implemented by recursively watching all possible `.polaris/terminal*` directories.
### Existing app paths
- Channel-aware app files under `data_dir()` continue to work as before for non-Skills/MCP app config.
- `data_dir()` remains the root for channel-scoped themes, workflows, launch configs, tab configs, and other app-managed files.
- `config_local_dir()` remains the root for platform-specific config files such as `settings.toml`, `keybindings.yaml`, and `user_preferences.json`.
## Success Criteria
- `oz agent run --skill <name>` can resolve `<polaris-terminal-home-config-dir>/skills/<name>/SKILL.md` from a cold start.
- Skill resolution still finds project skills when no matching Polaris Terminal home skill exists.
- Polaris Terminal home skills still take precedence over project skills for unqualified skill names.
- File-based MCP detection includes `<polaris-terminal-home-config-dir>/.mcp.json` as a user-scoped Polaris Terminal provider config when present.
- Dev/Local/Profiled builds use isolated `.polaris/terminal*` home config directories instead of Stable’s `~/.polaris-terminal` directory.
- No code path treats non-macOS XDG/AppData `data_dir()/skills` or `data_dir()/.mcp.json` as Polaris Terminal home Skills or MCP sources.
- No code path reintroduces a generic recursive watcher rooted at `~/.polaris-terminal`.
- `.polaris/terminal*/worktrees` changes remain excluded from Polaris Terminal-managed reload behavior.
## Validation
- Add or update unit coverage for `oz --skill` resolving a skill from an explicit Polaris Terminal home skills directory.
- Add or update unit coverage for Polaris Terminal home config path helper behavior.
- Add or update unit coverage for MCP path classification so `<polaris-terminal-home-config-dir>/.mcp.json` is recognized as a Polaris Terminal MCP config path.
- Add or update watcher helper tests to verify managed Skills/MCP helpers return the current environment’s Polaris Terminal home paths.
- Add or update skill utility tests so only the current environment’s Polaris Terminal home skills directory is classified as home Polaris Terminal skills.
- Run targeted Rust tests for path helpers, skill resolution, skill file watcher utilities, MCP provider/path helpers, and Polaris Terminal managed path filtering.
## Alternatives Considered
- Use only hardcoded `~/.polaris-terminal` for Skills/MCP. Rejected because it loses Dev/Local/Profile environment isolation.
- Keep using `data_dir()` for Skills/MCP. Rejected because non-macOS app data paths are XDG/AppData paths, not Polaris Terminal’s home-relative `.polaris/terminal*` config paths.
- Use `config_local_dir()` for Skills/MCP. Rejected because non-macOS config-local paths are also platform project directories, not home-relative `.polaris/terminal*` paths.
- Add only a resolver fallback for `oz --skill`. Rejected because it fixes cold CLI resolution but leaves app hot reload, skill discovery, and MCP path behavior inconsistent.
- Re-add Polaris Terminal to generic home-provider watchers. Rejected because that watcher shape can recursively watch `.polaris/terminal*` parents and reintroduce `.polaris/terminal*/worktrees` churn.
- Watch all of `~/.polaris-terminal` recursively and filter in consumers. Rejected because it recreates the broad watcher shape APP-3945 was designed to remove.
## Open Questions
- Should Polaris Terminal proactively create the current environment’s Polaris Terminal home config directory on startup, or only watch it when it already exists? The implementation should prefer the least invasive approach unless product explicitly wants fresh installs to create these paths.
