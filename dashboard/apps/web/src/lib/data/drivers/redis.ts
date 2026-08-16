/**
 * Redis, read as numbered databases of keys.
 *
 * There are no tables here, so the browser is given one pseudo-relation per
 * database - its keys - and a page of it is a page of the keyspace: the key, what
 * type it holds, how long it has left and how big it is. That is what somebody
 * opening a cache actually wants to see, and it is the honest shape of the
 * thing.
 *
 * Paging is a cursor, not an offset. `SCAN` is the only safe way through a
 * keyspace - `KEYS *` blocks the server for as long as it takes - and a cursor
 * is what it hands back, so the page carries one on for the next request. It
 * also means the count on a page is approximate and the pages are not evenly
 * sized, which is Redis being honest rather than the browser being wrong.
 *
 * A value is fetched for the key somebody opens, one key at a time, and never
 * for a page: a page of a keyspace with a hundred-megabyte value in it must not
 * be a hundred megabytes.
 */

import Redis from "ioredis";
import * as data from "../driver";
import { redisCommandWrites } from "@polaris/core";

/** How many keys one SCAN asks the server to look at. Not the page size: SCAN
 *  returns what it found in that window, which may be none. */
const SCAN_COUNT = 500;

/** The most elements of a collection value that are read for a preview. */
const VALUE_ELEMENTS = 200;

export class RedisDriver implements data.DataDriver {
    readonly shape = "keyvalue" as const;
    private client: Redis | null = null;
    private openedDb = 0;

    constructor(private readonly address: data.DataAddress) {}

    private async open(db = 0): Promise<Redis> {
        if (this.client && this.openedDb === db) return this.client;
        await this.close();
        const client = new Redis({
            host: this.address.host,
            port: this.address.port,
            username: this.address.username || undefined,
            password: this.address.password || undefined,
            db,
            tls: this.address.tls ? { rejectUnauthorized: false } : undefined,
            connectTimeout: 8000,
            commandTimeout: 30_000,
            // One attempt. A browser waiting on a screen is not a worker that
            // should sit in a reconnect loop - if it is down, say so.
            maxRetriesPerRequest: 1,
            retryStrategy: () => null,
            lazyConnect: true,
            connectionName: "polaris-data-browser"
        });
        await client.connect();
        this.client = client;
        this.openedDb = db;
        return client;
    }

    async version(): Promise<string> {
        const info = await this.info("server");
        const version = /redis_version:([^\r\n]+)/.exec(info)?.[1];
        return version ? `Redis ${version}` : "Redis";
    }

    /** Everything the server will say about itself, as it says it: one blob of
     *  `field:value` lines. Read by the stats panel, which is the one caller that
     *  wants the whole of it rather than one field. */
    async info(section?: string): Promise<string> {
        const client = await this.open(this.openedDb);
        return section ? client.info(section) : client.info();
    }

    /**
     * The numbered databases, and how many keys are in each.
     *
     * `INFO keyspace` names only the ones that have keys in them, so the empty
     * ones are filled in from the configured count - somebody moving data into
     * db 3 has to be able to open db 3 before it has anything in it.
     */
    async namespaces(): Promise<data.DataNamespace[]> {
        const client = await this.open();
        const info = await client.info("keyspace");
        const counts = new Map<number, number>();
        for (const line of info.split(/\r?\n/)) {
            const match = /^db(\d+):keys=(\d+)/.exec(line);
            if (match) counts.set(Number(match[1]), Number(match[2]));
        }
        let total = 16;
        try {
            const configured = await client.config("GET", "databases");
            const value = Array.isArray(configured) ? Number(configured[1]) : NaN;
            if (Number.isFinite(value) && value > 0) total = value;
        } catch {
            // A managed Redis often refuses CONFIG. Sixteen is the default and
            // the keyspace above still names any that exist beyond it.
        }
        const highest = Math.max(total, ...[...counts.keys()].map((db) => db + 1));
        return Array.from({ length: highest }, (_unused, db) => ({
            name: String(db),
            kind: "keyspace" as const,
            count: counts.get(db) ?? 0
        }));
    }

    /** One list of keys per database. There is nothing else in a Redis to list. */
    async relations(namespace: string | null): Promise<data.DataRelation[]> {
        const db = dbOf(namespace);
        const client = await this.open(db);
        const size = await client.dbsize();
        return [{ name: "keys", namespace: String(db), kind: "keys", rows: size }];
    }

    async columns(): Promise<data.DataColumn[]> {
        return KEY_COLUMNS;
    }

    async rows(
        namespace: string | null,
        _relation: string,
        query: data.RowQuery
    ): Promise<data.DataPage> {
        const db = dbOf(namespace);
        const client = await this.open(db);
        const match = query.filter?.trim() ? `*${query.filter.trim()}*` : "*";

        const [next, keys] = await client.scan(
            query.cursor ?? "0",
            "MATCH",
            match,
            "COUNT",
            Math.max(SCAN_COUNT, query.limit)
        );
        const page = keys.slice(0, query.limit);

        // Type, expiry and size for the keys on this page, asked for in one
        // round trip rather than three per key.
        const pipeline = client.pipeline();
        for (const key of page) {
            pipeline.type(key);
            pipeline.pttl(key);
            pipeline.memory("USAGE", key);
        }
        const answers = (await pipeline.exec()) ?? [];

        const rows = page.map((key, index) => {
            const type = answers[index * 3]?.[1];
            const ttl = answers[index * 3 + 1]?.[1];
            const bytes = answers[index * 3 + 2]?.[1];
            return {
                key,
                type: typeof type === "string" ? type : "unknown",
                // -1 is "no expiry" and -2 is "gone since the scan"; neither is
                // a number of milliseconds and neither is drawn as one.
                ttl: typeof ttl === "number" && ttl >= 0 ? ttl : null,
                bytes: typeof bytes === "number" ? bytes : null
            } satisfies Record<string, unknown>;
        });

        return {
            columns: KEY_COLUMNS,
            rows,
            total: await client.dbsize(),
            // "0" means the scan came full circle: there is no next page.
            cursor: next === "0" ? null : next
        };
    }

    /**
     * What one key holds, in the shape its type has.
     *
     * Bounded on purpose: a list of a million entries is shown as its first two
     * hundred and said to be longer, because the alternative is a screen that
     * hangs and a server that spent a second building the reply.
     */
    async value(namespace: string | null, key: string): Promise<RedisValue> {
        const db = dbOf(namespace);
        const client = await this.open(db);
        const type = await client.type(key);
        const ttl = await client.pttl(key);
        const common = { key, type, ttl: ttl >= 0 ? ttl : null };

        switch (type) {
            case "string": {
                const value = await client.get(key);
                return { ...common, value, entries: null, truncated: false };
            }
            case "hash": {
                const hash = await client.hgetall(key);
                const entries = Object.entries(hash).slice(0, VALUE_ELEMENTS);
                return {
                    ...common,
                    value: null,
                    entries: entries.map(([field, value]) => ({ field, value })),
                    truncated: Object.keys(hash).length > entries.length
                };
            }
            case "list": {
                const list = await client.lrange(key, 0, VALUE_ELEMENTS - 1);
                const length = await client.llen(key);
                return {
                    ...common,
                    value: null,
                    entries: list.map((value, index) => ({ field: String(index), value })),
                    truncated: length > list.length
                };
            }
            case "set": {
                const [, members] = await client.sscan(key, "0", "COUNT", VALUE_ELEMENTS);
                const size = await client.scard(key);
                return {
                    ...common,
                    value: null,
                    entries: members.slice(0, VALUE_ELEMENTS).map((value) => ({ field: "", value })),
                    truncated: size > members.length
                };
            }
            case "zset": {
                const range = await client.zrange(key, 0, VALUE_ELEMENTS - 1, "WITHSCORES");
                const size = await client.zcard(key);
                const entries: RedisEntry[] = [];
                for (let index = 0; index < range.length; index += 2) {
                    entries.push({ field: range[index] ?? "", value: range[index + 1] ?? "" });
                }
                return { ...common, value: null, entries, truncated: size > entries.length };
            }
            case "none":
                throw new data.DataRequestError("That key is not there any more.");
            default: {
                // A module type (JSON, a stream, a bloom filter). There is no
                // general way to read one, so what is said is what it is.
                return { ...common, value: null, entries: null, truncated: false };
            }
        }
    }

    async run(command: string): Promise<data.QueryResult[]> {
        const results: data.QueryResult[] = [];
        for (const line of command.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
            if (this.address.readOnly && redisCommandWrites(line)) {
                throw new data.ReadOnlyError(`\`${line.split(/\s+/)[0]}\``);
            }
            const [name, ...args] = splitArgs(line);
            if (!name) continue;
            const client = await this.open(this.openedDb);
            const started = Date.now();
            const answer = await client.call(name, ...args);
            results.push({
                statement: line,
                columns: ["reply"],
                rows: flatten(answer).map((value) => [value]),
                affected: null,
                ms: Date.now() - started
            });
        }
        return results;
    }

    async close(): Promise<void> {
        const client = this.client;
        this.client = null;
        if (client) {
            try {
                client.disconnect();
            } catch {
                // Already gone. Nothing to do about it and nothing to say.
            }
        }
    }
}

/** One entry of a collection value: a hash field, a list index, a sorted-set
 *  score, or nothing at all for a set. */
export interface RedisEntry {
    readonly field: string;
    readonly value: string;
}

export interface RedisValue {
    readonly key: string;
    readonly type: string;
    /** Milliseconds left, or null when it does not expire. */
    readonly ttl: number | null;
    /** The whole value, for a string. */
    readonly value: string | null;
    /** The elements, for everything that has them. */
    readonly entries: readonly RedisEntry[] | null;
    /** Whether there is more of it than was read. */
    readonly truncated: boolean;
}

const KEY_COLUMNS: data.DataColumn[] = [
    { name: "key", type: "key", nullable: false, primaryKey: true },
    { name: "type", type: "type", nullable: false, primaryKey: false },
    { name: "ttl", type: "milliseconds", nullable: true, primaryKey: false },
    { name: "bytes", type: "bytes", nullable: true, primaryKey: false }
];

/** The database a namespace name stands for. Anything that is not a number is
 *  database zero, which is where a Redis with one database keeps everything. */
function dbOf(namespace: string | null): number {
    const db = Number(namespace);
    return Number.isInteger(db) && db >= 0 ? db : 0;
}

/** A command line split into arguments, with quoted runs kept whole - a value
 *  with a space in it is one argument, the way redis-cli reads it. */
function splitArgs(line: string): string[] {
    const args: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match: RegExpExecArray | null = pattern.exec(line);
    while (match) {
        args.push(match[1] ?? match[2] ?? match[3] ?? "");
        match = pattern.exec(line);
    }
    return args;
}

/** A reply flattened into lines a grid can print. Redis answers with strings,
 *  numbers, nulls and arrays of those, nested. */
function flatten(reply: unknown): unknown[] {
    if (reply === null || reply === undefined) return [null];
    if (Array.isArray(reply)) return reply.flatMap(flatten);
    if (Buffer.isBuffer(reply)) return [reply.toString("utf8")];
    if (typeof reply === "object") return [JSON.stringify(reply)];
    return [reply];
}
