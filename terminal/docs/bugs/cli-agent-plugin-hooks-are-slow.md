# The CLI-agent plugin makes everything slower

**Symptom.** Installing the CLI-agent integration makes the terminal and the agent noticeably worse: every tool call pauses, prompts take a moment to register, and starting the agent takes far longer than it should.

Applies to the Claude Code, Codex and Gemini CLI plugins, which share one implementation.

## Evidence

Timed on the machine this was diagnosed on, invoking each hook the way Claude Code does:

| Hook | Fires | Cost | `jq` calls |
| --- | --- | --- | --- |
| `on-post-tool-use` | after **every tool call** | 412 ms | 6 |
| `on-prompt-submit` | every prompt | 404 ms | 6 |
| `on-session-start` | starting `claude` | 386 ms | 7 |
| `on-stop` | end of every turn | 757 ms | 9 |

For scale on the same machine: bash starts in 27 ms and one `jq` costs 40 ms.

A turn with twenty tool calls therefore spent around **9.4 seconds** in hooks alone, none of it doing anything the user asked for.

The same hook cost 79 ms when the terminal's environment variables were absent, because it exits early. So it was at its slowest precisely when running inside the terminal it integrates with.

## Cause

Four separate things, all of them process count.

**Five `jq` invocations to build one payload.** `build_payload` extracted `session_id`, then `cwd`, then shelled out to `basename` for the project name, then ran `jq -nc` to assemble the object, and `emit_terminal_sequence` ran `jq` again to wrap it. Each hook also ran its own `jq` for its own fields, and read stdin through `$(cat)`.

**A second bash process per notification.** Hooks handed off to `warp-notify.sh`, which re-sourced the same two helper files the caller had already sourced.

**`claude --version` on session start.** To decide how to deliver the escape sequence, `on-session-start.sh` started the entire Claude Code binary to read a version string, on the path the user is waiting on.

**The transcript read twice, whole.** `on-stop` ran two `jq -rs` passes over the transcript. `-s` slurps: it materialises the entire JSONL history as one array before the filter runs, so every turn paid for the whole session's history, twice, and the cost grew as the session went on.

On Windows all of this is much worse than the numbers upstream would see: process creation is expensive, and Git Bash adds its own startup on top.

## Fix

One bash process and one `jq` per hook.

`emit-event.sh` replaces `build-payload.sh`, `warp-notify.sh` and `emit-terminal-sequence.sh`. A single `jq` program builds the payload, derives the project name from `cwd` (folding backslashes so a Windows path gives the same answer), renders the OSC 777 sequence and wraps it for Claude Code's stdout. Each hook contributes its own fields as a `jq` expression merged into that same program, so no hook needs a second process to compute anything. Passing `-` as the input lets `jq` read the hook's stdin directly, which drops the `$(cat)` subshell too.

The Claude Code version check is now pure bash pattern matching rather than `grep` and subshells, and `claude --version` only runs when there is somewhere to cache the answer.

`transcript-tail.sh` reads the transcript once, streaming with `inputs` instead of slurping, and returns both fields.

### Result

| Hook | Before | After |
| --- | --- | --- |
| `on-post-tool-use` | 412 ms | **97 ms** |
| `on-prompt-submit` | 404 ms | **101 ms** |
| `on-notification` | ~400 ms | **96 ms** |
| `on-permission-request` | ~400 ms | **103 ms** |
| `on-session-start` | 386 ms | **126 ms** |
| `on-stop` | 757 ms | **500 ms** |

The floor for a shell hook on this machine - bash, reading stdin, one `jq` - measures 89 ms, so the hot hooks are within about 10 ms of what a hook can cost at all.

## What this does not cover

`on-stop` keeps a deliberate `sleep 0.3`. The Stop hook fires before Claude Code has flushed the turn to the transcript, so removing it would mean reporting the previous turn's text. That wait is 300 of its remaining 500 ms.

The remaining ~90 ms is process creation, and no amount of shell restructuring removes it. Getting below it means not being a shell script.

## The other integrations

Upstream publishes five CLI-agent integrations. All of them are in `plugins/` now:

| Plugin | State |
| --- | --- |
| Claude Code | Shell hooks, same bug, fixed |
| Codex | Shell hooks, same bug (364 ms measured), fixed - 100 ms |
| Gemini CLI | Shell hooks, same bug, fixed - 95 ms |
| OpenCode | TypeScript, runs in-process and spawns nothing. Never had this bug and needed no change |
| Antigravity CLI | The repository holds one commit and no files. There is nothing to bring in yet |

Codex and Gemini share the Claude Code implementation, so they take the same emitter with the agent name passed in rather than hardcoded.

## Only Rook's own plugins are accepted

`is_cli_agent_notification` recognises Rook's sentinel and nothing else, and the terminal exports only its own environment variable names. An upstream plugin therefore neither activates nor is listened to.

That is deliberate. Those plugins carry the per-hook cost measured above, and accepting them would leave a user paying it with no indication why. The client installs Rook's copies from this repository through the marketplace manifest at the root.
