#!/bin/bash
# Builds a structured rook://cli-agent payload and delivers it, in one jq call.
#
# Hooks run on Claude Code's critical path: PostToolUse fires after every single
# tool call, UserPromptSubmit before every prompt. What they cost is paid by the
# user watching the agent work, so this file exists to keep that cost to one
# process.
#
# The shape it replaced built each payload with five separate jq invocations
# (session_id, cwd, basename, the payload itself, then the terminalSequence
# wrapper) and handed off to a second bash process to emit it. Measured on
# Windows, where process creation is expensive and Git Bash adds its own
# overhead, that came to roughly 412 ms per tool call against 27 ms for bash
# alone and 40 ms for one jq. Everything here is one bash and one jq.
#
# Usage:
#   source "$SCRIPT_DIR/emit-event.sh"
#   emit_event - "tool_complete" '{tool_name: (.tool_name // "")}'
#
# Pass `-` as the input to let jq read the hook's stdin itself. A hook that only
# needs its input once should: capturing it costs a subshell and a `cat`, which
# is measurable next to the two processes this otherwise takes.
#
# The third argument is a jq expression producing an object, merged over the
# common fields. Deriving values there rather than with another jq call is what
# keeps this to one process; an `event` key in it overrides the second argument,
# which is how a hook whose event name depends on its input sets it.
#
# Only that expression contributes fields. jq arguments after it are available
# to it as $name but are not merged in on their own, so passing one to compute
# with cannot accidentally put it in the payload.

# The protocol version this plugin knows how to produce.
PLUGIN_CURRENT_PROTOCOL_VERSION=1

# The first Claude Code version that accepts a `terminalSequence` hook output.
# Older versions reject unknown fields (a Stop hook fails outright), so they get
# the sequence written to /dev/tty instead.
TERMINAL_SEQUENCE_MIN_VERSION_MAJOR=2
TERMINAL_SEQUENCE_MIN_VERSION_MINOR=1
TERMINAL_SEQUENCE_MIN_VERSION_PATCH=141

# Whether the running Claude Code accepts `terminalSequence`. Pure bash: no
# subprocess, because this is consulted on every hook.
_supports_terminal_sequence() {
    local raw="${CLAUDE_CODE_VERSION:-}"
    [ -z "$raw" ] && return 2 # Unknown: the caller decides what to try.

    # Take the first x.y.z out of whatever form the version arrived in.
    [[ "$raw" =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]] || return 2
    local major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" patch="${BASH_REMATCH[3]}"

    ((major > TERMINAL_SEQUENCE_MIN_VERSION_MAJOR)) && return 0
    ((major < TERMINAL_SEQUENCE_MIN_VERSION_MAJOR)) && return 1
    ((minor > TERMINAL_SEQUENCE_MIN_VERSION_MINOR)) && return 0
    ((minor < TERMINAL_SEQUENCE_MIN_VERSION_MINOR)) && return 1
    ((patch >= TERMINAL_SEQUENCE_MIN_VERSION_PATCH))
}

# The jq program: build the payload, render it into an OSC 777 sequence, and
# either wrap it for Claude Code's stdout or leave it bare for /dev/tty.
#
# `project` is derived here rather than by shelling out to basename, and
# backslashes are folded first so a Windows cwd yields the same name a POSIX one
# would.
_EMIT_EVENT_JQ_PROGRAM='
    ({
        v: $v,
        agent: $agent,
        event: $event,
        session_id: (.session_id // ""),
        cwd: (.cwd // ""),
        project: ((.cwd // "") | gsub("\\\\"; "/") | split("/")
                  | map(select(length > 0)) | last // "")
    } + (EXTRA_FIELDS))
    | tojson as $body
    | "\u001b]777;notify;" + $sentinel + ";" + $body + "\u0007"
    | if $wrap then {terminalSequence: .} else . end
'

# Which agent this plugin integrates. Each plugin sets it before sourcing.
: "${ROOK_PLUGIN_AGENT:=claude}"

# The sentinel this plugin sends. Rook accepts the upstream one as well, so a
# plugin built against upstream keeps working, but a plugin shipped with Rook
# names Rook.
ROOK_CLI_AGENT_SENTINEL="rook://cli-agent"

# Feeds jq: either the captured input, or the caller's stdin untouched.
_emit_feed() {
    if [ "$1" = "-" ]; then cat; else printf '%s' "$1"; fi
}

emit_event() {
    local input="$1" event="$2" extra="${3:-{\}}"
    shift 3
    local program="${_EMIT_EVENT_JQ_PROGRAM/EXTRA_FIELDS/$extra}"

    # Negotiate down to whatever the terminal advertises, defaulting to 1.
    local protocol_version="${ROOK_CLI_AGENT_PROTOCOL_VERSION:-1}"
    case "$protocol_version" in
        '' | *[!0-9]*) protocol_version=$PLUGIN_CURRENT_PROTOCOL_VERSION ;;
    esac
    ((protocol_version > PLUGIN_CURRENT_PROTOCOL_VERSION)) &&
        protocol_version=$PLUGIN_CURRENT_PROTOCOL_VERSION

    _supports_terminal_sequence
    local support=$?

    if [ "$support" -eq 0 ]; then
        # Known-new Claude Code: hand the sequence back on stdout.
        _emit_feed "$input" | jq -c \
            --argjson v "$protocol_version" \
            --arg event "$event" \
            --arg agent "$ROOK_PLUGIN_AGENT" \
            --arg sentinel "$ROOK_CLI_AGENT_SENTINEL" \
            --argjson wrap true \
            "$@" "$program"
        return 0
    fi

    if [ "$support" -eq 1 ]; then
        # Known-old Claude Code: /dev/tty is the only field it will not reject.
        _emit_feed "$input" | jq -j \
            --argjson v "$protocol_version" \
            --arg event "$event" \
            --arg agent "$ROOK_PLUGIN_AGENT" \
            --arg sentinel "$ROOK_CLI_AGENT_SENTINEL" \
            --argjson wrap false \
            "$@" "$program" > /dev/tty 2>/dev/null || true
        return 0
    fi

    # Version unknown: prefer /dev/tty, and fall back to stdout when there is no
    # controlling terminal. Both branches are still a single jq.
    if [ -w /dev/tty ]; then
        _emit_feed "$input" | jq -j \
            --argjson v "$protocol_version" \
            --arg event "$event" \
            --arg agent "$ROOK_PLUGIN_AGENT" \
            --arg sentinel "$ROOK_CLI_AGENT_SENTINEL" \
            --argjson wrap false \
            "$@" "$program" > /dev/tty 2>/dev/null && return 0
    fi

    _emit_feed "$input" | jq -c \
        --argjson v "$protocol_version" \
        --arg event "$event" \
            --arg agent "$ROOK_PLUGIN_AGENT" \
        --arg sentinel "$ROOK_CLI_AGENT_SENTINEL" \
        --argjson wrap true \
        "$@" "$program"
}
