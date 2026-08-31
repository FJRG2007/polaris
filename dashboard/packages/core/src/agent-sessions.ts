/**
 * What a live agent session is doing, and how Polaris learns it.
 *
 * A session is a real command-line agent running on a real machine (see
 * `agent-clis.ts`). Polaris is not inside it and cannot ask it questions, so
 * everything on this screen is inferred from two streams:
 *
 *   - The tool's own lifecycle hooks, where it has them. Polaris registers a
 *     small script in the tool's configuration that reports each turn, tool call
 *     and permission prompt to the session's ingest endpoint. Exact, and it keeps
 *     reporting whether or not anybody has the terminal open.
 *   - What the process prints, for everything else. Most of these tools set the
 *     window title to say whether they are thinking or waiting, which is enough
 *     to separate working from idle and nothing more.
 *
 * Both are normalised into the one vocabulary below before anything stores or
 * renders them, so a screen never branches on which vendor it is looking at, and
 * a tool gaining hooks later does not change a single consumer.
 *
 * Pure: the state machine is a function of the events, so a session's history can
 * be replayed and asserted without a machine, a container or a terminal.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Where a session is, from the point of view of somebody deciding whether to look
 * at it.
 *
 * The distinction that matters is `waiting` against `idle`. Both are a process
 * that is not computing, and they mean opposite things: `waiting` is the agent
 * blocked on a person - a permission prompt, a question it asked - and is the
 * only state that should ever interrupt anybody. `idle` is a finished turn, which
 * is a session you may come back to whenever you like.
 */
export const AGENT_SESSION_STATES = [
    "starting",
    "working",
    "waiting",
    "idle",
    "stopped",
    "failed"
] as const;
export type AgentSessionState = (typeof AGENT_SESSION_STATES)[number];

export const AGENT_SESSION_STATE_LABELS: Record<AgentSessionState, string> = {
    starting: "Starting",
    working: "Working",
    waiting: "Needs you",
    idle: "Waiting for you",
    stopped: "Stopped",
    failed: "Failed"
};

/** A session nobody can send anything to any more. */
export function isSessionOver(state: AgentSessionState): boolean {
    return state === "stopped" || state === "failed";
}

/** A session that is not computing but is still alive, so a prompt would land. */
export function isSessionListening(state: AgentSessionState): boolean {
    return state === "waiting" || state === "idle";
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Everything a session can report, whichever tool is running.
 *
 * Named for what happened rather than for the vendor event that produced it:
 * Claude's `Stop`, another tool's `turn_complete` and a terminal going quiet are
 * all `turn.end` here, and the adapter that normalises them is the only code that
 * has to know the difference.
 */
export const AGENT_SESSION_EVENTS = [
    "session.start",
    "prompt",
    "tool.start",
    "tool.end",
    "tool.failed",
    "permission",
    "question",
    "subagent.start",
    "subagent.end",
    "compact",
    "turn.end",
    "session.end",
    "error"
] as const;
export type AgentSessionEventKind = (typeof AGENT_SESSION_EVENTS)[number];

export function isAgentSessionEvent(value: string): value is AgentSessionEventKind {
    return (AGENT_SESSION_EVENTS as readonly string[]).includes(value);
}

/**
 * One thing that happened, as stored.
 *
 * `detail` is whatever the event is about in one line - the tool being run, the
 * command a permission prompt is asking about, the question. It is shown to a
 * person, so it is prose and never parsed. `at` is when Polaris received it, never
 * when the tool says it happened: a clock on somebody else's machine is not a
 * clock this instance can order anything by.
 */
export interface AgentSessionEvent {
    readonly kind: AgentSessionEventKind;
    readonly detail: string;
    readonly at: Date;
}

/**
 * The state an event leaves a session in, or null for one that says nothing about
 * it.
 *
 * A tool call says the agent is working even if the turn began before Polaris was
 * watching, which is what makes a reattached session settle into the right state
 * without being told. `tool.end` deliberately says nothing: a turn is a sequence
 * of tool calls, and treating the end of one as the end of the turn would flicker
 * the session to idle between every edit.
 */
export function stateAfterEvent(kind: AgentSessionEventKind): AgentSessionState | null {
    switch (kind) {
        case "session.start":
        case "compact":
        case "tool.start":
        case "subagent.start":
        case "prompt":
            return "working";
        case "permission":
        case "question":
            return "waiting";
        case "turn.end":
            return "idle";
        case "session.end":
            return "stopped";
        case "error":
            return "failed";
        default:
            return null;
    }
}

/**
 * Where a run of events leaves a session, starting from `initial`.
 *
 * Order is the caller's: events arrive over HTTP from a machine that may retry, so
 * the reducer is only ever handed a sequence somebody has already put in receipt
 * order. Replaying the whole run is what recovers a session whose state column was
 * written by a build that did not know an event yet.
 */
export function replaySessionState(
    events: readonly { kind: AgentSessionEventKind }[],
    initial: AgentSessionState = "starting"
): AgentSessionState {
    let state = initial;
    for (const event of events) {
        const next = stateAfterEvent(event.kind);
        if (next) state = next;
    }
    return state;
}

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

/**
 * Text on its way into a running agent's terminal, made inert first.
 *
 * This is a security boundary, not tidying. A prompt can come from a Linear issue,
 * a task description, a pull request comment - text a stranger wrote - and it is
 * delivered by writing it into a terminal that a full-screen program is reading.
 * An escape character in it is not content: it is a command to that program, and a
 * well-chosen run of them can move the cursor, redraw the screen, or submit
 * something the person watching never saw. Every escape is therefore replaced with
 * a visible marker rather than stripped, so a prompt that contained one still says
 * so instead of quietly losing a character.
 *
 * Carriage returns go too, for the same reason with a blunter effect: one of them
 * in the middle of a pasted prompt submits half of it.
 */
export function sanitizeAgentPrompt(text: string): string {
    return text
        .replace(/\u001b/g, "<ESC>")
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** The terminal's bracketed-paste markers. Inside them a full-screen program
 *  treats the whole run as pasted text rather than as keys, which is what stops a
 *  newline in a long prompt submitting it early. */
export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";
export const SUBMIT = "\r";

/**
 * The bytes that deliver `text` to an agent's terminal as one prompt.
 *
 * Returned as two pieces rather than one string because they are not sent
 * together: the paste has to be ingested by the program before the newline that
 * submits it means anything, and how long that takes is a property of the
 * transport rather than of the prompt. The caller waits between them.
 */
export function promptKeystrokes(text: string): { paste: string; submit: string } {
    return { paste: `${PASTE_START}${sanitizeAgentPrompt(text)}${PASTE_END}`, submit: SUBMIT };
}

/**
 * How long to wait after the paste before submitting, for a prompt of this size.
 *
 * A paste is not delivered instantly: it crosses a socket, a daemon and a
 * pseudo-terminal, and the program on the far end has to attach the whole run
 * before a newline can mean "send that". Submitting early sends half a prompt,
 * which reads to the person watching as the agent ignoring what they typed. The
 * floor covers the fixed cost and the slope covers the bytes; neither is capped,
 * because a cap is exactly the mid-paste submit this exists to prevent.
 */
export function promptSubmitDelayMs(byteLength: number): number {
    const settle = 500;
    if (!Number.isFinite(byteLength) || byteLength <= 0) return settle;
    return settle + Math.ceil(byteLength / 4096);
}

// ---------------------------------------------------------------------------
// Where a session runs
// ---------------------------------------------------------------------------

/**
 * The machine a session's process lives on.
 *
 * `local` is a container on the Polaris box, started through the host daemon the
 * same way a deployed service is - isolated, disposable, and gone when the session
 * ends. `host` is an enrolled server reached over SSH, which is what an operator
 * picks when the work needs the machine that already has the toolchain, the caches
 * and the agent's own login on it.
 *
 * There is no third option that runs on the operator's laptop. Polaris is a
 * control plane and cannot reach into a machine that has not enrolled with it.
 */
export const AGENT_SESSION_PLACES = ["local", "host"] as const;
export type AgentSessionPlace = (typeof AGENT_SESSION_PLACES)[number];

export const AGENT_SESSION_PLACE_LABELS: Record<AgentSessionPlace, string> = {
    local: "This Polaris box",
    host: "An enrolled server"
};

/**
 * The branch name a session works on.
 *
 * One worktree per session is the whole reason several agents can be pointed at
 * one repository at once, and a worktree needs a branch nothing else is on. The
 * session id is in the name because it is the only thing guaranteed unique, and
 * the label in front of it is there so the branch list stays readable to a person
 * who did not start the session.
 */
export function sessionBranchName(sessionId: string, label: string): string {
    const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    const short = sessionId.replace(/-/g, "").slice(0, 8);
    return slug ? `agent/${slug}-${short}` : `agent/${short}`;
}
