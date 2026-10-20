/**
 * The tool Polar draws a view with (`visuals.ts`). It changes nothing, so it
 * never asks for an approval; its input is the view, checked against the
 * catalogue before the call counts, and its answer only tells the model the
 * view is on screen, so it carries on in words instead of repeating it.
 *
 * Server-only by use.
 */

import { tool, type ToolSet } from "ai";
import { polarInputSchema } from "@/lib/polar/tool-input";
import { POLAR_VISUAL_TOOL, polarVisualSchema } from "@/lib/polar/visuals";

const DESCRIPTION = [
    "Show the person a table, chart, row of figures, steps, comparison, small diagram or calculator inside your answer, drawn by Polaris.",
    "Use it when a picture is clearer than prose: options compared across several criteria, numbers over time or across items, 4+ items that share fields, an ordered procedure, how parts connect, or a sum the person will want to try with their own numbers.",
    "Do not use it for a single fact, a short list, or anything a sentence says as well. One view per idea; keep labels short.",
    "Kinds: table (columns + rows of cells), chart (type bar or line, categories on the x axis - dates as YYYY-MM-DD for a line over time - and up to 4 series with one value per category), stats (up to 8 figures), steps, comparison (2-5 options, rows of one value per option, optional pick = index of the recommended option), diagram (nodes with ids and edges between them), calculator (number fields with ids, and outputs whose formula uses those ids with + - * / % ^, parentheses, min max round floor ceil abs sqrt log exp pow).",
    "Write the surrounding explanation as normal text; do not restate every value of the view in words."
].join(" ");

export function polarVisualTools(): ToolSet {
    return {
        [POLAR_VISUAL_TOOL]: tool({
            description: DESCRIPTION,
            inputSchema: polarInputSchema(polarVisualSchema),
            async execute() {
                return { ok: true, text: "Shown to the person." };
            }
        })
    };
}
