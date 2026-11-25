/**
 * The live console's text, kept free of the screen so it can be pinned in a test.
 *
 * Two halves. The output half turns what the container printed - `docker logs
 * --timestamps`, one RFC3339 stamp in front of every line, arriving in chunks
 * that split lines anywhere - into terminal rows: the stamp shortened to the time
 * of day and dimmed, every line ended the way a terminal wants it. The input half
 * is the line being typed at the prompt: a terminal sends keys, not lines, so the
 * line is edited here and handed over whole on Enter, where the console's own
 * action checks and audits it like a line typed in the box below.
 */

/** The prompt the typed line sits behind. */
export const CONSOLE_PROMPT = "> ";

/** How many raw lines are kept for the checks that read the log. */
export const KEPT_LOG_LINES = 400;

const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\s?/;

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** One line as a terminal row: the time of day dimmed in front, CRLF after. */
export function consoleRow(line: string): string {
    const text = line.replace(/\r$/, "");
    const stamp = STAMP.exec(text);
    if (!stamp) return `${text}\r\n`;
    return `${DIM}${stamp[2]}${RESET} ${text.slice(stamp[0].length)}\r\n`;
}

/**
 * Output as it arrives. `push` answers the rows ready to write; a line still
 * being printed waits for the rest of it. `log` is the recent raw text, for the
 * checks that read the log the way they always did.
 */
export function createConsoleOutput(): { push: (chunk: string) => string; log: () => string } {
    let partial = "";
    let kept: string[] = [];
    return {
        push(chunk) {
            const lines = (partial + chunk).split("\n");
            partial = lines.pop() ?? "";
            if (lines.length === 0) return "";
            kept = [...kept, ...lines].slice(-KEPT_LOG_LINES);
            return lines.map(consoleRow).join("");
        },
        log: () => kept.join("\n")
    };
}

/**
 * What a polled read adds to the one before it: the lines after the last line
 * already shown, or the whole read when that line is no longer in it (the server
 * restarted, or printed more than a read holds). Lines carry their own stamp, so
 * a repeated one is genuinely rare.
 */
export function newSince(previous: string, next: string): string {
    if (!previous) return next;
    const last = previous.trimEnd().split("\n").pop() ?? "";
    if (!last) return next;
    const at = next.lastIndexOf(last);
    if (at === -1) return next;
    return next.slice(at + last.length).replace(/^\r?\n/, "");
}

/** A command and its answer, written into the terminal like output. */
export function replyRows(command: string, output: string, failed: boolean): string {
    const answer = output
        .split("\n")
        .map((line) => `${failed ? RED : ""}${line.replace(/\r$/, "")}${failed ? RESET : ""}\r\n`)
        .join("");
    return `${DIM}${CONSOLE_PROMPT}${command}${RESET}\r\n${answer}`;
}

/** The prompt line drawn again from its start, for after output moved it. */
export function promptRow(line: string): string {
    return `\r\x1b[K${CONSOLE_PROMPT}${line}`;
}

/** Where the typed line is: its text, and which past command the arrows are on. */
export interface LineState {
    readonly line: string;
    readonly recall: number | null;
}

export const EMPTY_LINE: LineState = { line: "", recall: null };

/** What a burst of keys did: the new line, what to echo, the lines to send. */
export interface LineEdit {
    readonly state: LineState;
    readonly echo: string;
    readonly submit: readonly string[];
}

/**
 * Apply what the terminal sent to the typed line. Printable text is added,
 * Backspace takes the last character, Ctrl+C and Ctrl+U drop the line, the up
 * and down arrows walk `history` (newest last) like a shell, and Enter sends
 * the line. A paste of several lines sends each. Other keys are dropped: the
 * line is edited at its end, and nothing typed here reaches the container
 * directly.
 */
export function editLine(state: LineState, data: string, history: readonly string[]): LineEdit {
    let { line, recall } = state;
    let echo = "";
    const submit: string[] = [];
    const recallTo = (index: number | null): void => {
        recall = index;
        line = index === null ? "" : (history[index] ?? "");
        echo += promptRow(line);
    };
    for (let i = 0; i < data.length; i++) {
        const char = data[i]!;
        if (char === "\x1b") {
            const sequence = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])?/.exec(data.slice(i))?.[0] ?? char;
            i += sequence.length - 1;
            const key = sequence.slice(-1);
            if (sequence.length > 1 && key === "A" && history.length > 0) {
                recallTo(recall === null ? history.length - 1 : Math.max(0, recall - 1));
            } else if (sequence.length > 1 && key === "B" && recall !== null) {
                recallTo(recall + 1 < history.length ? recall + 1 : null);
            }
            continue;
        }
        if (char === "\r" || char === "\n") {
            // A CRLF pair is one Enter.
            if (char === "\n" && data[i - 1] === "\r") continue;
            echo += "\r\n";
            const sent = line.trim();
            if (sent) submit.push(sent);
            line = "";
            recall = null;
            echo += CONSOLE_PROMPT;
            continue;
        }
        if (char === "\x7f" || char === "\b") {
            if (line.length > 0) {
                const chars = [...line];
                chars.pop();
                line = chars.join("");
                echo += "\b \b";
            }
            continue;
        }
        if (char === "\x03" || char === "\x15") {
            line = "";
            recall = null;
            echo += char === "\x03" ? `^C\r\n${CONSOLE_PROMPT}` : promptRow("");
            continue;
        }
        if (char < " ") continue;
        line += char;
        echo += char;
    }
    return { state: { line, recall }, echo, submit };
}
