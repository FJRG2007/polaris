/**
 * The Deploy API as plain text, for callers that cannot parse JSON.
 *
 * The CLI is a shell script, and a shell script with no `jq` has no business
 * parsing a JSON response - so every listing can also be asked for as a
 * tab-separated table (`?format=text`), which `cut` and `column` read and a
 * person reads without either. Pure, so what the CLI prints can be pinned in a
 * test.
 */

/** A field made safe for one cell of a tab-separated line. */
function cell(value: unknown): string {
    if (value === null || value === undefined || value === "") return "-";
    return String(value).replace(/[\t\r\n]+/g, " ");
}

/** Rows as a table: a header line of column names, then one line per row. */
export function textTable<Row>(
    rows: readonly Row[],
    columns: readonly (readonly [string, (row: Row) => unknown])[]
): string {
    const header = columns.map(([name]) => name).join("\t");
    const body = rows.map((row) => columns.map(([, read]) => cell(read(row))).join("\t"));
    return `${[header, ...body].join("\n")}\n`;
}

/** The RFC 3339 timestamp Docker puts at the start of a line with `--timestamps`. */
const LEADING_STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z/;

/**
 * A timestamp in a form that sorts as text.
 *
 * Docker writes nanoseconds with the trailing zeros dropped, so `.5Z` and
 * `.123456789Z` are both possible and do not compare as strings. Padding the
 * fraction to nine digits makes them do so, which a `Date` cannot - it keeps
 * milliseconds, and two lines in the same millisecond would collapse into one.
 */
function sortable(stamp: string): string | null {
    const match = LEADING_STAMP.exec(stamp);
    if (!match) return null;
    return `${match[1]}.${(match[2] ?? "").padEnd(9, "0").slice(0, 9)}`;
}

/**
 * The lines of a container log written after `since`.
 *
 * How a follow prints each line once: the poller keeps the stamp of the last
 * line it printed and asks for what came after. A line with no stamp of its own
 * belongs to the stamped line above it (a stack trace, a wrapped message) and is
 * kept or dropped with that line. An unreadable `since` returns everything,
 * because printing a line twice is better than never printing it.
 */
export function linesSince(log: string, since: string): string {
    const threshold = sortable(since);
    if (!threshold) return log;
    const kept: string[] = [];
    let keeping = false;
    for (const line of log.split("\n")) {
        const stamp = sortable(line);
        if (stamp !== null) keeping = stamp > threshold;
        if (keeping) kept.push(line);
    }
    return kept.join("\n");
}
