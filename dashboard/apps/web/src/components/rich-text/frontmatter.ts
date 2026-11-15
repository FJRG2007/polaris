/**
 * A leading YAML frontmatter block, kept out of the rich editor.
 *
 * The editor reads `---` as a rule and `key: value` over another `---` as a
 * heading, so a skill file or a page that opens with frontmatter would come back
 * rewritten. The block is split off before the text reaches the editor and put
 * back, byte for byte, in front of what the editor hands back.
 */

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** The frontmatter block exactly as written (empty when there is none), and the rest. */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
    const match = FRONTMATTER.exec(text);
    if (!match) return { frontmatter: "", body: text };
    const frontmatter = match[0];
    return { frontmatter, body: text.slice(frontmatter.length).replace(/^(?:\r?\n)+/, "") };
}

/** The inverse of `splitFrontmatter`, with one blank line between the two. */
export function joinFrontmatter(frontmatter: string, body: string): string {
    if (!frontmatter) return body;
    const head = /\n$/.test(frontmatter) ? frontmatter : `${frontmatter}\n`;
    return body ? `${head}\n${body}` : head;
}
