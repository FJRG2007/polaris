/**
 * Reading a pasted `.env`. Pure, so the variables editor can stage what was
 * pasted for review in the browser, and the server can import it the same way.
 */

const ESCAPE = /\\([nrt"\\])/g;
const ESCAPED: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t" };

/**
 * Parse a pasted .env blob into key/value pairs. Tolerates `export`, comments,
 * blank lines, surrounding single/double quotes, and inline `#` comments on
 * unquoted values. Values keep internal spaces. With `escapes`, a double-quoted
 * value also reads `\n`, `\r`, `\t`, `\"` and `\\` as the characters they stand
 * for, the way Docker Compose reads an env file; any other backslash is kept as
 * typed.
 */
export function parseDotEnv(
    text: string,
    options: { readonly escapes?: boolean } = {}
): Array<{ key: string; value: string }> {
    const out: Array<{ key: string; value: string }> = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match || !match[1]) continue;
        const key = match[1];
        let value = (match[2] ?? "").trim();
        const doubled = value.startsWith('"') && value.endsWith('"');
        if (doubled || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
            if (doubled && options.escapes)
                value = value.replace(ESCAPE, (_, char: string) => ESCAPED[char] ?? char);
        } else {
            // Strip a trailing inline comment on an unquoted value.
            const hash = value.indexOf(" #");
            if (hash >= 0) value = value.slice(0, hash).trim();
        }
        out.push({ key, value });
    }
    return out;
}
