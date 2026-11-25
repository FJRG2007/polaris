/**
 * Which turn of a Code session earns a suggested next message, read the same
 * way on the page (to know when to ask) and on the server (to know what to
 * write it from). Client-safe.
 *
 * Where the suggestion comes from. Claude Code writes its own after each turn
 * when asked (`--prompt-suggestions`, print mode with stream-json: one
 * `{ type: "prompt_suggestion", suggestion }` message after the turn's result;
 * the Agent SDK's `promptSuggestions` option is the same). Code sessions talk
 * to Claude Code through `@agentclientprotocol/claude-agent-acp`, which turns
 * that option on and forwards the text as
 * `session_info_update._meta.promptSuggestions` - but only to a client that
 * declares itself JetBrains AIR (`publishPromptSuggestion` returns early
 * otherwise, `dist/acp-agent.js` and `dist/prompt-suggestions.js` in 0.99.1).
 * Declaring that would switch on every other AIR-only shape the adapter has,
 * so Polaris does not, and the suggestion is written by Polar's own helper
 * model instead (`codePolarSuggestion` in `suggestions.ts`), with its spending
 * ceiling, on the same switch-off as Chat's.
 */

import type { PolarCodeEntry } from "@/lib/polar/code";
import type { AgentSessionState } from "@polaris/core";

/** States in which a turn has ended and the session waits for the person. */
const BETWEEN_TURNS: ReadonlySet<AgentSessionState> = new Set(["idle", "waiting"]);

export interface CodeSuggestionTurn {
    /** The agent's last message, which the suggestion answers. */
    answerId: string;
    asked: string;
    answered: string;
}

/**
 * The turn a suggestion follows, or null while one would be wrong: the agent
 * is still working, a permission is being asked (the next thing is a button),
 * the session is over, or the last thing said is not the agent's answer to
 * something the person said.
 */
export function codeSuggestionTurn(
    entries: readonly Pick<PolarCodeEntry, "id" | "type" | "role" | "text">[],
    session: { state: AgentSessionState; live: boolean },
    asking: boolean
): CodeSuggestionTurn | null {
    if (!session.live || asking || !BETWEEN_TURNS.has(session.state)) return null;
    const messages = entries.filter((entry) => entry.type === "message" && entry.text.trim());
    const answer = messages.at(-1);
    if (!answer || answer.role !== "agent") return null;
    const ask = [...messages].reverse().find((entry) => entry.role === "user");
    if (!ask) return null;
    return { answerId: answer.id, asked: ask.text, answered: answer.text };
}
