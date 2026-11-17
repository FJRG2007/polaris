/**
 * The shell side of an Agent Client Protocol pipe: an agent held in a tmux
 * window whose standard input and output are files beside the checkout.
 *
 * Polaris reaches a session's machine one command at a time (`runInSession`),
 * so the agent cannot simply be a child process with pipes. Instead the launch
 * script starts it with its stdin fed from `in` (through `tail -f` and a FIFO,
 * so appending to the file is writing to the agent) and its stdout written to
 * `out`. Writing a frame is appending to `in`; reading is asking for the bytes
 * of `out` after an offset. Every launch truncates both and writes a new
 * `generation`, so a reader or writer still holding the last agent's offset
 * notices and stops rather than mixing two conversations.
 *
 * Everything here is pure: what runs on the machine is built and parsed here
 * and tested as text.
 */

import { z } from "zod";
import { shellQuote } from "../session-hooks";
import * as commands from "../session-commands";
import { isVendorSessionId } from "@polaris/core";

/** The tmux window the agent runs in, beside the runner. */
export const ACP_WINDOW = "polaris-acp";

/**
 * The most raw bytes one read hands back. Base64 makes it about 14.7 KB, under
 * the 15 KiB a command's output is kept to (`CAPTURE_BYTES`): the host daemon
 * cuts an answer at 16 KiB, silently.
 */
export const ACP_READ_BYTES = 11_000;

/**
 * The most raw bytes one write carries. A container's command travels as a
 * single argument, and Linux holds one argument to 128 KiB; base64 of this is
 * 64 KiB, with room for the rest of the command.
 */
export const ACP_WRITE_BYTES = 48 * 1024;

/** What the read and write commands exit with when there is no agent, or a
 *  different one from the generation the caller holds. */
export const ACP_NOT_RUNNING = 3;

/** What a launch exits with, having started nothing, when the session's
 *  terminal took it back from Chat since (`TERMINAL_BACK_FILE`). */
export const ACP_TERMINAL_BACK = 4;

/** Written by the terminal's waiting script once the terminal has the
 *  conversation back (`acp/handoff.ts`), and cleared when the session goes to
 *  Chat again. While it is there no protocol agent may start: it would stop
 *  the agent the person is typing to. */
export const TERMINAL_BACK_FILE = "terminal-back";

/** The lock the two ways an agent starts in a Chat session take - a launch
 *  here, the terminal's key in the waiting script - so they never interleave. */
export const AGENT_LOCK_FILE = "agent-lock";

/**
 * Take the session's agent lock, held until the shell exits. The file is
 * created under the shell's own `noclobber`, which opens it with O_EXCL: the
 * one test-and-set every shell does itself. Not `mkdir`, which is only as
 * atomic as the machine's coreutils (the uutils one Ubuntu ships lets two
 * racing callers both succeed), and not `flock`, which not every machine a
 * session runs on has. A lock older than a minute is one whose holder died
 * without its trap - killed, or its machine restarted - and is broken. The
 * release is a trap rather than a last line, so every exit takes it, and a
 * subshell does not inherit it.
 */
export function agentLockCommand(stateDir: string): string {
    return [
        `l="${stateDir}/${AGENT_LOCK_FILE}"`,
        "until (set -C; : > \"$l\") 2>/dev/null; do",
        '  if [ -n "$(find "$l" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rm -f "$l"; continue; fi',
        "  sleep 0.2 2>/dev/null || sleep 1",
        "done",
        "trap 'rm -f \"$l\"' EXIT",
        "trap 'exit 1' HUP INT TERM"
    ].join("\n");
}

/** Give the agent lock back before the shell is done, as `exec` would skip
 *  the trap. */
export const AGENT_UNLOCK = "rm -f \"$l\"; trap - EXIT HUP INT TERM";

/** The most arguments, and the longest one, a launch accepts. */
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4_096;

function pipeDir(stateDir: string): string {
    return `${stateDir}/acp`;
}

/**
 * The launch script. The argv line beside it was written by Polaris with every
 * word quoted (`acpLaunchCommand`), so it is a command line as it stands.
 *
 * Not as root, for the reason `LAUNCH_SCRIPT` gives. The exit code is written
 * last, after the agent's output, so a reader that sees it knows `out` is
 * complete.
 */
export const ACP_LAUNCH_SCRIPT = [
    "#!/bin/sh",
    "# Written by Polaris. Runs this session's agent over the Agent Client Protocol, its input and output files beside the checkout.",
    ...commands.AGENT_ENV_SCRUB,
    commands.READ_CREDENTIALS,
    'if [ -d "$POLARIS_STATE_DIR/bin" ]; then PATH="$POLARIS_STATE_DIR/bin:$PATH"; export PATH; fi',
    'a="$POLARIS_STATE_DIR/acp"',
    'line="$(cat "$a/argv")"',
    'rm -f "$a/rc" "$a/pipe"',
    ': > "$a/in"',
    ': > "$a/out"',
    ': > "$a/err"',
    'chmod 0666 "$a/in" "$a/out" "$a/err" 2>/dev/null || true',
    'mkfifo "$a/pipe"',
    'chmod 0666 "$a/pipe" 2>/dev/null || true',
    'n="$(date +%s%N 2>/dev/null)"',
    'case "$n" in *N|"") n="$(date +%s)000000000" ;; esac',
    'printf %s "$n-$$" > "$a/generation"',
    'tail -n +1 -f "$a/in" > "$a/pipe" &',
    "t=$!",
    'run="cd \\"$POLARIS_WORKDIR\\" && $line < \\"$a/pipe\\" > \\"$a/out\\" 2>> \\"$a/err\\""',
    'if [ "$(id -u)" = "0" ] && [ -n "${POLARIS_RUNAS:-}" ] && id "$POLARIS_RUNAS" >/dev/null 2>&1; then',
    '  su -p "$POLARIS_RUNAS" -c "$run"',
    "else",
    '  sh -c "$run"',
    "fi",
    "rc=$?",
    'kill "$t" 2>/dev/null || true',
    'printf %s "$rc" > "$a/rc"',
    'echo "polaris: the agent exited with status $rc"',
    ""
].join("\n");

const ACP_LAUNCH_SCRIPT_BASE64 = Buffer.from(ACP_LAUNCH_SCRIPT, "utf8").toString("base64");

/** The control characters a launch argument may not hold. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Start (or restart) the agent in its own window, running `argv`.
 *
 * Under the agent lock, and not at all - exiting `ACP_TERMINAL_BACK` - once
 * the terminal took the session back: whatever asked for this read the
 * session before the key was pressed. `before` (stopping the terminal's own
 * agent) runs in a subshell inside the lock, after that check, so it never
 * stops the agent the key just resumed.
 *
 * `argv` is Polaris's own - a provider binding's launch line, never something a
 * person typed - and is still checked: bounded, and no control characters, the
 * rule the boot environment is held to. Each word is quoted, so nothing in it
 * is a shell word.
 */
export function acpLaunchCommand(
    stateDir: string,
    argv: readonly string[],
    session = commands.TMUX_SESSION,
    before = ""
): string {
    if (argv.length === 0 || argv.length > MAX_ARGS)
        throw new Error("An agent's launch line has to name between 1 and 64 words.");
    for (const word of argv) {
        if (!word || word.length > MAX_ARG_CHARS || CONTROL.test(word))
            throw new Error("An agent's launch line has an empty, overlong or unprintable word.");
    }
    const line = Buffer.from(argv.map(shellQuote).join(" "), "utf8").toString("base64");
    const dir = pipeDir(stateDir);
    const target = shellQuote(`${session}:${ACP_WINDOW}`);
    return [
        agentLockCommand(stateDir),
        `[ -f "${stateDir}/${TERMINAL_BACK_FILE}" ] && exit ${ACP_TERMINAL_BACK}`,
        ...(before ? [`(\n${before}\n)`] : []),
        `a="${dir}"`,
        'mkdir -p "$a"',
        `printf %s ${ACP_LAUNCH_SCRIPT_BASE64} | base64 -d > "$a/launch.sh"`,
        `printf %s ${line} | base64 -d > "$a/argv"`,
        // The generation goes first, so nothing writes into the last agent's
        // input while the new one is starting.
        'rm -f "$a/generation"',
        `tmux kill-window -t ${target} 2>/dev/null || true`,
        `tmux new-window -d -t ${shellQuote(session)} -n ${ACP_WINDOW} "sh \\"$a/launch.sh\\""`
    ].join("\n");
}

/** Take the protocol agent's window down, for a session switched back to its
 *  terminal. The pipe files stay; the next launch truncates them. */
export function acpStopCommand(stateDir: string, session = commands.TMUX_SESSION): string {
    return [
        `rm -f "${pipeDir(stateDir)}/generation"`,
        `tmux kill-window -t ${shellQuote(`${session}:${ACP_WINDOW}`)} 2>/dev/null || true`
    ].join("\n");
}

/**
 * Stop the agent the session's terminal holds, for a session moving to Chat, so
 * two agents never work in one checkout. With a runner: the running turn is
 * stopped as Stop does it (`interruptTurnCommand`) and the interface window,
 * if a person opened one, is closed. Without one the agent is the main
 * window's own process: every process under that window's shell is ended, and
 * the window falls back to the shell the setup leaves there.
 */
export function terminalAgentStopCommand(stateDir: string, session = commands.TMUX_SESSION): string {
    return [
        `if [ -f "${stateDir}/${commands.RUNNER_READY_FILE}" ]; then`,
        `  if [ -f "${stateDir}/turn.txt" ]; then : > "${stateDir}/interrupted"; tmux send-keys -t ${shellQuote(`${session}:${commands.RUNNER_WINDOW}`)} C-c; fi`,
        `  tmux kill-window -t ${shellQuote(`${session}:${commands.INTERFACE_WINDOW}`)} 2>/dev/null || true`,
        "  exit 0",
        "fi",
        // Not while the setup is still cloning and installing in that window:
        // its processes are not an agent. The flag is written just before one.
        `test -f ${commands.AGENT_READY_FLAG} || exit 0`,
        // The main window: the first one that is not the protocol agent's.
        `p="$(tmux list-panes -s -t ${shellQuote(session)} -F '#{window_name} #{pane_pid}' 2>/dev/null | grep -v '^${ACP_WINDOW} ' | head -n 1 | cut -d' ' -f2)"`,
        'case "$p" in ""|*[!0-9]*) exit 0 ;; esac',
        // Parent before child, so a child is never re-parented out of reach.
        'under() { for c in $(ps -o pid= --ppid "$1" 2>/dev/null); do echo "$c"; under "$c"; done; }',
        'kids="$(under "$p")"',
        'if [ -n "$kids" ]; then kill -TERM $kids 2>/dev/null || true; fi'
    ].join("\n");
}

/** What `conversationHandBackCommand` exits with for a session with no runner. */
export const HAND_BACK_INTERACTIVE = 3;

/**
 * Leaving Chat: a runner's next turn continues the conversation Chat was on,
 * so its id is written where the runner reads it (`LAUNCH_SCRIPT --turn`).
 * Exits `HAND_BACK_INTERACTIVE` for a session with no runner; that one is
 * resumed in its terminal instead. The id is checked here because it is about
 * to be written into a file a launch line reads.
 */
export function conversationHandBackCommand(stateDir: string, vendorSessionId: string): string {
    if (!isVendorSessionId(vendorSessionId))
        throw new Error("That is not a conversation Polaris can reopen.");
    return [
        `[ -f "${stateDir}/${commands.RUNNER_READY_FILE}" ] || exit ${HAND_BACK_INTERACTIVE}`,
        `printf %s ${shellQuote(vendorSessionId)} > "${stateDir}/agent-session-id"`
    ].join("\n");
}

/**
 * Read what the agent wrote after `offset` bytes, at most `ACP_READ_BYTES`.
 * Answers three lines: the generation, the exit code or `-` while it runs, and
 * the bytes as base64. Exits `ACP_NOT_RUNNING` before any agent was launched.
 */
export function acpReadCommand(stateDir: string, offset: number): string {
    const from = Math.max(0, Math.floor(offset)) + 1;
    return [
        `a="${pipeDir(stateDir)}"`,
        `[ -f "$a/generation" ] || exit ${ACP_NOT_RUNNING}`,
        'head -c 64 "$a/generation"; echo',
        // The code before the bytes: an agent that exits between the two reads
        // leaves bytes this read missed, and the next one finds them.
        'if [ -f "$a/rc" ]; then tr -dc 0-9 < "$a/rc" | head -c 8; echo; else echo -; fi',
        `tail -c +${from} "$a/out" 2>/dev/null | head -c ${ACP_READ_BYTES} | base64 | tr -d '\\n'`,
        "echo"
    ].join("\n");
}

/**
 * Append bytes to the agent's input, but only while `generation` is still the
 * agent running: exits `ACP_NOT_RUNNING` otherwise, and nothing is written.
 */
export function acpWriteCommand(stateDir: string, generation: string, bytes: Uint8Array): string {
    if (bytes.byteLength > ACP_WRITE_BYTES)
        throw new Error("That is more than one write to an agent carries.");
    const encoded = Buffer.from(bytes).toString("base64");
    return [
        `a="${pipeDir(stateDir)}"`,
        `[ -f "$a/generation" ] && [ "$(head -c 64 "$a/generation")" = ${shellQuote(generation)} ] || exit ${ACP_NOT_RUNNING}`,
        `[ -f "$a/rc" ] && exit ${ACP_NOT_RUNNING}`,
        `printf %s ${encoded} | base64 -d >> "$a/in"`
    ].join("\n");
}

/** What the agent last wrote to its standard error, for a failure the session
 *  can show only after `readableFailure` has had its say. */
export function acpErrorTailCommand(stateDir: string): string {
    return `tail -c 2000 "${pipeDir(stateDir)}/err" 2>/dev/null`;
}

/** One read of the pipe. */
export interface PipeRead {
    readonly generation: string;
    /** The agent's exit code once it has exited. */
    readonly exitCode: number | null;
    readonly bytes: Uint8Array;
}

const readSchema = z.object({
    generation: z.string().regex(/^[0-9]{1,24}-[0-9]{1,10}$/),
    exit: z.string().regex(/^(-|[0-9]{1,8})$/),
    data: z
        .string()
        .max(Math.ceil(ACP_READ_BYTES / 3) * 4)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/)
});

/** A read command's answer, or null when it is not one. Pure. */
export function parseAcpRead(output: string): PipeRead | null {
    const [generation = "", exit = "", data = ""] = output.replace(/\r/g, "").split("\n");
    const parsed = readSchema.safeParse({ generation: generation.trim(), exit: exit.trim(), data: data.trim() });
    if (!parsed.success) return null;
    const bytes = new Uint8Array(Buffer.from(parsed.data.data, "base64"));
    if (bytes.byteLength > ACP_READ_BYTES) return null;
    return {
        generation: parsed.data.generation,
        exitCode: parsed.data.exit === "-" ? null : Number(parsed.data.exit),
        bytes
    };
}
