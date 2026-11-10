/**
 * Reading a sign-in's terminal: what is on it, and how far the login has got.
 *
 * Pure, so every rule below is asserted against text a real login printed
 * rather than against a container this machine cannot start.
 *
 * Nothing here reads a credential off the screen. What it lifts out is what the
 * vendor's CLI prints for the person to act on - the address to open, the
 * one-time code to type there, the line that says who signed in - and only ever
 * what was actually printed: a field that did not parse is null, never a guess.
 */

import { firstUrlIn } from "./session-commands";

/** Written by the boot script once the tmux session exists. Until it does the
 *  screen is not read at all: tmux is still being installed, or the login has
 *  not been started in it yet, and either way the only thing a capture could
 *  print is tmux's own complaint about it. */
export const SIGNIN_READY_FILE = "/tmp/polaris-signin-ready";

/** Printed by the boot script after the login command returns, followed by its
 *  exit status. Read here and never shown. */
export const SIGNIN_EXIT_MARKER = "polaris-signin-exit";

/** A line the container wrote about itself rather than the login: tmux not
 *  installed yet, no tmux server yet, and the job-control notice an
 *  interactive shell without a terminal prints. */
const NOISE = [
    /tmux: not found/,
    /no server running on /,
    /error connecting to \/tmp\/tmux-/,
    /can't find session/,
    /can't access tty; job control turned off/
];

const EXIT_LINE = new RegExp(`^${SIGNIN_EXIT_MARKER} (\\d{1,3})$`);

/** Whether a line is the container talking about itself. */
export function isContainerNoise(line: string): boolean {
    return NOISE.some((pattern) => pattern.test(line));
}

/**
 * A row the login drew, then drew again from its start.
 *
 * A CLI that redraws its output (a spinner, a status line rewritten in place)
 * moves the cursor back and writes the same sentence over the row it already
 * wrote. tmux keeps that row's "wrapped" flag from the first write, so the
 * joined capture is the first, partial copy glued to the complete second one:
 * "visit https://github.com/login/de To authenticate, visit
 * https://github.com/login/device ...". When everything before a later
 * occurrence of the line's own opening is a prefix of what follows it, the
 * later copy is the line.
 */
function collapseRestart(line: string): string {
    const head = line.slice(0, 12);
    if (head.trim().length < 8) return line;
    for (let at = line.indexOf(head, 1); at > 0; at = line.indexOf(head, at + 1)) {
        const before = line.slice(0, at).trimEnd();
        const after = line.slice(at);
        if (after.startsWith(before)) return collapseRestart(after);
    }
    return line;
}

/**
 * The tail of an earlier row left behind by a shorter line written over it.
 *
 * A line rewritten without clearing to the end of the row keeps whatever was
 * past its own end: "... the code 37FB-F903 manually.ice and enter code
 * 37FB-F903". Recognised only narrowly - glued straight onto the end of a
 * sentence, at least eight characters with a space inside, and exactly the
 * ending of a line printed ABOVE this one - so ordinary text that happens to
 * end the same way as another line ("Saved. Press Enter to continue") is left
 * alone.
 */
function stripResidue(line: string, above: readonly string[]): string {
    for (let start = 1; start <= line.length - 8; start++) {
        const tail = line.slice(start);
        if (!tail.includes(" ") || /\s/.test(tail[0]!) || !/[.!?)\]]/.test(line[start - 1]!)) continue;
        if (above.some((other) => other.length > tail.length && other.endsWith(tail))) {
            return line.slice(0, start);
        }
    }
    return line;
}

/** A sign-in's screen, cleaned, and the login command's exit status once it
 *  has one. */
export interface CleanScreen {
    readonly screen: string;
    readonly exitCode: number | null;
}

/**
 * What a capture shows a person.
 *
 * Container noise and the exit marker are taken out, redrawn rows are put back
 * to the line they were, and trailing blank rows - most of an eighty-by-thirty
 * pane on a login that printed five lines - are dropped.
 */
export function cleanSigninScreen(raw: string): CleanScreen {
    let exitCode: number | null = null;
    const kept: string[] = [];
    for (const original of raw.replace(/\r/g, "").split("\n")) {
        const line = original.trimEnd();
        const exit = EXIT_LINE.exec(line.trim());
        if (exit) {
            exitCode = Number(exit[1]);
            continue;
        }
        if (isContainerNoise(line)) continue;
        kept.push(stripResidue(collapseRestart(line), kept).trimEnd());
    }
    // A bare prompt at the bottom is a shell left behind, not the login's.
    while (kept.length > 0 && /^\s*[$#]?\s*$/.test(kept[kept.length - 1]!)) kept.pop();
    return { screen: kept.join("\n"), exitCode };
}

/**
 * The one-time code a device-code login printed, or null.
 *
 * GitHub's look like `37FB-F903`: two groups of letters and digits joined by a
 * hyphen. Taken only from a line that mentions a code, or from the line right
 * under one (a CLI that prints the code on a line of its own), so a version
 * string or a hash on the screen is never offered as something to type. The
 * last one wins: a code that expired and was replaced is replaced here too.
 */
export function deviceCodeIn(screen: string): string | null {
    const lines = screen.split("\n");
    let found: string | null = null;
    let previous = "";
    for (const line of lines) {
        const context = /\bcode\b/i.test(line) || /\bcode\b/i.test(previous);
        if (context) {
            const match = /(?<![A-Za-z0-9-])[A-Z0-9]{4,8}-[A-Z0-9]{4,8}(?![A-Za-z0-9-])/.exec(line);
            if (match) found = match[0];
        }
        if (line.trim()) previous = line;
    }
    return found;
}

/** The account a login said it signed in as, from the line GitHub's CLI prints
 *  ("Signed in successfully as FJRG2007."), or null. */
export function signedInAsIn(screen: string): string | null {
    const match = /Signed in successfully as ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/.exec(screen);
    return match?.[1] ?? null;
}

/** A question on the screen that Polaris answers for the person. */
export interface SigninAutoAnswer {
    /** The prompt exactly as the CLI prints it. */
    readonly prompt: string;
    readonly reply: string;
}

/**
 * The reply owed to the prompt the login is waiting on, or null.
 *
 * Only when the prompt is the last thing on the screen with nothing typed after
 * it: once the reply has been echoed the line no longer ends with the prompt,
 * so a poll that reads the screen again does not answer twice.
 */
export function pendingAutoAnswer(
    screen: string,
    answers: readonly SigninAutoAnswer[]
): string | null {
    const last = screen
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .pop();
    if (!last) return null;
    return answers.find((answer) => last.endsWith(answer.prompt))?.reply ?? null;
}

/** How far a login has got, from its screen. */
export interface SigninProgress {
    readonly screen: string;
    readonly url: string | null;
    readonly code: string | null;
    readonly signedInAs: string | null;
    readonly exitCode: number | null;
    /** The login says it worked: a success line, or the command exiting 0. */
    readonly finished: boolean;
}

export function readSigninScreen(raw: string): SigninProgress {
    const { screen, exitCode } = cleanSigninScreen(raw);
    const signedInAs = signedInAsIn(screen);
    return {
        screen,
        url: firstUrlIn(screen),
        code: deviceCodeIn(screen),
        signedInAs,
        exitCode,
        finished: signedInAs !== null || exitCode === 0
    };
}
