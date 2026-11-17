/**
 * A Terminal session answered in Chat when somebody writes to it from Polar
 * Code, and given back to its terminal when somebody types there.
 *
 * The pattern is Happy's (slopus/happy, `happy-cli/src/claude/loop.ts`): a
 * message from the remote client stops the local interactive agent and the
 * same conversation carries on through the SDK, which streams; a key pressed
 * in the terminal stops the remote one and resumes the conversation there.
 * Here the remote side is the session's Chat driver (`session-driver.ts`):
 * Claude's adapter reopens a conversation with `session/load`, which resumes
 * the Claude session of the same id (claude-agent-acp `loadSession`), and
 * Codex's app-server with `thread/resume`. Only an agent whose terminal and
 * Chat open the same conversation by the same id hands off; for the others
 * Terminal stays Terminal until somebody switches.
 *
 * Never two agents on one conversation: going to Chat stops the terminal's
 * agent before the protocol agent starts (`terminalAgentStopCommand`, also run
 * by `startAcpAgent`), and the key that comes back stops the protocol agent
 * (`acpStopCommand`) before the terminal resumes.
 *
 * The terminal cannot be watched for keys from outside it - a person may be
 * attached through Polaris, SSH or a runner - so what waits for the key is a
 * small script left running in the terminal's own window (`chatHoldCommand`).
 * It writes `TERMINAL_BACK_FILE` once it has handed back, which the next
 * message reads (`terminalBackCommand`) to put the session in Terminal again.
 */

import * as core from "@polaris/core";
import { shellQuote } from "../session-hooks";
import * as commands from "../session-commands";
import { acpStopCommand } from "./pipe-commands";
import { chatAvailable, type SessionSurface } from "./providers";

/** The agents whose terminal and Chat reopen one conversation by one id. */
const HANDOFF_AGENTS: readonly string[] = ["claude", "codex"];

/** Written by the waiting script once the terminal has the conversation back. */
export const TERMINAL_BACK_FILE = "terminal-back";

/** The conversation Chat is on, for the waiting script to resume. */
export const CHAT_CONVERSATION_FILE = "chat-conversation";

/** What `terminalBackCommand` prints when the terminal took the session back. */
export const TERMINAL_BACK = "back";

/** Whether a Terminal session of this agent may be answered in Chat. Pure. */
export function handsOff(cli: string, place: core.AgentSessionPlace): boolean {
    return HANDOFF_AGENTS.includes(cli) && chatAvailable(cli, place);
}

export type RemoteTurnRoute = "chat" | "hand-off" | "terminal";

/**
 * Where a message from Polar Code goes. Pure.
 *
 * - "chat": the session already is in Chat.
 * - "hand-off": switch it to Chat first. Only from an idle terminal: one mid
 *   turn, or holding a question for the person, would lose that turn to the
 *   stop. Only with a conversation to reopen, or Chat would start a new one
 *   beside the terminal's. Not while Chat failed to start here lately.
 * - "terminal": typed into the terminal, as before.
 */
export function remoteTurnRoute(session: {
    cli: string;
    place: core.AgentSessionPlace;
    surface: SessionSurface;
    state: core.AgentSessionState;
    vendorSessionId: string | null;
    chatFailedRecently: boolean;
}): RemoteTurnRoute {
    if (session.surface === "chat") return "chat";
    if (!handsOff(session.cli, session.place)) return "terminal";
    if (session.state !== "idle") return "terminal";
    if (!session.vendorSessionId || !core.isVendorSessionId(session.vendorSessionId)) return "terminal";
    return session.chatFailedRecently ? "terminal" : "hand-off";
}

/** How long a Chat that would not start keeps the session's messages in its
 *  terminal before it is tried again. */
export const CHAT_RETRY_MS = 30 * 60_000;

/**
 * Leave a script waiting in the terminal's window, which Chat left at its
 * shell: on the first key it stops the protocol agent, says so, and resumes
 * the conversation there - the one Chat last recorded, else `vendorSessionId`.
 * Nothing for a session with a runner, whose turns read the conversation from
 * a file instead (`conversationHandBackCommand`).
 */
export function chatHoldCommand(stateDir: string, vendorSessionId: string, session = commands.TMUX_SESSION): string {
    if (!core.isVendorSessionId(vendorSessionId)) throw new Error("That is not a conversation Polaris can reopen.");
    const script = `${stateDir}/chat-hold.sh`;
    const body = [
        `rm -f "${stateDir}/${TERMINAL_BACK_FILE}"`,
        "printf '\\n%s\\n' 'Polar Code is answering in Chat. Press any key to carry on here.'",
        's="$(stty -g 2>/dev/null)"',
        "stty -icanon -echo min 1 time 0 2>/dev/null",
        "dd bs=1 count=1 >/dev/null 2>&1",
        '[ -n "$s" ] && stty "$s" 2>/dev/null',
        acpStopCommand(stateDir, session),
        `id="$(tr -dc 'A-Za-z0-9_-' < "${stateDir}/${CHAT_CONVERSATION_FILE}" 2>/dev/null | head -c 128)"`,
        `[ -n "$id" ] || id=${shellQuote(vendorSessionId)}`,
        `: > "${stateDir}/${TERMINAL_BACK_FILE}"`,
        'exec sh "$POLARIS_STATE_DIR/launch.sh" "$id"'
    ].join("\n");
    return [
        `[ -f "${stateDir}/${commands.RUNNER_READY_FILE}" ] && exit 0`,
        `cat > "${script}" <<'POLARIS_CHAT_HOLD'`,
        body,
        "POLARIS_CHAT_HOLD",
        `tmux send-keys -t ${shellQuote(session)} -l ${shellQuote(`sh "${script}"`)}`,
        `tmux send-keys -t ${shellQuote(session)} Enter`
    ].join("\n");
}

/** Record the conversation Chat is on, for the waiting script. */
export function chatConversationCommand(stateDir: string, vendorSessionId: string): string {
    if (!core.isVendorSessionId(vendorSessionId)) throw new Error("That is not a conversation Polaris can reopen.");
    return `printf %s ${shellQuote(vendorSessionId)} > "${stateDir}/${CHAT_CONVERSATION_FILE}"`;
}

/** Print `TERMINAL_BACK` (and clear the mark) when the terminal took the
 *  session back since the last message. */
export function terminalBackCommand(stateDir: string): string {
    return `if [ -f "${stateDir}/${TERMINAL_BACK_FILE}" ]; then rm -f "${stateDir}/${TERMINAL_BACK_FILE}" "${stateDir}/${CHAT_CONVERSATION_FILE}"; echo ${TERMINAL_BACK}; fi`;
}

/** End a script still waiting for its key - not one that already took it and
 *  became the terminal's agent - so a switch back that types the resume into
 *  the window does not hand it that key. */
export function chatHoldStopCommand(): string {
    return "for p in $(ps -eo pid=,args= 2>/dev/null | grep '[c]hat-hold[.]sh' | awk '{print $1}'); do kill \"$p\" 2>/dev/null; done; exit 0";
}
