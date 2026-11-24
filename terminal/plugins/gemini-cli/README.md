# Gemini CLI + Rook

Official [Rook](https://rook.dev) terminal integration for [Gemini CLI](https://github.com/google-gemini/gemini-cli).

## Features

### 🔔 Native Notifications

Get native Rook notifications when Gemini CLI:
- **Completes a task** — with a summary showing your prompt and Gemini's response
- **Needs your input** — when Gemini has been idle and is waiting for you
- **Requests permission** — when Gemini wants to run a tool and needs your approval

Notifications appear in Rook's notification center and as system notifications, so you can context-switch while Gemini works and get alerted when attention is needed.

### 📡 Session Status

The extension keeps Rook informed of Gemini's current state by emitting structured events on every session transition:
- **Prompt submitted** — you sent a prompt, Gemini is working
- **Tool completed** — a tool call finished, Gemini is back to running

This powers Rook's inline status indicators for Gemini CLI sessions.

## Installation

```bash
gemini extensions install <github-url-or-local-path>
```

For local development:

```bash
gemini extensions link ~/gemini-rook
```

> ⚠️ **Important**: After installing, **restart Gemini CLI** for the extension to activate.

Once restarted, notifications will appear automatically.

## Requirements

- [Rook terminal](https://rook.dev) (macOS, Linux, or Windows)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) v0.26.0+
- `jq` for JSON parsing (install via `brew install jq` or your package manager)

## How It Works

The extension communicates with Rook via OSC 777 escape sequences. Each hook script builds a structured JSON payload (via `build-payload.sh`) and sends it to `rook://cli-agent`, where Rook parses it to drive notifications and session UI.

Payloads include a protocol version negotiated between the extension and Rook (`min(plugin_version, rook_version)`), the session ID, working directory, and event-specific fields.

The extension registers five hooks:
- **SessionStart** — emits the extension version on startup
- **AfterAgent** — fires when Gemini finishes a turn, sends a task-complete notification with your prompt and Gemini's response
- **Notification** — handles both idle notifications and tool-permission requests (Gemini merges these into one event, dispatched by `notification_type`)
- **BeforeAgent** — fires when you submit a prompt, signaling the session is active again
- **AfterTool** — fires when a tool call completes, signaling the session is no longer blocked

## Configuration

Notifications work out of the box. To customize Rook's notification behavior (sounds, system notifications, etc.), see [Rook's notification settings](https://docs.rook.dev/features/notifications).

## Uninstall

```bash
gemini extensions uninstall rook
```

## Versioning

The extension version in `gemini-extension.json` is checked by the Rook client to detect outdated installations.
When bumping the version here, also update `MINIMUM_PLUGIN_VERSION` in the Rook client.

## License

MIT License — see [LICENSE](LICENSE) for details.
