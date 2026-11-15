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
 * `argv` is Polaris's own - a provider binding's launch line, never something a
 * person typed - and is still checked: bounded, and no control characters, the
 * rule the boot environment is held to. Each word is quoted, so nothing in it
 * is a shell word.
 */
export function acpLaunchCommand(
    stateDir: string,
    argv: readonly string[],
    session = commands.TMUX_SESSION
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
