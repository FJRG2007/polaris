/**
 * The last 24 hours of the query log, followed as the engine writes it.
 *
 * Reading both days' files whole on every ask copies about 20 MB out of the
 * container and parses every line again. A follower remembers, per day file,
 * how far it has read and what those lines added up to, bar by bar, and asks
 * the file only for what was written since. The window then moves on by
 * dropping the bars that fell out of it. A new day starts a file of its own,
 * and a file that got shorter is read again from its start.
 *
 * Unfiltered only: the numbers do not depend on a filter, but the rows kept
 * for the pages do, and one set of them is what keeps this bounded.
 */

import {
    QUERY_ROWS_KEPT,
    QueryBar,
    QueryLogReader,
    parseQueryLine,
    queryFilterSchema,
    queryLogPath,
    type QueryRow,
    type QueryWindow
} from "./query-log";

/** What a followed file is read through. */
export interface LogSource {
    /**
     * The file's size in bytes and its bytes from `from` on, in pieces that
     * follow on from one another (at least up to that size), or null when there
     * is no such file. A piece may end anywhere.
     */
    open(
        path: string,
        from: number
    ): Promise<{ size: number; pieces: AsyncIterable<Uint8Array> } | null>;
}

export interface FollowedRead {
    /** Whether any of the window's files was there. */
    readonly found: boolean;
    readonly reader: QueryLogReader;
}

interface Followed {
    /** Bytes read so far, always just past a whole line. */
    offset: number;
    /** The file's bars in the order its lines first reached them. */
    readonly bars: Map<number, QueryBar>;
    /** The newest rows read, oldest first, for the log's pages. */
    rows: QueryRow[];
}

const { page: _page, ...UNFILTERED } = queryFilterSchema.parse({});

const NEWLINE = 0x0a;

const followed = (): Followed => ({ offset: 0, bars: new Map(), rows: [] });

export class QueryLogFollower {
    private readonly files = new Map<string, Followed>();
    private from = Number.NEGATIVE_INFINITY;
    private bucketMs = 0;
    private queue: Promise<unknown> = Promise.resolve();

    public constructor(private readonly source: LogSource) {}

    /**
     * The window's numbers and newest rows, the same as one `QueryLogReader`
     * reading every file of it from the start. Asks one at a time, so two never
     * fold the same lines in twice.
     */
    public read(window: QueryWindow): Promise<FollowedRead> {
        const run = this.queue.then(async () => {
            await this.catchUp(window);
            return this.answer(window);
        });
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async catchUp(window: QueryWindow): Promise<void> {
        // A clock set back, or a different bar width: what is held no longer
        // lines up with the window, so it starts over.
        if (window.from < this.from || window.bucketMs !== this.bucketMs) this.files.clear();
        this.from = window.from;
        this.bucketMs = window.bucketMs;
        const paths = window.days.map(queryLogPath);
        for (const path of this.files.keys()) if (!paths.includes(path)) this.files.delete(path);
        for (const path of paths) await this.catchUpFile(path, window);
    }

    private async catchUpFile(path: string, window: QueryWindow): Promise<void> {
        let file = this.files.get(path) ?? followed();
        let opened = await this.source.open(path, file.offset);
        if (opened && opened.size < file.offset) {
            // Shorter than what was read: rewritten, so read again whole.
            file = followed();
            opened = await this.source.open(path, 0);
        }
        if (!opened) {
            this.files.delete(path);
            return;
        }
        this.files.set(path, file);
        // Cut on the newline byte and decoded a run of whole lines at a time, so
        // the offset counts the file's own bytes whatever they hold. A last
        // line with no newline yet is still being written: it is left for the
        // next ask, which reads it whole.
        const decoder = new TextDecoder();
        let rest = new Uint8Array(0);
        for await (const piece of opened.pieces) {
            const bytes = rest.length > 0 ? Buffer.concat([rest, piece]) : piece;
            const cut = bytes.lastIndexOf(NEWLINE);
            if (cut < 0) {
                rest = bytes;
                continue;
            }
            for (const line of decoder.decode(bytes.subarray(0, cut)).split("\n"))
                this.fold(file, line, window);
            file.offset += cut + 1;
            rest = bytes.slice(cut + 1);
        }
        for (const start of file.bars.keys())
            if (start + window.bucketMs <= window.from) file.bars.delete(start);
        if (file.rows.length > 0 && file.rows[0]!.at < window.from)
            file.rows = file.rows.filter((row) => row.at >= window.from);
    }

    private fold(file: Followed, line: string, window: QueryWindow): void {
        const row = parseQueryLine(line);
        // Behind the window: it can only fall further behind.
        if (!row || !(row.at >= window.from)) return;
        const start = Math.floor(row.at / window.bucketMs) * window.bucketMs;
        let bar = file.bars.get(start);
        if (!bar) {
            bar = new QueryBar(start);
            file.bars.set(start, bar);
        }
        bar.add(row);
        file.rows.push(row);
        if (file.rows.length > QUERY_ROWS_KEPT * 2)
            file.rows.splice(0, file.rows.length - QUERY_ROWS_KEPT);
    }

    private answer(window: QueryWindow): FollowedRead {
        const reader = new QueryLogReader(UNFILTERED, window);
        let found = false;
        for (const path of window.days.map(queryLogPath)) {
            const file = this.files.get(path);
            if (!file) continue;
            found = true;
            for (const bar of file.bars.values()) reader.addBar(bar);
            reader.addRows(file.rows);
        }
        return { found, reader };
    }
}
