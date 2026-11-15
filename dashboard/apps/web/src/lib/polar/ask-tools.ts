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
import { POLAR_FORM_TOOL, polarFormSchema } from "@/lib/polar/forms";
import { POLAR_ASK_TOOL, distinctQuestions, polarAskInputSchema, polarAskOutputSchema } from "@/lib/polar/ask";

const ASK_DESCRIPTION = [
    "Ask the person one to four questions with options and wait for the answer before going on.",
    "Use it when you cannot go further without a choice only they can make: which of several reasonable ways to take, a preference, a missing detail with a small set of likely values.",
    "Do not use it for something you can find out with another tool, for a yes or no you can simply ask in words, or to confirm what they already said.",
    "Each question: question (the full sentence), header (a label of 1-3 words), options (2-9, each a short label and an optional description), multiSelect true when several may apply.",
    "The person can always type something else or skip; the answer comes back as this tool's result. Do not list the options again in your text."
].join(" ");

const FORM_DESCRIPTION = [
    "Show the person a small form inside your answer when you need several details from them at once, such as the fields of a request, a booking, a survey or a rating.",
    "Fields (1-12, each with a unique id and a short label): text, textarea, choice (options 2-12, multiple true for several), rating (max 3-10 stars), number (optional min, max, step), date (optional min, max as YYYY-MM-DD). Mark required fields with required true.",
    "Optional title, description and submitLabel. What they submit arrives as their next message, one line per field.",
    "Use polar_ask instead for a single choice; do not use a form for one free-text answer."
].join(" ");

export function polarAskTools(): ToolSet {
    return {
        [POLAR_ASK_TOOL]: tool({
            description: ASK_DESCRIPTION,
            inputSchema: polarInputSchema(polarAskInputSchema, distinctQuestions),
            outputSchema: polarInputSchema(polarAskOutputSchema)
        }),
        [POLAR_FORM_TOOL]: tool({
            description: FORM_DESCRIPTION,
            inputSchema: polarInputSchema(polarFormSchema),
            async execute() {
                return {
                    ok: true,
                    text: "The form is on screen. Stop here; the answers arrive as the person's next message."
                };
            }
        })
    };
}
