/**
 * What a runner reports that another node may be the one showing: a chat
 * turn's events and a session's setup progress.
 *
 * A runner's socket reaches one node; the chat request or the session screen
 * waiting on it is often on another. The node that holds the socket publishes
 * a notice on `polaris_runner_live` through the process's one listener
 * connection (`lib/live/pg-listener`), the same bus `computer-commands.ts`
 * uses, and every node hands it to its own store. A notice too large for one
 * NOTIFY is cut into pieces that the receiver puts back together; pieces from
 * one sender arrive in the order they were sent.
 *
 * Built from injected parts so the fan-out is asserted against a fake bus.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { randomUUID } from "node:crypto";
import * as live from "@/lib/live/pg-listener";
import { relayNode } from "@/lib/computers/computer-commands";

export const RUNNER_LIVE_CHANNEL = "polaris_runner_live";

/** Room left in a NOTIFY payload for the piece's envelope. */
const PIECE_LIMIT = live.NOTIFY_PAYLOAD_LIMIT - 400;
/** A notice whose pieces stop arriving is dropped after this. */
const ASSEMBLY_TTL_MS = 60_000;
/** Most notices put back together at once. */
const ASSEMBLY_MAX = 200;
/** Most pieces one notice may be cut into: a chat event is at most ~260 KB. */
const PIECES_MOST = 64;

const progressSchema = z.object({
    tool: z.string().min(1).max(40),
    step: z.enum(core.TOOLCHAIN_STEPS),
    received: z.number().int().min(0).optional(),
    total: z.number().int().min(0).optional(),
    code: z.enum(core.TOOLCHAIN_FAILURES).optional()
});

export const liveNoticeSchema = z.discriminatedUnion("k", [
    z.object({
        k: z.literal("chat"),
        runnerId: z.string().uuid(),
        frame: z.object({ turnId: z.string().min(1).max(200), seq: z.number().int().min(0), event: core.runnerChatEventSchema })
    }),
    z.object({ k: z.literal("progress"), sessionId: z.string().uuid(), progress: progressSchema })
]);
export type LiveNotice = z.infer<typeof liveNoticeSchema>;

const pieceSchema = z.object({
    /** The node that published it, so a node skips its own. */
    n: z.string().min(1).max(255),
    /** The notice this piece belongs to. */
    i: z.string().uuid(),
    p: z.number().int().min(0),
    of: z.number().int().min(1).max(PIECES_MOST),
    d: z.string()
});

export interface BusDeps {
    readonly node: () => string;
    readonly notify: (payload: string) => Promise<void>;
    readonly receive: (notice: LiveNotice) => void;
    readonly now?: () => number;
}

/** Cut a serialised notice into payloads of at most `limit` characters of data. Pure. */
export function cutNotice(node: string, id: string, json: string, limit = PIECE_LIMIT): string[] {
    const count = Math.max(1, Math.ceil(json.length / limit));
    return Array.from({ length: count }, (_, p) => JSON.stringify({ n: node, i: id, p, of: count, d: json.slice(p * limit, (p + 1) * limit) }));
}

export function createRunnerBus(deps: BusDeps) {
    const now = deps.now ?? Date.now;
    const assembling = new Map<string, { pieces: string[]; got: number; at: number }>();

    async function publish(notice: LiveNotice): Promise<void> {
        const json = JSON.stringify(notice);
        const payloads = cutNotice(deps.node(), randomUUID(), json);
        if (payloads.length > PIECES_MOST) return;
        for (const payload of payloads) await deps.notify(payload);
    }

    function accept(payload: string): void {
        let raw: unknown;
        try {
            raw = JSON.parse(payload);
        } catch {
            return;
        }
        const piece = pieceSchema.safeParse(raw);
        if (!piece.success || piece.data.n === deps.node()) return;
        const { i, p, of, d } = piece.data;
        if (p >= of) return;
        const at = now();
        for (const [id, entry] of assembling) if (at - entry.at > ASSEMBLY_TTL_MS) assembling.delete(id);
        let entry = assembling.get(i);
        if (!entry) {
            if (assembling.size >= ASSEMBLY_MAX) assembling.delete(assembling.keys().next().value!);
            entry = { pieces: new Array<string>(of), got: 0, at };
            assembling.set(i, entry);
        }
        if (entry.pieces.length !== of || entry.pieces[p] !== undefined) return;
        entry.pieces[p] = d;
        entry.got += 1;
        if (entry.got < of) return;
        assembling.delete(i);
        let json: unknown;
        try {
            json = JSON.parse(entry.pieces.join(""));
        } catch {
            return;
        }
        const notice = liveNoticeSchema.safeParse(json);
        if (notice.success) deps.receive(notice.data);
    }

    return { publish, accept };
}

type Receiver = (notice: LiveNotice) => void;
const receivers: Receiver[] = [];

const bus = createRunnerBus({
    node: relayNode,
    notify: async (payload) => {
        await prisma.$executeRaw`SELECT pg_notify(${RUNNER_LIVE_CHANNEL}, ${payload})`;
    },
    receive: (notice) => {
        for (const receiver of receivers) receiver(notice);
    }
});

let listening = false;

/** Take other nodes' notices from now on, handing each to `receiver`. The
 *  first call starts listening; later ones only add their receiver. */
export function onRunnerLive(receiver: Receiver): void {
    if (!receivers.includes(receiver)) receivers.push(receiver);
    if (listening) return;
    listening = true;
    try {
        live.pgListener().listen(RUNNER_LIVE_CHANNEL, { onNotice: bus.accept });
    } catch (caught) {
        console.error("[runner] live notices from other nodes are off:", caught);
    }
}

/** Tell the other nodes. A failure is logged and never thrown at the runner. */
export function publishRunnerLive(notice: LiveNotice): Promise<void> {
    return bus.publish(notice).catch((caught: unknown) => {
        console.error("[runner] live notice not published:", caught);
    });
}
