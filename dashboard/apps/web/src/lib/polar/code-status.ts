/**
 * The status line under a Code session's reply box, as Claude Code's own
 * status line shows it (https://code.claude.com/docs/en/statusline): model,
 * effort, how full the context is, what the session cost, and the branch.
 *
 * Every part comes from what the session already reports - the model and the
 * context from the agent's transcript, the cost summed from the same, the
 * effort and branch from the session - and a part nobody reported is left
 * out rather than guessed. Client-safe and pure.
 */

export interface CodeStatusInput {
    readonly model: string | null;
    readonly effort: string | null;
    readonly context: { readonly used: number; readonly window: number } | null;
    readonly costUsd: number | null;
    readonly branch: string;
}

export type CodeStatusPart =
    | { readonly kind: "model"; readonly value: string }
    | { readonly kind: "effort"; readonly value: string }
    | { readonly kind: "context"; readonly percent: number }
    | { readonly kind: "cost"; readonly usd: number }
    | { readonly kind: "branch"; readonly value: string };

/** A transcript model id without its date stamp ("claude-sonnet-4-5-20250929"
 *  reads "claude-sonnet-4-5"). */
export function shownModel(model: string): string {
    return model.replace(/-\d{8}$/, "");
}

/** How much of the window is used, 0-100, rounded down like Claude Code's own
 *  `used_percentage` reads. */
export function contextPercent(used: number, window: number): number {
    if (window <= 0) return 0;
    return Math.min(100, Math.max(0, Math.floor((used / window) * 100)));
}

/** The parts to draw, in order, leaving out whatever is not known. */
export function codeStatusParts(input: CodeStatusInput): CodeStatusPart[] {
    const parts: CodeStatusPart[] = [];
    if (input.model) parts.push({ kind: "model", value: shownModel(input.model) });
    if (input.effort) parts.push({ kind: "effort", value: input.effort });
    if (input.context && input.context.window > 0)
        parts.push({ kind: "context", percent: contextPercent(input.context.used, input.context.window) });
    if (input.costUsd !== null && input.costUsd > 0) parts.push({ kind: "cost", usd: input.costUsd });
    if (input.branch) parts.push({ kind: "branch", value: input.branch });
    return parts;
}
