/**
 * Postgres LISTEN for the whole process, on one connection.
 *
 * An in-process emitter only reaches pages served by the process that made the
 * change. With a second dashboard replica - or a write made by a sweep in
 * another container - the rest of the screens heard nothing until their slow
 * poll came round. Postgres already sits between every writer, so its
 * LISTEN/NOTIFY carries the "something changed" between them instead of a new
 * broker to keep running.
 *
 * One dedicated connection per process, never one per open page: every channel
 * is LISTENed on it, and a notice is handed to the subscribers in memory. It is
 * outside Prisma's pool (a pooled connection is handed to other queries between
 * uses, and LISTEN belongs to the session), so the process holds its fifteen
 * pooled connections plus this one.
 *
 * Notices carry ids and kinds only. A subscriber reads the rows itself, through
 * the same checks its first read used, so a notice can never become being shown
 * something. Anything over Postgres' payload limit, or not text at all, is
 * dropped here rather than parsed.
 *
 * A dropped connection is retried with capped, jittered backoff. When it comes
 * back, every subscriber is told how far back to look - the database's own time
 * when the old connection was last known alive, minus a margin - so a change
 * made while nobody was listening is read rather than lost.
 */

import { readFileSync } from "node:fs";
import { loadEnv } from "@polaris/config";
import { Client, type ClientConfig } from "pg";

/** Postgres refuses a NOTIFY payload of 8000 bytes or more (default build). */
export const NOTIFY_PAYLOAD_LIMIT = 8000;

/** How often the connection proves it is still alive. A half-open TCP
 *  connection never errors on its own, it just stops delivering. */
const HEARTBEAT_MS = 30_000;
/** A query on this connection that takes longer than this means it is gone. */
const QUERY_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/**
 * How much earlier than "last known alive" a catch-up reads from. Covers a
 * notice still in flight when the connection died, and a row whose `createdAt`
 * (the transaction's start) is a little older than its commit.
 */
export const RESYNC_MARGIN_MS = 10_000;

/** A channel name is put into `LISTEN` as an identifier, which cannot be a
 *  parameter, so only plain lowercase names are accepted. */
const CHANNEL_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** What a channel's subscriber is told. */
export interface ChannelHandlers {
    /** A notice arrived. The payload is raw text under the size limit. */
    readonly onNotice: (payload: string) => void;
    /**
     * The connection was (re)established after a gap. Read whatever changed
     * since `since`, in the database's clock.
     */
    readonly onResync?: (since: Date) => void | Promise<void>;
}

/** The part of `pg.Client` the listener uses, so a test can stand in for it. */
export interface ListenerClient {
    connect(): Promise<unknown>;
    query(text: string): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
    on(event: "notification", listener: (message: { channel: string; payload?: string }) => void): unknown;
    on(event: "error" | "end", listener: (...args: unknown[]) => void): unknown;
    end(): Promise<unknown>;
}

interface ListenerOptions {
    /** A fresh, unconnected client, or null when there is nothing to listen
     *  to (an instance on SQLite). */
    readonly open: () => ListenerClient | null;
    /** 0..1, for the jitter. */
    readonly random?: () => number;
    readonly now?: () => number;
}

type State = "idle" | "connecting" | "up" | "waiting" | "off";

export class PgListener {
    private readonly channels = new Map<string, Set<ChannelHandlers>>();
    private readonly open: () => ListenerClient | null;
    private readonly random: () => number;
    private readonly now: () => number;
    private client: ListenerClient | null = null;
    private state: State = "idle";
    private attempt = 0;
    /** Database time of the last proof the connection was alive. */
    private healthyAt: Date | null = null;
    /** Local time the first subscriber asked, for the first catch-up. */
    private requestedAt: number | null = null;
    private retry: ReturnType<typeof setTimeout> | null = null;
    private heartbeat: ReturnType<typeof setInterval> | null = null;

    constructor(options: ListenerOptions) {
        this.open = options.open;
        this.random = options.random ?? Math.random;
        this.now = options.now ?? Date.now;
    }

    /** Whether the connection is up right now. */
    get connected(): boolean {
        return this.state === "up";
    }

    /** Subscribe to a channel. Returns the unsubscribe. The channel stays
     *  LISTENed for the life of the process: there are a handful of them. */
    listen(channel: string, handlers: ChannelHandlers): () => void {
        if (!CHANNEL_NAME.test(channel)) throw new Error(`Invalid channel name: ${channel}`);
        let set = this.channels.get(channel);
        const fresh = !set;
        if (!set) {
            set = new Set();
            this.channels.set(channel, set);
        }
        set.add(handlers);
        if (this.state === "idle") {
            this.requestedAt = this.now();
            void this.connect();
        } else if (fresh && this.state === "up" && this.client) {
            const client = this.client;
            client.query(`LISTEN "${channel}"`).catch(() => this.drop(client));
        }
        const held = set;
        return () => {
            held.delete(handlers);
        };
    }

    /** Close the connection and stop retrying (tests and shutdown). */
    async close(): Promise<void> {
        this.state = "off";
        this.stopTimers();
        const client = this.client;
        this.client = null;
        await client?.end().catch(() => undefined);
    }

    private async connect(): Promise<void> {
        this.retry = null;
        let client: ListenerClient | null;
        try {
            client = this.open();
        } catch (caught) {
            console.error("[live] could not configure the listener connection:", caught);
            client = null;
        }
        if (!client) {
            this.state = "off";
            return;
        }
        this.state = "connecting";
        this.client = client;
        client.on("notification", (message) => {
            if (this.client === client) this.deliver(message.channel, message.payload);
        });
        client.on("error", () => this.drop(client));
        client.on("end", () => this.drop(client));
        try {
            await client.connect();
            for (const channel of this.channels.keys()) await client.query(`LISTEN "${channel}"`);
            // LISTEN is active before the catch-up reads, so nothing falls
            // between the two.
            const previous = this.healthyAt;
            const dbNow = await this.beat(client);
            if (this.client !== client) return;
            this.state = "up";
            this.attempt = 0;
            this.heartbeat = setInterval(() => {
                this.beat(client).catch(() => this.drop(client));
            }, HEARTBEAT_MS);
            this.heartbeat.unref?.();
            const gapStart = previous
                ? previous.getTime()
                : dbNow.getTime() - (this.now() - (this.requestedAt ?? this.now()));
            this.resync(new Date(gapStart - RESYNC_MARGIN_MS));
        } catch (caught) {
            console.error("[live] listener connection failed:", (caught as Error)?.message ?? caught);
            this.drop(client);
        }
    }

    /** Prove the connection is alive and remember when, in the database's clock. */
    private async beat(client: ListenerClient): Promise<Date> {
        const result = await client.query("SELECT now() AS now");
        const raw = result.rows[0]?.now;
        const at = raw instanceof Date ? raw : new Date(String(raw));
        if (Number.isNaN(at.getTime())) throw new Error("heartbeat returned no time");
        if (this.client === client) this.healthyAt = at;
        return at;
    }

    private deliver(channel: string, payload: string | undefined): void {
        if (typeof payload !== "string") return;
        if (Buffer.byteLength(payload, "utf8") >= NOTIFY_PAYLOAD_LIMIT) return;
        for (const handlers of this.channels.get(channel) ?? []) {
            try {
                handlers.onNotice(payload);
            } catch (caught) {
                console.error(`[live] a ${channel} subscriber failed:`, caught);
            }
        }
    }

    private resync(since: Date): void {
        for (const set of this.channels.values()) {
            for (const handlers of set) {
                if (!handlers.onResync) continue;
                Promise.resolve()
                    .then(() => handlers.onResync?.(since))
                    .catch((caught) => console.error("[live] catch-up failed:", caught));
            }
        }
    }

    private drop(client: ListenerClient): void {
        if (this.client !== client) return;
        this.client = null;
        this.stopTimers();
        // A late error from the dead client must not become an unhandled one.
        client.on("error", () => undefined);
        client.end().catch(() => undefined);
        if (this.state === "off") return;
        this.state = "waiting";
        const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
        this.attempt += 1;
        const delay = Math.round(ceiling * (0.5 + this.random() * 0.5));
        this.retry = setTimeout(() => void this.connect(), delay);
        this.retry.unref?.();
    }

    private stopTimers(): void {
        if (this.heartbeat) clearInterval(this.heartbeat);
        if (this.retry) clearTimeout(this.retry);
        this.heartbeat = null;
        this.retry = null;
    }
}

/**
 * The listener connection's settings, from the same URL Prisma connects with.
 *
 * Prisma's own query parameters (`schema`, `connection_limit`, ...) are not
 * libpq's, so the URL is taken apart rather than handed to `pg` whole. TLS
 * follows `sslmode` the way Prisma reads the same URL: `require` encrypts
 * without checking the certificate, `verify-*` checks it against
 * `sslrootcert` when one is named.
 */
export function listenerConfig(raw: string): ClientConfig {
    const url = new URL(raw);
    const sslmode = url.searchParams.get("sslmode") ?? "";
    let ssl: ClientConfig["ssl"] = false;
    if (sslmode === "verify-ca" || sslmode === "verify-full") {
        const file = url.searchParams.get("sslrootcert") || url.searchParams.get("sslcert");
        ssl = file ? { ca: readFileSync(file, "utf8") } : true;
    } else if (sslmode && sslmode !== "disable") {
        ssl = { rejectUnauthorized: false };
    }
    return {
        host: url.searchParams.get("host") || url.hostname || undefined,
        port: url.port ? Number(url.port) : 5432,
        database: decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined,
        user: decodeURIComponent(url.username) || undefined,
        password: decodeURIComponent(url.password) || undefined,
        ssl,
        application_name: "polaris-live",
        keepAlive: true,
        connectionTimeoutMillis: QUERY_TIMEOUT_MS,
        query_timeout: QUERY_TIMEOUT_MS
    };
}

/** A client for this instance's own database, or null on SQLite. */
function openOwnDatabase(): ListenerClient | null {
    const env = loadEnv();
    if (env.POLARIS_DB_PROVIDER !== "postgresql" || !env.POLARIS_DATABASE_URL) return null;
    return new Client(listenerConfig(env.POLARIS_DATABASE_URL)) as unknown as ListenerClient;
}

/**
 * Held on globalThis: a dev server re-evaluates modules on edit, and a second
 * module copy must not open a second connection.
 */
const REGISTRY = Symbol.for("polaris.live.pg-listener");

/** The process's listener on its own database. */
export function pgListener(): PgListener {
    const holder = globalThis as { [REGISTRY]?: PgListener };
    holder[REGISTRY] ??= new PgListener({ open: openOwnDatabase });
    return holder[REGISTRY];
}
