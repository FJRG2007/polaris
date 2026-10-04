/**
 * Reading a value that must not be seen: typed at a prompt that does not echo,
 * or piped in on stdin.
 *
 * Never from the command line itself. An argument lands in the shell's history
 * file and in the process list any other account on the machine can read, which
 * is exactly where a secret should not be - the reason `gh secret set` and
 * `vercel env add` read the value the same way.
 */

/** Read past this and the input is refused rather than held: the server takes
 *  64 KB, so anything near a megabyte is a wrong file, not a value. */
const MAX_INPUT_BYTES = 1024 * 1024;

const ENTER = new Set(["\r", "\n"]);
const INTERRUPT = "\u0003";
const END = "\u0004";
const ERASE = new Set(["\u007f", "\b"]);
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-9;?]*[@-~]|O.|.)?/g;

/**
 * Apply one chunk of keystrokes to what has been typed so far. Pure, so the
 * prompt's handling of Enter, Backspace and Ctrl+C is tested without a terminal.
 * `done` is the finished value; `interrupted` means the person gave up.
 */
export function typeKeys(
    typed: string,
    chunk: string
): { typed: string; done: boolean; interrupted: boolean } {
    let current = typed;
    // Arrow keys, Home, a bracketed paste's markers: escape sequences, none of
    // them text. Dropped whole, so "[A" never ends up inside a value.
    for (const key of chunk.replace(ESCAPE_SEQUENCE, "")) {
        if (key === INTERRUPT) return { typed: "", done: true, interrupted: true };
        if (ENTER.has(key) || key === END)
            return { typed: current, done: true, interrupted: false };
        if (ERASE.has(key)) {
            current = Array.from(current).slice(0, -1).join("");
            continue;
        }
        if (key < " ") continue;
        current += key;
    }
    return { typed: current, done: false, interrupted: false };
}

/** A prompt on the terminal that shows nothing of what is typed. The question
 *  goes to stderr so stdout stays clean for `--json`. */
function hiddenPrompt(question: string): Promise<string | null> {
    const input = process.stdin;
    process.stderr.write(question);
    return new Promise((resolve) => {
        let typed = "";
        const finish = (value: string | null) => {
            input.off("data", onData);
            input.setRawMode?.(false);
            input.pause();
            process.stderr.write("\n");
            resolve(value);
        };
        const onData = (chunk: Buffer | string) => {
            const next = typeKeys(typed, chunk.toString());
            typed = next.typed;
            if (next.done) finish(next.interrupted ? null : typed);
        };
        input.setRawMode?.(true);
        input.resume();
        input.on("data", onData);
    });
}

/** Everything piped in, up to the cap. Null past it. */
async function readStdin(): Promise<string | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
        size += buffer.byteLength;
        if (size > MAX_INPUT_BYTES) return null;
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/**
 * The value, from a hidden prompt when a person is at the terminal and from
 * stdin when something is piped in. Null when the prompt was abandoned or the
 * input was far too large to be a value.
 */
export function readSecret(question: string): Promise<string | null> {
    return process.stdin.isTTY ? hiddenPrompt(question) : readStdin();
}

/** A value as it arrives from a pipe or a file, without the one line break that
 *  `echo` and every editor put at the end. Anything inside it is kept. */
export function withoutFinalNewline(value: string): string {
    return value.replace(/\r?\n$/, "");
}
