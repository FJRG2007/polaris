/**
 * Reading a pasted `.env`. Pure, so the variables editor can stage what was
 * pasted for review in the browser, and the server can import it the same way.
 */

/**
 * Parse a pasted .env blob into key/value pairs. Tolerates `export`, comments,
 * blank lines, surrounding single/double quotes, and inline `#` comments on
 * unquoted values. Values keep internal spaces.
 */
export function parseDotEnv(text: string): Array<{ key: string; value: string }> {
    const out: Array<{ key: string; value: string }> = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match || !match[1]) continue;
        const key = match[1];
        let value = (match[2] ?? "").trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        } else {
            // Strip a trailing inline comment on an unquoted value.
            const hash = value.indexOf(" #");
            if (hash >= 0) value = value.slice(0, hash).trim();
        }
        out.push({ key, value });
    }
    return out;
}
