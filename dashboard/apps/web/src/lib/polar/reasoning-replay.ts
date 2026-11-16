/**
 * What of a model's earlier reasoning goes back to a model.
 *
 * None from an earlier turn: a provider that does not take reasoning back
 * refuses the whole call for it (OpenRouter's upstreams answer 400 "property
 * 'reasoning_content' is unsupported"), DeepSeek documents a 400 for its own
 * `reasoning_content` sent back, and Anthropic ignores thinking from earlier
 * turns. The answer the turn is still writing - a tool call waiting on its
 * approval - keeps its own, which Anthropic's signed thinking needs to carry
 * on; the router strips it again if another model continues
 * (`router/chain.ts`).
 *
 * Pure and isomorphic.
 */

import type { UIMessage } from "ai";

/** The conversation without the reasoning of any answer before the last
 *  message the person sent. An answer left with nothing but its step markers
 *  keeps them: it is the answer, not a failure. */
export function withoutEarlierReasoning<T extends UIMessage>(messages: readonly T[]): T[] {
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]!.role === "user") {
            lastUser = index;
            break;
        }
    }
    return messages.map((message, index) =>
        index < lastUser && message.role === "assistant" && message.parts.some((part) => part.type === "reasoning")
            ? { ...message, parts: message.parts.filter((part) => part.type !== "reasoning") }
            : message
    );
}
