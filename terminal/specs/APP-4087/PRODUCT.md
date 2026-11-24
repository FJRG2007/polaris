# APP-4087: Fix Rook skill and MCP home config paths after watcher unification Product Spec
## Summary
The immediate regression is that `oz agent run --skill <name>` no longer finds Rook skills stored in Rook’s home-relative config directory on Linux and Windows. APP-3945 intentionally centralized Rook-owned filesystem watching to avoid recursively watching `.rook*/worktrees`, but it also tied Rook skill lookup to platform app data paths. That works on macOS because Rook’s app data path is home-relative and channel-aware, but it breaks non-macOS users because app data follows XDG/AppData conventions instead of Rook’s `.rook*` home config directory convention.
Fixing the skill regression led us to audit other Rook-owned home config paths affected by the same watcher unification. MCP has the same shape: Rook’s file-based MCP config should live next to other home-relative Rook config for the current app environment. APP-4087 should restore those environment-aware home paths without undoing APP-3945’s worktree-watch safety.
## Problem
Before APP-3945, Rook skill discovery could find skills in Rook’s home config directory, such as `~/.rook/skills`. After APP-3945, `SkillProvider::Rook` stopped going through generic home-provider watching and instead relied on the centralized Rook watcher and app data paths. That prevented broad recursive watches under `~/.rook`, which was intended, but it also meant that home-relative Rook skill directories stopped being considered when app data was somewhere else.
Linux and Windows expose the bug because their app data directories differ from Rook’s home-relative `.rook*` config directories. A Stable user can therefore have a valid skill at `~/.rook/skills/foo/SKILL.md`, run `oz agent run --skill foo`, and see the skill fail to resolve because the resolver and watcher are looking in the platform app data directory.
macOS hides most of this because Stable and Preview commonly resolve app data to `~/.rook`, while Dev and Local resolve to environment-specific home directories such as `~/.rook-dev` and `~/.rook-local`. The desired behavior is not simply “always use `~/.rook`”; it is “use the home-relative Rook config directory for the current Rook app environment.”
While investigating Skills, we checked MCP because its global config has the same shape. Rook MCP config should use the same environment-aware home config directory as Skills, e.g. `~/.rook/.mcp.json`, `~/.rook-dev/.mcp.json`, or `~/.rook-local/.mcp.json` depending on channel/profile.
## Goals
- Preserve the APP-3945 invariant that Rook does not recursively watch `.rook*/worktrees`.
- Restore `oz --skill <name>` resolution for Rook home skills on Linux, Windows, and macOS.
- Preserve environment isolation for Dev, Local, Integration, OpenRook, and development profiles.
- Use a single purpose-specific home config path helper for Rook Skills and MCP.
- Keep `data_dir()` and `config_local_dir()` for their existing app-managed configuration responsibilities.
- Keep Rook-specific filesystem watching centralized instead of reintroducing ad hoc recursive watchers in `SkillWatcher` or `FileMCPWatcher`.
## Non-goals
- Changing the public skill file format or MCP config schema.
- Changing project-level skill or MCP discovery.
- Migrating existing files between platform app data directories and home-relative `.rook*` directories.
- Treating non-macOS XDG/AppData `data_dir()/skills` or `data_dir()/.mcp.json` as Rook Skills or MCP sources of truth.
- Changing non-Rook provider paths such as `~/.agents/skills`, `~/.claude/skills`, `~/.codex/config.toml`, or project provider paths.
- Introducing a generic filtering API in `repo_metadata::DirectoryWatcher`.
## Figma / design references
Figma: none provided.
## User Experience
### Rook home skills
- A Stable user can store a skill at `~/.rook/skills/<skill-name>/SKILL.md`.
- Dev, Local, Integration, OpenRook, and profiled builds use their own home-relative Rook config directories, such as `~/.rook-dev/skills`, `~/.rook-local/skills`, or `~/.rook-local-<profile>/skills`.
- Running `oz agent run --skill <skill-name> ...` resolves the skill from the current app environment’s Rook home skills directory even when platform app data is elsewhere.
- Rook home skill resolution continues to take precedence over project skill resolution for unqualified skill names.
- The resolver must not require the asynchronous `SkillManager` cache or filesystem watcher to be warmed before `oz --skill` works.
### Rook home MCP config
- A user can configure file-based MCP servers for the current Rook app environment at `<rook-home-config-dir>/.mcp.json`.
- Examples include `~/.rook/.mcp.json`, `~/.rook-dev/.mcp.json`, and `~/.rook-local/.mcp.json`.
- When the MCP file is created, edited, moved into place, or deleted, Rook updates detected file-based MCP servers without requiring a restart, as long as the relevant parent path is watchable.
- Rook MCP config is scoped as a user-level config, not as a project config or platform app-data config.
### Worktree exclusion
- Activity under `.rook*/worktrees` must not trigger reloads for themes, workflows, tab configs, settings, skills, or MCP config.
- Supporting Rook home skills must not be implemented by recursively watching all possible `.rook*` directories.
- Supporting Rook home MCP config must not be implemented by recursively watching all possible `.rook*` directories.
### Existing app paths
- Channel-aware app files under `data_dir()` continue to work as before for non-Skills/MCP app config.
- `data_dir()` remains the root for channel-scoped themes, workflows, launch configs, tab configs, and other app-managed files.
- `config_local_dir()` remains the root for platform-specific config files such as `settings.toml`, `keybindings.yaml`, and `user_preferences.json`.
## Success Criteria
- `oz agent run --skill <name>` can resolve `<rook-home-config-dir>/skills/<name>/SKILL.md` from a cold start.
- Skill resolution still finds project skills when no matching Rook home skill exists.
- Rook home skills still take precedence over project skills for unqualified skill names.
- File-based MCP detection includes `<rook-home-config-dir>/.mcp.json` as a user-scoped Rook provider config when present.
- Dev/Local/Profiled builds use isolated `.rook*` home config directories instead of Stable’s `~/.rook` directory.
- No code path treats non-macOS XDG/AppData `data_dir()/skills` or `data_dir()/.mcp.json` as Rook home Skills or MCP sources.
- No code path reintroduces a generic recursive watcher rooted at `~/.rook`.
- `.rook*/worktrees` changes remain excluded from Rook-managed reload behavior.
## Validation
- Add or update unit coverage for `oz --skill` resolving a skill from an explicit Rook home skills directory.
- Add or update unit coverage for Rook home config path helper behavior.
- Add or update unit coverage for MCP path classification so `<rook-home-config-dir>/.mcp.json` is recognized as a Rook MCP config path.
- Add or update watcher helper tests to verify managed Skills/MCP helpers return the current environment’s Rook home paths.
- Add or update skill utility tests so only the current environment’s Rook home skills directory is classified as home Rook skills.
- Run targeted Rust tests for path helpers, skill resolution, skill file watcher utilities, MCP provider/path helpers, and Rook managed path filtering.
## Alternatives Considered
- Use only hardcoded `~/.rook` for Skills/MCP. Rejected because it loses Dev/Local/Profile environment isolation.
- Keep using `data_dir()` for Skills/MCP. Rejected because non-macOS app data paths are XDG/AppData paths, not Rook’s home-relative `.rook*` config paths.
- Use `config_local_dir()` for Skills/MCP. Rejected because non-macOS config-local paths are also platform project directories, not home-relative `.rook*` paths.
- Add only a resolver fallback for `oz --skill`. Rejected because it fixes cold CLI resolution but leaves app hot reload, skill discovery, and MCP path behavior inconsistent.
- Re-add Rook to generic home-provider watchers. Rejected because that watcher shape can recursively watch `.rook*` parents and reintroduce `.rook*/worktrees` churn.
- Watch all of `~/.rook` recursively and filter in consumers. Rejected because it recreates the broad watcher shape APP-3945 was designed to remove.
## Open Questions
- Should Rook proactively create the current environment’s Rook home config directory on startup, or only watch it when it already exists? The implementation should prefer the least invasive approach unless product explicitly wants fresh installs to create these paths.
