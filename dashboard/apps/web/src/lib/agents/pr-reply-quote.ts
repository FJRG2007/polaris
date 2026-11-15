/**
 * Ported from frontend/src/renderer/components/PRComments.tsx (`replyQuote`)
 * of Agent Orchestrator (Apache-2.0, commit e4ded08c6f15).
 *
 * Pure, so the pull request tab imports it without the server reader.
 */

/** GitHub's own ceiling on a comment's body. */
export const COMMENT_MAX = 65_536;

/**
 * What a reply to a top-level comment opens with, as AO writes it: its first
 * paragraph quoted (cut at a word past 240 characters) and an @mention, so the
 * author is told without pasting a whole bot summary back.
 */
export function replyQuote(login: string, text: string): string {
    let excerpt = text.trim().split(/\n\s*\n/)[0] ?? "";
    if (!excerpt.trim()) return `@${login} `;
    if (excerpt.length > 240) {
        const space = excerpt.lastIndexOf(" ", 240);
        excerpt = excerpt.slice(0, space > 0 ? space : 240);
    }
    const quoted = excerpt
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n");
    return `${quoted}\n\n@${login} `;
}
