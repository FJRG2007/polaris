// Ported from backend/internal/adapters/agent/terminalui/composer.go and the
// terminal readers of backend/internal/adapters/agent/{aider,continueagent,
// stakpak}/ in Agent Orchestrator (Apache-2.0,
// github.com/OrchestratorInc/agent-orchestrator, commit e4ded08c6f15).

import type { HookActivity } from "@/lib/agents/hook-activity";

/**
 * What a tool's terminal says it is doing, for the tools that report no hook
 * for it (or not for every edge).
 *
 * Conservative by construction: a reader answers only on the tool's own
 * chrome, drawn where the tool draws it, and anything it does not recognise -
 * a capture cut short, a popup, a layout a new release changed - is null, "no
 * signal", never `idle`. A session wrongly shown idle is one somebody types
 * into mid-turn; one shown with no new signal keeps whatever its hooks last
 * said.
 */
export type TerminalActivity = Exclude<HookActivity, "exited">;

/** The most of a capture read, from its end (the newest part). */
const MAX_INPUT = 15 * 1024;

/** How far up from the bottom a tool's current chrome is looked for. */
const LOOKBACK_LINES = 40;

// CSI (`ESC [ ... final`), OSC (`ESC ] ... BEL | ESC \`), and two-byte escapes.
const ESCAPE = /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x40-\x5f])/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * The visible rows of a capture: escapes and control characters gone, a
 * carriage return a row break, bounded to the end of the text.
 */
export function plainTerminalLines(output: string): string[] {
    const tail = output.length > MAX_INPUT ? output.slice(-MAX_INPUT) : output;
    return tail.replace(/\r\n?/g, "\n").replace(ESCAPE, "").replace(CONTROL, "").split("\n");
}

/** The non-blank rows, trimmed, for the readers that match whole rows. */
function trimmedLines(output: string): string[] {
    return plainTerminalLines(output)
        .map((line) => line.trim())
        .filter((line) => line !== "");
}

const recent = (lines: string[]): string[] => lines.slice(-LOOKBACK_LINES);

// ---------------------------------------------------------------------------
// Aider
// ---------------------------------------------------------------------------

/** `>`, `ask>`, `architect multi>`: its prompt, and what follows it on the row. */
const AIDER_PROMPT = /^(?:(?:[a-z][a-z0-9-]*)(?: multi)?|multi)?>(?:[ \t](.*))?$/;

/**
 * Working when its newest prompt holds a submitted message; Aider prints no
 * new prompt until the reply is done. A bare prompt is no signal: its finished
 * reply is the notification command's (`aiderAnswers` in core), and a session
 * that just started has nothing to report either way.
 */
function aider(output: string): TerminalActivity | null {
    for (const line of recent(trimmedLines(output)).reverse()) {
        const match = AIDER_PROMPT.exec(line);
        if (!match) continue;
        return (match[1] ?? "").trim() === "" ? null : "active";
    }
    return null;
}

// ---------------------------------------------------------------------------
// Continue (`cn`)
// ---------------------------------------------------------------------------

/** Continue 1.5's empty composer, "● ▋Ask anything, …". */
const continuePlaceholder = (line: string): boolean => trimBox(line).startsWith("● ▋Ask anything");
const continueIdleComposer = (line: string): boolean => trimBox(line) === "❯" || continuePlaceholder(line);

function trimBox(line: string): string {
    return line.replace(/^[│ ]+|[│ ]+$/g, "");
}

/** A question picker still on screen: its action row, a question just above,
 *  and no empty composer drawn after it. */
function continuePickerAt(lines: string[], index: number): boolean {
    if (!lines[index]!.toLowerCase().includes("enter select")) return false;
    for (const later of lines.slice(index + 1)) if (continueIdleComposer(later)) return false;
    return lines
        .slice(Math.max(0, index - 8), index + 1)
        .some((line) => line.toLowerCase().includes("ask question(") || line.includes("? "));
}

/** The newest of its markers wins, so a picker left in the scrollback does not
 *  hold a session that went back to work. */
function continueAgent(output: string): TerminalActivity | null {
    const lines = recent(trimmedLines(output));
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (continueIdleComposer(line)) {
            // Continue 1.5 keeps its empty composer on screen while it works,
            // with "esc to interrupt" just above the box.
            const above = lines.slice(Math.max(0, i - 3), i);
            if (continuePlaceholder(line) && above.some((row) => row.toLowerCase().includes("esc to interrupt")))
                return "active";
            return "idle";
        }
        if (continuePickerAt(lines, i)) return "waiting_input";
        if (line.toLowerCase().includes("esc to interrupt")) return "active";
    }
    return null;
}

// ---------------------------------------------------------------------------
// Stakpak
// ---------------------------------------------------------------------------

// Stakpak 0.3.88 draws its composer as a box with one footer row under it:
//
//   ┌──────────────────────────────┐
//   │→ █Load test my service …     │
//   └──────────────────────────────┘
//      $ shell | / commands | ctrl+s shortcuts | profile default | …
//
// The footer is the state: "esc cancel" while a turn runs, "ctrl+j new line"
// while a draft is typed. A tool approval replaces the composer with an
// "Approval Required" box whose last row ends in "esc reject all".
const STAKPAK_SCAN = 12;

function bottomRows(output: string, count: number): string[] {
    const lines = plainTerminalLines(output);
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    return lines.slice(-count);
}

/** The footer under the composer box nearest the bottom; the box must be whole. */
function stakpakFooter(lines: string[]): string | null {
    for (let i = lines.length - 1; i >= 2; i--) {
        if (!lines[i]!.trimStart().startsWith("└")) continue;
        for (let j = i - 1; j >= 1; j--) {
            const row = lines[j]!.trimStart();
            if (row.startsWith("│→")) {
                if (!lines[j - 1]!.trimStart().startsWith("┌")) return null;
                return i + 1 < lines.length ? lines[i + 1]! : null;
            }
            if (!row.startsWith("│")) break;
        }
        return null;
    }
    return null;
}

function stakpakApproval(lines: string[]): boolean {
    let title = -1;
    lines.forEach((line, index) => {
        if (line.includes("Approval Required") && line.includes("┌")) title = index;
    });
    if (title < 0) return false;
    let hint = false;
    for (const line of lines.slice(title + 1)) {
        if (line.trimStart().startsWith("│→")) return false;
        if (line.includes("esc reject all")) hint = true;
    }
    return hint;
}

function stakpak(output: string): TerminalActivity | null {
    const lines = bottomRows(output, STAKPAK_SCAN);
    if (stakpakApproval(lines)) return "blocked";
    const footer = stakpakFooter(lines);
    if (footer === null) return null;
    if (footer.includes("esc cancel")) return "active";
    // A draft being typed says nothing about the turn.
    if (footer.includes("ctrl+j new line")) return null;
    if (footer.includes("$ shell") && footer.includes("/ commands")) return "idle";
    return null;
}

// ---------------------------------------------------------------------------

/**
 * The readers by catalogue id. Only tools whose screen Agent Orchestrator
 * verified against real captures: MiMo Code, MiniMax Code and Hermes have no
 * reader there (MiMo reports through its plugin), and a reader guessed from
 * memory would be the "idle" this module exists to avoid.
 */
const READERS: Readonly<Record<string, (output: string) => TerminalActivity | null>> = {
    aider,
    continue: continueAgent,
    stakpak
};

/** Whether Polaris can read anything of this tool's activity from its screen. */
export function hasTerminalActivity(cliId: string): boolean {
    return cliId in READERS;
}

/**
 * What one capture of a tool's terminal (`captureCommand`) says it is doing,
 * or null for no signal: an unknown tool, an empty or unrecognised screen.
 */
export function terminalActivity(cliId: string, output: string): TerminalActivity | null {
    const read = READERS[cliId];
    if (!read || typeof output !== "string" || output === "") return null;
    return read(output);
}
