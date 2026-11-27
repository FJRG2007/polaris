/**
 * Chat's live changes between dashboard processes, over Postgres LISTEN/NOTIFY.
 *
 * `live.ts` hands a change to the listeners of this process. A second replica
 * holds its own connections, so the change is also NOTIFYd on
 * `polaris_chat_live` and every other process delivers it to its own index.
 * Postgres is already between every writer of an install, so this needs nothing
 * set up - the same choice `lib/live/pg-listener.ts` made for the other live
 * screens (https://www.postgresql.org/docs/current/sql-notify.html).
 *
 * A change is ids, kinds and short names, never a message. Postgres refuses a
 * payload of 8000 bytes or more, so a change that does not fit one notice -
 * a long `audience`, a long draft - is cut into pieces sent in one statement,
 * which Postgres delivers together and in order, and joined again here.
 *
 * One process alone sends nothing: whether anybody else listens is read from
 * `pg_stat_activity` (`polaris-live` is the listener connection's application
 * name) at most every `PEERS_EVERY_MS`, and a process that starts listening
 * says so at once, so a single replica costs no query per message and a new
 * one is heard from its first second.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { randomUUID } from "node:crypto";
import { loadEnv } from "@polaris/config";
import * as live from "@/lib/live/pg-listener";
import { deliverChatChange, setChatRelay, type ChatChange } from "./live";

/** The NOTIFY channel chat changes travel on. */
export const CHAT_LIVE_CHANNEL = "polaris_chat_live";
/** Characters of a cut change per piece. JSON writes a character in at most six
 *  bytes, so a piece and its envelope stay under the payload limit. */
export const PIECE_CHARS = 1_000;
/** The most pieces one change is cut into. Past this it stays in this process:
 *  nothing a publisher sends comes near it, and a runaway one must not fill the
 *  notification queue every listener shares. */
export const MOST_PIECES = 64;
/** How long the answer to "is anybody else listening" is trusted. */
export const PEERS_EVERY_MS = 30_000;
/** Pieces of a change not completed in this long are forgotten. */
const PIECES_TTL_MS = 30_000;
/** Changes being joined at once, most. */
const MOST_JOINING = 256;
/** The listener connection's application name (`pg-listener.ts`). */
const LISTENER_APP = "polaris-live";

/** This process, so it skips its own notices. */
const NODE = randomUUID();

const changeSchema = z
    .object({
        kind: z.string().min(1).max(32),
        actorId: z.string().min(1).max(200),
        channelId: z.string().max(200).optional(),
        audience: z.array(z.string().max(200)).max(100_000).optional(),
        channels: z.array(z.string().max(200)).max(100_000).optional()
    })
    .passthrough();

const noticeSchema = z.union([
    z.object({ n: z.string().uuid(), hello: z.literal(true) }),
    z.object({ n: z.string().uuid(), c: changeSchema }),
    z.object({
        n: z.string().uuid(),
        id: z.string().uuid(),
        k: z.number().int().min(0).max(MOST_PIECES - 1),
        of: z.number().int().min(2).max(MOST_PIECES),
        p: z.string().max(PIECE_CHARS)
    })
]);

/** The notices a change travels as. Pure. Empty when it is too large to send. */
export function chatNotices(change: ChatChange, node: string = NODE, id: string = randomUUID()): string[] {
    const whole = JSON.stringify({ n: node, c: change });
    if (Buffer.byteLength(whole, "utf8") < live.NOTIFY_PAYLOAD_LIMIT) return [whole];
    const text = JSON.stringify(change);
    const of = Math.ceil(text.length / PIECE_CHARS);
    if (of > MOST_PIECES) return [];
    const pieces: string[] = [];
    for (let k = 0; k < of; k += 1) {
        pieces.push(JSON.stringify({ n: node, id, k, of, p: text.slice(k * PIECE_CHARS, (k + 1) * PIECE_CHARS) }));
    }
    return pieces;
}

/** Joins the pieces of a change cut by `chatNotices`, and delivers what
 *  another process sent. One per process; a test makes its own. */
export class ChatNoticeReader {
    private readonly joining = new Map<string, { parts: string[]; got: number; at: number }>();

    constructor(
        private readonly deliver: (change: ChatChange) => void,
        private readonly onHello: () => void = () => undefined,
        private readonly node: string = NODE,
        private readonly now: () => number = Date.now
    ) {}

    read(payload: string): void {
        let raw: unknown;
        try {
            raw = JSON.parse(payload);
        } catch {
            return;
        }
        const notice = noticeSchema.safeParse(raw);
        if (!notice.success || notice.data.n === this.node) return;
        const data = notice.data;
        // Anybody speaking at all is somebody else listening.
        this.onHello();
        if ("hello" in data) return;
        if ("c" in data) {
            this.deliver(data.c as unknown as ChatChange);
            return;
        }
        this.forgetStale();
        const key = `${data.n}:${data.id}`;
        let held = this.joining.get(key);
        if (!held) {
            if (this.joining.size >= MOST_JOINING) this.joining.delete(this.joining.keys().next().value!);
            held = { parts: new Array<string>(data.of).fill(""), got: 0, at: this.now() };
            this.joining.set(key, held);
        }
        if (held.parts.length !== data.of || held.parts[data.k]) return;
        held.parts[data.k] = data.p;
        held.got += 1;
        if (held.got < data.of) return;
        this.joining.delete(key);
        let joined: unknown;
        try {
            joined = JSON.parse(held.parts.join(""));
        } catch {
            return;
        }
        const change = changeSchema.safeParse(joined);
        if (change.success) this.deliver(change.data as unknown as ChatChange);
    }

    /** How many changes are part way joined. For tests. */
    get pending(): number {
        return this.joining.size;
    }

    private forgetStale(): void {
        const cutoff = this.now() - PIECES_TTL_MS;
        for (const [key, held] of this.joining) if (held.at < cutoff) this.joining.delete(key);
    }
}

/** What sending needs, so a test can stand in for the database. */
export interface ChatSender {
    /** NOTIFY every payload, in one statement. */
    notify(payloads: readonly string[]): Promise<unknown>;
    /** How many processes hold a listener connection to this database. */
    listeners(): Promise<number>;
    /** Whether this process's own listener connection is among them. */
    selfListening(): boolean;
}

/**
 * Sends this process's changes to the others, when there are others.
 * In order: a change is chained behind the one before it, so two changes of one
 * conversation are never seen the wrong way round by another replica.
 */
export class ChatRelay {
    private sending: Promise<unknown> = Promise.resolve();
    /** Sent to until counted otherwise: a notice nobody hears costs one
     *  statement, a replica missing a message costs its readers that message. */
    private peers = true;
    private checkedAt = Number.NEGATIVE_INFINITY;
    private checking = false;
    private warned = false;

    constructor(
        private readonly sender: ChatSender,
        private readonly now: () => number = Date.now,
        private readonly node: string = NODE
    ) {}

    /** Somebody else spoke on the channel: there is a peer, now. */
    heard(): void {
        this.peers = true;
        this.checkedAt = this.now();
    }

    send(change: ChatChange): void {
        this.recheck();
        if (!this.peers) return;
        const payloads = chatNotices(change, this.node);
        if (payloads.length === 0) {
            console.error(`[chat-live] a ${change.kind} change was too large for the other replicas`);
            return;
        }
        this.chain(payloads);
    }

    /** Tell the others this process listens now, whatever they last counted. */
    hello(): void {
        this.chain([JSON.stringify({ n: this.node, hello: true })]);
    }

    /** Count the others now rather than at the first change. */
    prime(): void {
        this.recheck();
    }

    /** Whether a change would be sent right now. For tests. */
    get sendsToPeers(): boolean {
        return this.peers;
    }

    private chain(payloads: readonly string[]): void {
        this.sending = this.sending
            .then(() => this.sender.notify(payloads))
            .catch((caught: unknown) => {
                if (this.warned) return;
                this.warned = true;
                console.error("[chat-live] changes reach this replica only:", caught);
            });
    }

    private recheck(): void {
        if (this.checking || this.now() - this.checkedAt < PEERS_EVERY_MS) return;
        this.checking = true;
        void this.sender
            .listeners()
            .then((count) => {
                this.peers = count - (this.sender.selfListening() ? 1 : 0) > 0;
            })
            .catch(() => {
                // Unknown is sent to: a notice nobody hears costs one statement,
                // a replica that hears nothing costs its readers their chat.
                this.peers = true;
            })
            .finally(() => {
                this.checking = false;
                this.checkedAt = this.now();
            });
    }
}

const postgresSender: ChatSender = {
    notify: (payloads) =>
        prisma.$executeRaw`SELECT pg_notify(${CHAT_LIVE_CHANNEL}, p) FROM unnest(${[...payloads]}::text[]) AS p`,
    listeners: async () => {
        const rows = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE application_name = ${LISTENER_APP} AND datname = current_database()`;
        return rows[0]?.n ?? 0;
    },
    selfListening: () => live.pgListener().connected
};

/** Held on globalThis: a dev server re-evaluating this module must not start a
 *  second relay. */
const STARTED = Symbol.for("polaris.chat.live.transport");

/**
 * Join the other processes. Called by every stream before it subscribes; the
 * first call in a process does the work. On SQLite there is nobody else and
 * nothing is started: one process, delivering as it always did.
 */
export function joinChatReplicas(): void {
    const holder = globalThis as { [STARTED]?: true };
    if (holder[STARTED]) return;
    holder[STARTED] = true;
    const env = loadEnv();
    if (env.POLARIS_DB_PROVIDER !== "postgresql" || !env.POLARIS_DATABASE_URL) return;
    const relay = new ChatRelay(postgresSender);
    const reader = new ChatNoticeReader(deliverChatChange, () => relay.heard());
    try {
        live.pgListener().listen(CHAT_LIVE_CHANNEL, {
            onNotice: (payload) => reader.read(payload),
            // (Re)connected: whatever the others last counted, this one listens.
            onResync: () => relay.hello()
        });
    } catch (caught) {
        console.error("[chat-live] changes from other replicas are off:", caught);
        return;
    }
    relay.prime();
    setChatRelay((change) => relay.send(change));
}
