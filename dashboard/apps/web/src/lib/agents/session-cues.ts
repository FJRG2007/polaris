/**
 * Cues: a repository's standing instructions, handed to every session started on
 * it. Set once on the repository ("run the linter before committing", "never
 * touch the generated folder") instead of typed into each session's first prompt.
 *
 * They travel with the first prompt rather than as a file in the checkout: a file
 * would be one the agent can commit, and the agents read different file names.
 * Pure, so the shape the agent reads is asserted in a test.
 */

import { z } from "zod";

/** Longest set of cues a repository may keep: a page of guidance, not a manual. */
export const REPO_CUES_MAX = 4000;

/** Cues as a form sends them: trimmed, bounded. Empty is none. */
export const repoCuesSchema = z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().max(REPO_CUES_MAX));

/** The first prompt with the repository's cues ahead of it. No cues, no change. */
export function withCues(cues: string | null | undefined, prompt: string): string {
    const standing = cues?.trim() ?? "";
    if (!standing) return prompt;
    return [
        "Standing instructions for this repository (they apply to the whole session):",
        standing,
        "",
        "---",
        "",
        prompt
    ].join("\n");
}
