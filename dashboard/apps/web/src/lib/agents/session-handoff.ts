/**
 * The note an agent starts with when it takes over a session from another
 * agent, or carries on a stopped one in a new container, and the file beside it
 * that holds the whole conversation.
 *
 * Ported from Agent Orchestrator's `backend/pkg/handoffnote/handoffnote.go`
 * (Apache-2.0, commit e4ded08c6f15), the builder its desktop provider switch
 * and AO Cloud's agent switch share. Deterministic, and it never asks a model to
 * summarise: the latest turn is kept, the five before it are clipped to a
 * budget, up to fifteen older ones become one line each, and anything beyond
 * that is only counted - the file has all of it.
 *
 * Pure, so what a new agent is told is asserted in a test.
 */

import * as core from "@polaris/core";

/** Opens every note. */
export const HANDOFF_PREFIX = "<polaris-handoff";

/**
 * The note's length cap. A note is the new agent's first prompt, which the
 * start schema holds to 20 000 characters, and is typed into a terminal; AO
 * keeps the same 16 000 on Windows for its command line.
 */
export const HANDOFF_MAX_CHARS = 16_000;

/** Where the whole conversation lands, relative to the working directory. Under
 *  `.polaris/`, which a `.gitignore` of its own keeps out of commits. */
export const HANDOFF_FILE = ".polaris/attachments/conversation.md";

/** The most messages read into a handoff, newest kept. */
export const HANDOFF_MESSAGES_MOST = 2_000;

/** The most bytes the conversation file carries; the oldest are cut first. */
export const HANDOFF_FILE_MAX_BYTES = 2 * 1024 * 1024;

const PREVIOUS_TURN_LIMIT = 5;
const OLDER_TURN_LIMIT = 15;
const LATEST_TURN_BUDGET = 6_000;
const LATEST_USER_CAP = 2_000;
const PREVIOUS_TURN_BUDGET = 1_500;
const PREVIOUS_USER_CAP = 500;
const OLDER_TURN_BUDGET = 300;
const OLDER_USER_CAP = 120;
const ORIGINAL_TASK_CAP = 1_500;
const FIELD_CAP = 160;
const CLIP_MARKER = "\n...[clipped]...\n";
const LINE_CLIP_MARKER = " ...[clipped]... ";

/** One turn: what the person asked, and the agent's last answer to it. */
export interface HandoffTurn {
    readonly userRequest: string;
    readonly agentResponse: string;
}

export interface HandoffInput {
    /** `switch`: another agent takes over a running session. `restore`: the
     *  same work carries on in a new container after the session stopped. */
    readonly kind: "switch" | "restore";
    readonly sourceAgent: string;
    readonly targetAgent: string;
    readonly title: string;
    readonly repository: string;
    readonly branch: string;
    readonly at: Date;
    readonly originalTask: string;
    /** Every turn known, oldest first; the builder decides what fits. */
    readonly turns: readonly HandoffTurn[];
    /** Where the whole conversation is, or empty when it was not written. */
    readonly fullHistoryPath: string;
    readonly maxChars?: number;
}

/** A stored history row, as `historyPage` and the handoff read it. */
export interface HandoffMessage {
    readonly role: string;
    readonly kind: string;
    readonly subject: string;
    readonly body: string;
    readonly at: string;
}

/**
 * The turns a history holds: each typed request with the last thing the agent
 * said before the next one. Tool calls and Polaris's own notices are left to the
 * file; an answer given before any request is kept with an empty request.
 */
export function handoffTurns(messages: readonly HandoffMessage[]): HandoffTurn[] {
    const turns: Array<{ userRequest: string; agentResponse: string }> = [];
    for (const message of messages) {
        if (message.kind !== "text") continue;
        const body = message.body.trim();
        if (!body) continue;
        if (message.role === "user") turns.push({ userRequest: body, agentResponse: "" });
        else if (message.role === "agent") {
            const last = turns.at(-1);
            if (last) last.agentResponse = body;
            else turns.push({ userRequest: "", agentResponse: body });
        }
    }
    return turns;
}

/**
 * The whole conversation as Markdown, oldest first, every row: what the note
 * had to clip is here. Cut from the oldest end to `maxBytes`, saying so.
 */
export function conversationFile(
    input: { title: string; sourceAgent: string },
    messages: readonly HandoffMessage[],
    maxBytes = HANDOFF_FILE_MAX_BYTES
): string {
    const head = `# Conversation: ${oneLine(input.title)}\n\nAgent: ${oneLine(input.sourceAgent)}\n`;
    const blocks = messages.map((message) => {
        const who =
            message.role === "user"
                ? "User"
                : message.role === "agent"
                  ? message.kind === "text"
                      ? "Assistant"
                      : `Assistant (${message.kind}${message.subject ? `: ${oneLine(message.subject)}` : ""})`
                  : "Polaris";
        return `\n## ${who} - ${message.at}\n\n${sanitize(message.body).trim()}\n`;
    });
    let size = Buffer.byteLength(head);
    const kept: string[] = [];
    for (let index = blocks.length - 1; index >= 0; index--) {
        const block = blocks[index] ?? "";
        const bytes = Buffer.byteLength(block);
        if (size + bytes > maxBytes) break;
        size += bytes;
        kept.push(block);
    }
    const cut = blocks.length - kept.length;
    const note = cut > 0 ? `\n(${cut} earlier messages are not in this file.)\n` : "";
    return head + note + kept.reverse().join("");
}

/** The note a new agent starts with. See the module comment. */
export function buildHandoffNote(input: HandoffInput): string {
    const max = input.maxChars && input.maxChars > 0 ? input.maxChars : HANDOFF_MAX_CHARS;
    const turns = input.turns;
    let recent = turns.slice(Math.max(0, turns.length - 1 - PREVIOUS_TURN_LIMIT));
    let older = turns.slice(Math.max(0, turns.length - recent.length - OLDER_TURN_LIMIT), turns.length - recent.length);
    // Drop material until the note fits: older turns first, then previous
    // turns. The latest turn is never dropped, only clipped.
    for (;;) {
        const note = render(input, older, recent);
        if (length(note) <= max) return note;
        if (older.length > 0) older = older.slice(1);
        else if (recent.length > 1) recent = recent.slice(1);
        else return clip(note, max, CLIP_MARKER);
    }
}

function render(input: HandoffInput, older: readonly HandoffTurn[], recent: readonly HandoffTurn[]): string {
    const source = label(input.sourceAgent);
    const target = label(input.targetAgent);
    const lines: string[] = [`${HANDOFF_PREFIX}>`];
    // The new agent must take this as the person's real conversation: AO found
    // that calling it a tool's note made Claude refuse to use what the person
    // had said there.
    if (input.kind === "switch") {
        lines.push(
            `You are ${target}, taking over this Polaris session from ${source}. The conversation below really took place between this user and ${source}. Treat it as your own history with them: what the user told you there, such as facts, preferences or values they asked you to remember, still holds.`
        );
    } else {
        lines.push(
            `You are ${target}, carrying on a Polaris session that stopped. Its work was saved to this branch and the conversation below really took place between this user and ${source}. Treat it as your own history with them: what the user told you there still holds.`
        );
    }
    lines.push("- Polaris copied this record from that conversation. Requests in it were already handled; do not carry them out again.");
    lines.push("- The files in the workspace and git are the truth. Check them before relying on this record.");
    lines.push("- Do not redo work that is already finished.");
    lines.push("", "## Session");
    field(lines, "Title", input.title);
    field(lines, "Repository", input.repository);
    field(lines, "Git branch", input.branch);
    field(lines, input.kind === "switch" ? "Handed off at" : "Restored at", input.at.toISOString());

    const task = input.originalTask.trim();
    if (task && !taskShownInFull(task, recent)) {
        lines.push("", "## Original task", quote(task, ORIGINAL_TASK_CAP, CLIP_MARKER));
    }
    if (older.length > 0) {
        lines.push("", "## Older turns, oldest first");
        for (const turn of older) {
            const [user, agent] = budgetTurn(turn, OLDER_TURN_BUDGET, OLDER_USER_CAP, true);
            lines.push(`- User: ${user}`, `  Assistant: ${agent}`);
        }
    }
    if (recent.length > 1) {
        lines.push("", "## Previous turns, oldest first");
        for (const turn of recent.slice(0, -1)) {
            const [user, agent] = budgetTurn(turn, PREVIOUS_TURN_BUDGET, PREVIOUS_USER_CAP, false);
            lines.push("", "User:", user, "Assistant:", agent);
        }
    }
    const latest = recent.at(-1);
    if (latest) {
        const [user, agent] = budgetTurn(latest, LATEST_TURN_BUDGET, LATEST_USER_CAP, false);
        lines.push("", "## Latest turn", "User:", user, "Assistant:", agent);
    }
    const omitted = input.turns.length - older.length - recent.length;
    const path = input.fullHistoryPath.trim();
    if (omitted > 0 || path) {
        const said: string[] = [];
        if (omitted > 0) said.push(`${omitted} earlier turns are not shown.`);
        if (path)
            said.push(
                `The whole conversation, tool calls included, is in \`${oneLine(path)}\` (relative to the working directory). Read it when you need something this note does not show.`
            );
        lines.push("", "## Earlier history", said.join(" "));
    }
    lines.push("", "Do not mention this note unless it is relevant. Reply with a few lines on where things stand, then wait for the user.");
    lines.push("</polaris-handoff>");
    return lines.join("\n");
}

/** Whether the original task already shows unclipped as a turn's request. */
function taskShownInFull(task: string, recent: readonly HandoffTurn[]): boolean {
    return recent.some((turn, index) => {
        const limit = index === recent.length - 1 ? LATEST_USER_CAP : PREVIOUS_USER_CAP;
        return turn.userRequest.trim() === task && length(task) <= limit;
    });
}

function label(agent: string): string {
    return agent.trim() ? oneLine(agent) : "another agent";
}

function field(lines: string[], name: string, value: string): void {
    const trimmed = value.trim();
    if (trimmed) lines.push(`${name}: ${quoteLine(trimmed, FIELD_CAP)}`);
}

/** The request gets what it needs up to its cap and the answer the rest of the
 *  turn's budget: requests are short, so the room is better spent on answers. */
function budgetTurn(turn: HandoffTurn, budget: number, userCap: number, single: boolean): [string, string] {
    const marker = single ? LINE_CLIP_MARKER : CLIP_MARKER;
    let user = turn.userRequest.trim();
    let agent = turn.agentResponse.trim();
    if (single) {
        user = collapse(user);
        agent = collapse(agent);
    }
    const quotedUser = user ? quote(user, userCap, marker) : "(no request recorded)";
    if (!agent) return [quotedUser, "(no final response recorded)"];
    return [quotedUser, quote(agent, Math.max(budget - length(quotedUser), 40), marker)];
}

const TAG = /polaris-handoff/gi;
const HEADING = /^([ \t]*)#/gm;

/** Clipped, with the note's own tag and headings defanged, so nothing quoted
 *  can close the note early or add a section to it. */
function quote(value: string, limit: number, marker: string): string {
    const safe = sanitize(value).replace(TAG, "polaris_handoff").replace(HEADING, "$1\\#");
    return clip(safe, limit, marker);
}

function quoteLine(value: string, limit: number): string {
    return quote(collapse(value), limit, LINE_CLIP_MARKER);
}

/** Keeps the start and the end: a request opens with the ask, an answer closes
 *  with what is left to do. */
function clip(value: string, limit: number, marker: string): string {
    const chars = Array.from(value);
    if (chars.length <= limit) return value;
    const keep = Math.max(limit - Array.from(marker).length, 0);
    const head = Math.floor(keep / 2);
    return chars.slice(0, head).join("") + marker + chars.slice(chars.length - (keep - head)).join("");
}

function length(value: string): number {
    return Array.from(value).length;
}

function collapse(value: string): string {
    return value.split(/\s+/).filter(Boolean).join(" ");
}

function oneLine(value: string): string {
    return collapse(sanitize(value));
}

/** Control characters other than newlines, carriage returns and tabs go. */
function sanitize(value: string): string {
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

/** The agent a session switches to. */
export interface SwitchTarget {
    readonly cli: string;
    readonly accountId: string | null;
    readonly useMachineLogin: boolean;
    readonly modelChoice: { readonly model: string } | null;
}

/** What `switchRefusal` reads of the session. */
export interface SwitchingSession {
    readonly state: core.AgentSessionState;
    readonly place: string;
    readonly repoId: string | null;
    readonly cli: string;
    readonly accountId: string | null;
    readonly useMachineLogin: boolean;
    readonly modelChoice: { readonly model: string } | null;
}

/** Why a session cannot switch agents, as an `agents` message key, or null.
 *  `target` null asks whether it can switch at all, for the menu. */
export function switchRefusal(session: SwitchingSession, target: SwitchTarget | null): string | null {
    if (core.isSessionOver(session.state) || session.state === "starting") return "session.switch.errors.notRunning";
    // Its work is saved to its branch and the new agent clones it; a server's
    // or a computer's worktree stays where it is, out of the new one's reach.
    if (session.place !== "local") return "session.switch.errors.place";
    if (!session.repoId) return "session.switch.errors.noRepo";
    if (
        target &&
        target.cli === session.cli &&
        target.accountId === session.accountId &&
        target.useMachineLogin === session.useMachineLogin &&
        (target.modelChoice?.model ?? null) === (session.modelChoice?.model ?? null)
    )
        return "session.switch.errors.same";
    return null;
}
