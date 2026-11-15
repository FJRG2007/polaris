/**
 * The two tools Polar puts something in front of the person with and waits
 * on: `polar_ask` (`ask.ts`), which has no `execute` so the turn ends on the
 * call and the answer comes back as its output, and `polar_form` (`forms.ts`),
 * which only draws the form and says so; what is typed into it arrives as the
 * person's next message. Neither changes anything, so neither asks for an
 * approval, and neither is handed to a subagent, which has nobody to ask.
 *
 * Server-only by use.
 */

import { tool, type ToolSet } from "ai";
import { polarInputSchema } from "@/lib/polar/tool-input";
import { POLAR_ASK_TOOL, polarAskInputSchema, polarAskOutputSchema } from "@/lib/polar/ask";

const ASK_DESCRIPTION = [
    "Ask the person one to four questions with options and wait for the answer before going on.",
    "Use it when you cannot go further without a choice only they can make: which of several reasonable ways to take, a preference, a missing detail with a small set of likely values.",
    "Do not use it for something you can find out with another tool, for a yes or no you can simply ask in words, or to confirm what they already said.",
    "Each question: question (the full sentence), header (a label of 1-3 words), options (2-9, each a short label and an optional description), multiSelect true when several may apply.",
    "The person can always type something else or skip; the answer comes back as this tool's result. Do not list the options again in your text."
].join(" ");

export function polarAskTools(): ToolSet {
    return {
        [POLAR_ASK_TOOL]: tool({
            description: ASK_DESCRIPTION,
            inputSchema: polarInputSchema(polarAskInputSchema),
            outputSchema: polarAskOutputSchema
        })
    };
}
