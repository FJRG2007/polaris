/**
 * The reader's side of a followed log: lines from several containers merged into
 * one list in time order, none of them twice, and turned into the text the log
 * viewer reads.
 *
 * Twice is the case worth a module. A follow starts from a tail, so every time
 * one is opened again - after a pause, after a dropped connection, after a
 * deploy - the first lines it sends are lines already on screen. Each container
 * remembers the newest stamp it has shown, and anything at or before it is a
 * copy.
 *
 * Pure, so the rules are asserted in tests rather than found out on screen.
 */

/** One line as the stream sends it. */
export interface StreamLine {
    readonly serviceId: string;
    readonly container: string;
    readonly stamp: string | null;
    readonly text: string;
}

/** The most lines a followed view holds; older ones fall off the top. */
export const STREAM_CAP = 5000;

function sourceOf(line: StreamLine): string {
    return `${line.serviceId}/${line.container}`;
}

/**
 * `existing` with `incoming` added: copies dropped, time order kept, and the
 * list held to `cap`. `seen` is the newest stamp shown per container and is
 * updated in place. Unstamped lines are kept in arrival order - there is no
 * telling a copy of one from a new one, and dropping real output is worse.
 */
export function mergeStreamLines(
    existing: readonly StreamLine[],
    incoming: readonly StreamLine[],
    seen: Map<string, string>,
    cap = STREAM_CAP
): StreamLine[] {
    const fresh: StreamLine[] = [];
    for (const line of incoming) {
        if (line.stamp !== null) {
            const source = sourceOf(line);
            const last = seen.get(source);
            if (last !== undefined && line.stamp <= last) continue;
            seen.set(source, line.stamp);
        }
        fresh.push(line);
    }
    if (fresh.length === 0) return existing as StreamLine[];

    const merged = [...existing, ...fresh];
    // Replicas are followed separately and their batches cross, so a batch can
    // carry a line older than one already shown. Only then is a sort needed.
    const newestShown = lastStamp(existing);
    const oldestFresh = fresh.reduce<string | null>(
        (oldest, line) =>
            line.stamp !== null && (oldest === null || line.stamp < oldest) ? line.stamp : oldest,
        null
    );
    if (newestShown !== null && oldestFresh !== null && oldestFresh < newestShown) {
        stableSortByStamp(merged);
    } else if (fresh.length > 1) {
        // A batch from several containers is ordered by arrival within itself.
        const sortedTail = fresh.slice();
        stableSortByStamp(sortedTail);
        merged.splice(existing.length, fresh.length, ...sortedTail);
    }
    return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

function lastStamp(lines: readonly StreamLine[]): string | null {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const stamp = lines[index]?.stamp;
        if (stamp) return stamp;
    }
    return null;
}

/**
 * Sort by stamp and keep arrival order for ties. An unstamped line borrows the
 * stamp of the line before it, so it stays next to the output it came with.
 */
function stableSortByStamp(lines: StreamLine[]): void {
    let carried = "";
    const keyed = lines.map((line, index) => {
        if (line.stamp !== null) carried = line.stamp;
        return { line, index, stamp: line.stamp ?? carried };
    });
    keyed.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.index - b.index));
    for (let index = 0; index < keyed.length; index += 1)
        lines[index] = (keyed[index] as { line: StreamLine }).line;
}

/**
 * The text the log viewer reads: the stamp first, where it lifts it into its
 * gutter, then the container in brackets when more than one is on screen - a
 * name on every line of a single container's output is only noise.
 */
export function formatStreamLog(lines: readonly StreamLine[], labelled: boolean): string {
    return lines
        .map((line) => {
            const body = labelled ? `[${line.container}] ${line.text}` : line.text;
            return line.stamp ? `${line.stamp} ${body}` : body;
        })
        .join("\n");
}
