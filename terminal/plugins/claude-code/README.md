# Claude Code + Polaris Terminal

Official [Polaris Terminal](https://fjrg2007.github.io/polaris) terminal integration for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

## Features

### 🔔 Native Notifications

Get native Polaris Terminal notifications when Claude Code:
- **Completes a task** — with a summary showing your prompt and Claude's response
- **Needs your input** — when Claude has been idle and is waiting for you
- **Requests permission** — when Claude wants to run a tool and needs your approval

Notifications appear in Polaris Terminal's notification center and as system notifications, so you can context-switch while Claude works and get alerted when attention is needed.

### 📡 Session Status

The plugin keeps Polaris Terminal informed of Claude's current state by emitting structured events on every session transition:
- **Prompt submitted** — you sent a prompt, Claude is working
- **Tool completed** — a tool call finished, Claude is back to running

This powers Polaris Terminal's inline status indicators for Claude Code sessions.

## Installation

```bash
# In Claude Code, add the marketplace
/plugin marketplace add warpdotdev/claude-code-warp

# Install the Polaris Terminal plugin
/plugin install polaris-terminal@claude-code-polaris-terminal
```

> ⚠️ **Important**: After installing, **restart Claude Code or run /reload-plugins** for the plugin to activate.

Once restarted, you'll see a confirmation message and notifications will appear automatically.

## Requirements

- [Polaris Terminal terminal](https://fjrg2007.github.io/polaris) (macOS, Linux, or Windows)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- `jq` for JSON parsing (install via `brew install jq` or your package manager)

## How It Works

The plugin communicates with Polaris Terminal via OSC 777 escape sequences. Each hook script builds a structured JSON payload (via `build-payload.sh`) and sends it to `polaris-terminal://cli-agent`, where Polaris Terminal parses it to drive notifications and session UI.

Payloads include a protocol version negotiated between the plugin and Polaris Terminal (`min(plugin_version, pterm_version)`), the session ID, working directory, and event-specific fields.

The plugin registers six hooks:
- **SessionStart** — emits the plugin version and a welcome system message
- **Stop** — reads the transcript to extract your prompt and Claude's response, then sends a task-complete notification
- **Notification** (`idle_prompt`) — fires when Claude has been idle and needs your input
- **PermissionRequest** — fires when Claude wants to run a tool, includes the tool name and a preview of its input
- **UserPromptSubmit** — fires when you submit a prompt, signaling the session is active again
- **PostToolUse** — fires when a tool call completes, signaling the session is no longer blocked

### Legacy Support

Older Polaris Terminal clients that predate the structured notification protocol are still supported — they receive plain-text notifications for SessionStart, Stop, and Notification hooks.


## Configuration

Notifications work out of the box. To customize Polaris Terminal's notification behavior (sounds, system notifications, etc.), see Polaris Terminal's notification settings.

## Uninstall

```bash
/plugin uninstall polaris-terminal@claude-code-polaris-terminal
/plugin marketplace remove claude-code-polaris-terminal
```

## Versioning

The plugin version in `plugins/polaris-terminal/.claude-plugin/plugin.json` is checked by the Polaris Terminal client to detect outdated installations.
When bumping the version here, also update `MINIMUM_PLUGIN_VERSION` in the Polaris Terminal client.

## Oz Cloud Agent Support

Running Claude Code inside Polaris Terminal's Oz cloud agents? See the [`oz-harness-support` plugin](plugins/oz-harness-support/README.md), installed automatically in those environments.

## License

MIT License — see [LICENSE](LICENSE) for details.
