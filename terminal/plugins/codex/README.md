# Codex + Rook
Rook terminal integration for [OpenAI Codex](https://developers.openai.com/codex/cli).
This repo is a native Codex plugin marketplace for local/dev and Oz cloud-agent installs.
## Layout
```
.agents/plugins/marketplace.json          Codex marketplace manifest, name: codex-rook
.github/workflows/test.yml                GitHub Actions shell test workflow
plugins/rook/.codex-plugin/plugin.json    Rook notification plugin manifest
plugins/rook/hooks/hooks.json             Rook notification hook config
plugins/rook/scripts/                     Rook notification hook scripts only
plugins/orchestration/.codex-plugin/plugin.json
plugins/orchestration/hooks/hooks.json
plugins/orchestration/scripts/            Oz parent-message listener, drain, and lifecycle scripts
plugins/orchestration/skills/             Oz orchestration skills
tests/test-hooks.sh                       Shell tests
```
## Plugins
- `rook`: `SessionStart`, `Stop`, `PermissionRequest`, `UserPromptSubmit`, `PostToolUse` notifications for Rook.
- `orchestration`: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd` parent-message delivery for Codex child runs, plus Oz skills.
Hook commands use `${PLUGIN_ROOT}/scripts/...`.
## Local install
```sh
codex plugin marketplace add .
codex plugin add rook@codex-rook
codex plugin add orchestration@codex-rook
```
## Testing
Fast shell suite:
```sh
bash tests/test-hooks.sh
```
This uses a fake `oz` CLI and a temp `CODEX_HOME`.
It validates parent-message staging/drain/blocking and plugin manifests.
## Versioning
`plugins/rook/scripts/on-session-start.sh` emits `PLUGIN_VERSION`.
Current plugin version: `0.4.0`.
Keep it in sync with Rook's Codex plugin manager minimum version.
## Skills

`plugins/orchestration/skills/factory-files` is a byte-for-byte copy of
`resources/bundled/skills/factory-files` in
[FJRG2007/rook](https://github.com/FJRG2007/rook), mirrored at commit
`f6f4ceac8`. Rook bundles that skill for its own clients; Codex loads filesystem
skills from this plugin instead, so it is copied here rather than resolved
from a bundle. Change it in `FJRG2007/rook` and re-mirror; edits made here
are lost on the next sync.

The skill validates only against rook-server, which owns the Factory file
format. It carries no copy of that format: a bundled copy ships inside a
release, goes stale, and then reports valid fields as unknown, which invites an
agent to delete working configuration. When the server cannot be reached the
skill reports that the tree was not checked rather than guessing.

That also keeps this mirror cheap. There is no schema here to drift, so a stale
copy costs a stale workflow document, not a wrong verdict.
`plugins/orchestration/tests/test-factory-files.sh` checks the copy arrived
complete, carries no schemas, and reports a missing verdict correctly; its
behavioural corpus lives in Rook.

## Requirements
- Codex CLI with plugin support
- `jq`
## License
MIT — see [LICENSE](LICENSE).
