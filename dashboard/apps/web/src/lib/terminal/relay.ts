/**
 * The dashboard's half of the Polaris Terminal remote-control relay. The
 * sidecar (`terminal-relay.mjs`) holds the sockets; this decides who they
 * belong to, records where each terminal is connected, says whether a caller
 * may reach a terminal, and carries a request to the node holding it when that
 * is another one.
 *
 * Cross-node traffic is a frame serialized to base64 and sent as ordered
 * NOTIFY pieces on `TERMINAL_CHANNEL`; the node it names reassembles them and
 * hands the frame to its own sidecar. Bounded: a frame larger than the sidecar
 * accepts is refused before it is split, and a frame whose pieces stop arriving
 * is forgotten.
 */

import { z } from "zod";
import os from "node:os";
import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { grantedCapability, linkGrantStands } from "@/lib/access/grants";
import * as live from "@/lib/live/pg-listener";
import { authenticateKeyToken } from "@/lib/api-key-auth";
import { splitBase64 } from "@/lib/computers/computer-commands";

export const TERMINAL_CHANNEL = "polaris_terminal";

/** The scope a key needs to hold a relay socket, as either side. */
export const TERMINAL_CONTROL_SCOPE = "terminal.control";

/** What a share of one terminal is filed under. */
export const TERMINAL_GRANT = "terminal.instance" satisfies core.GrantSubject;

/** A web viewer's ticket: a `DeployTicket` row of this mode, one terminal, once. */
export const VIEWER_TICKET_MODE = "relay";
const VIEWER_TICKET_MS = 60_000;

/** The largest frame carried between nodes, matching the sidecar's own cap. */
export const TERMINAL_FRAME_BYTES = 256 * 1024;

/** A frame whose pieces stop arriving is dropped after this. */
const ASSEMBLY_TTL_MS = 30_000;

/** Room in one NOTIFY for a piece, after its envelope. */
const PIECE_CHARS = live.NOTIFY_PAYLOAD_LIMIT - 512;

/** This node's name, as the sidecar beside it reports terminals under. */
export function terminalNode(): string {
    return os.hostname();
}

export interface TerminalIdentity {
    readonly userId: string;
    /** The key a terminal or controller presented; null for a web viewer. */
    readonly keyId: string | null;
    /** Set for a terminal's own socket, absent for a controller. */
    readonly instanceId?: string;
    /** The one terminal a web viewer's ticket names. */
    readonly bound?: string;
    /** The link grant a viewer came through, for somebody with no account:
     *  `userId` is then the terminal's owner and gives nothing by itself. */
    readonly linkId?: string;
}

/** A viewer ticket's `containerRef` when it was minted for a link. */
const LINK_REF = "link:";

/** A one-shot ticket for the web screen to reach one terminal through the relay. */
export async function mintViewerTicket(userId: string, instanceId: string, linkId?: string): Promise<string> {
    const token = generateToken();
    await prisma.deployTicket.create({
        data: {
            tokenHash: hashToken(token),
            userId,
            targetId: instanceId,
            containerRef: linkId ? `${LINK_REF}${linkId}` : "terminal",
            mode: VIEWER_TICKET_MODE,
            expiresAt: new Date(Date.now() + VIEWER_TICKET_MS)
        }
    });
    return token;
}

/** Spend a viewer ticket: who it was minted for and which terminal, once. */
async function redeemViewerTicket(token: string): Promise<TerminalIdentity | null> {
    const ticket = await prisma.deployTicket.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!ticket || ticket.mode !== VIEWER_TICKET_MODE || ticket.usedAt || ticket.expiresAt < new Date()) return null;
    const spent = await prisma.deployTicket.updateMany({
        where: { id: ticket.id, usedAt: null },
        data: { usedAt: new Date() }
    });
    if (spent.count !== 1) return null;
    const linkId = ticket.containerRef.startsWith(LINK_REF) ? ticket.containerRef.slice(LINK_REF.length) : undefined;
    return { userId: ticket.userId, keyId: null, bound: ticket.targetId, ...(linkId ? { linkId } : {}) };
}

/**
 * Check what a socket presented. A terminal must present its own `terminal`
 * key; a controller any key that holds `terminal.control`. Both answer to the
 * same network, client and device rules as any other use of the key.
 */
export async function authenticateRelaySocket(input: {
    token: string;
    role: "instance" | "controller" | "viewer";
    ip?: string;
    userAgent?: string;
}): Promise<TerminalIdentity | null> {
    if (input.role === "viewer") return redeemViewerTicket(input.token);
    const principal = await authenticateKeyToken(input.token, input.ip, input.userAgent);
    if (!principal || !principal.scopes.includes(TERMINAL_CONTROL_SCOPE)) return null;
    if (input.role === "controller") return { userId: principal.userId, keyId: principal.keyId };
    if (principal.kind !== "terminal") return null;
    const row = await prisma.terminalInstance.upsert({
        where: { apiKeyId: principal.keyId },
        update: {},
        create: { userId: principal.userId, apiKeyId: principal.keyId },
        select: { id: true }
    });
    return { userId: principal.userId, keyId: principal.keyId, instanceId: row.id };
}

/** A terminal came online on `node`, or left it. Leaving only clears the node
 *  that still names this one, so a reconnect elsewhere is not undone. */
export async function recordTerminalPresence(input: {
    instanceId: string;
    node: string;
    online: boolean;
    name?: string | null;
    os?: string | null;
    version?: string | null;
}): Promise<void> {
    const now = new Date();
    if (input.online) {
        await prisma.terminalInstance.updateMany({
            where: { id: input.instanceId },
            data: {
                relayNode: input.node,
                lastSeenAt: now,
                ...(input.name ? { name: input.name } : {}),
                ...(input.os ? { os: input.os } : {}),
                ...(input.version ? { version: input.version } : {})
            }
        });
        return;
    }
    await prisma.terminalInstance.updateMany({
        where: { id: input.instanceId, relayNode: input.node },
        data: { relayNode: null, lastSeenAt: now }
    });
}

/** Whether a key still stands: not revoked, switched off or expired, and its
 *  owner not banned. Asked on every request so revoking one stops it at once. */
async function keyStands(keyId: string, now = new Date()): Promise<boolean> {
    const row = await prisma.apiKey.findUnique({
        where: { id: keyId },
        select: { revokedAt: true, enabled: true, expiresAt: true, user: { select: { bannedAt: true } } }
    });
    return Boolean(
        row &&
            !row.revokedAt &&
            row.enabled !== false &&
            !row.user.bannedAt &&
            (!row.expiresAt || row.expiresAt.getTime() > now.getTime())
    );
}

/** Whether somebody who is not banned holds an account. */
async function userStands(userId: string): Promise<boolean> {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { bannedAt: true } });
    return Boolean(row && !row.bannedAt);
}

/**
 * Where a controller's or viewer's frame for `instanceId` goes. `need` is
 * `view` for watching a pane and `control` for a request; the owner has both,
 * anybody else what a share of it gives them, and a link only ever watching.
 * Not allowed reads the same for an instance that does not exist and one the
 * caller may not reach.
 */
export async function routeTerminalRequest(input: {
    userId: string;
    keyId: string | null;
    linkId?: string | null;
    instanceId: string;
    need?: "view" | "control";
}): Promise<{ allowed: boolean; node: string | null }> {
    const row = await prisma.terminalInstance.findUnique({
        where: { id: input.instanceId },
        select: { userId: true, apiKeyId: true, relayNode: true }
    });
    if (!row) return { allowed: false, node: null };
    if (input.linkId) {
        // Checked before the owner shortcut: a link's ticket carries the
        // owner's id, and must never be read as the owner.
        if ((input.need ?? "control") !== "view" || input.keyId) return { allowed: false, node: null };
        if (!(await linkGrantStands(input.linkId, TERMINAL_GRANT, input.instanceId))) return { allowed: false, node: null };
    } else if (row.userId !== input.userId) {
        const held = await grantedCapability(input.userId, TERMINAL_GRANT, input.instanceId);
        if (!held || !core.atLeast(TERMINAL_GRANT, held, input.need ?? "control")) return { allowed: false, node: null };
    }
    const callerStands = input.keyId ? await keyStands(input.keyId) : await userStands(input.userId);
    if (!callerStands) return { allowed: false, node: null };
    if (!(await keyStands(row.apiKeyId))) return { allowed: true, node: null };
    return { allowed: true, node: row.relayNode };
}

/** Of the instances a sidecar holds, the ones whose key no longer stands. */
export async function endedTerminals(instanceIds: readonly string[]): Promise<string[]> {
    if (instanceIds.length === 0) return [];
    const now = new Date();
    const rows = await prisma.terminalInstance.findMany({
        where: { id: { in: [...instanceIds] } },
        select: { id: true, apiKey: { select: { revokedAt: true, enabled: true, expiresAt: true, user: { select: { bannedAt: true } } } } }
    });
    const standing = new Set(
        rows
            .filter(
                ({ apiKey }) =>
                    !apiKey.revokedAt &&
                    apiKey.enabled !== false &&
                    !apiKey.user.bannedAt &&
                    (!apiKey.expiresAt || apiKey.expiresAt.getTime() > now.getTime())
            )
            .map((row) => row.id)
    );
    return instanceIds.filter((id) => !standing.has(id));
}

/** Of the watches a sidecar holds, the positions of those no longer allowed. */
export async function withdrawnWatches(
    watches: readonly { userId: string; keyId: string | null; linkId?: string | null; instanceId: string }[]
): Promise<number[]> {
    const answers = new Map<string, Promise<boolean>>();
    const out: number[] = [];
    for (const [index, watch] of watches.entries()) {
        const key = `${watch.userId}|${watch.keyId ?? ""}|${watch.linkId ?? ""}|${watch.instanceId}`;
        let answer = answers.get(key);
        if (!answer) {
            answer = routeTerminalRequest({ ...watch, need: "view" }).then((route) => route.allowed);
            answers.set(key, answer);
        }
        if (!(await answer)) out.push(index);
    }
    return out;
}

/* ---------------------------------------------------------------- cross-node */

/** What one node asks of another's sidecar. */
export type RemoteTerminalCall =
    | { readonly path: "/terminal/deliver"; readonly body: { instanceId: string; id: string; origin: string; envelope: unknown } }
    | { readonly path: "/terminal/reply"; readonly body: { id: string; frame: unknown } }
    | {
          readonly path: "/terminal/watch";
          readonly body: { instanceId: string; pane: string; origin: string; on: boolean };
      }
    | { readonly path: "/terminal/stream"; readonly body: { instanceId: string; pane: string; frame: unknown } };

/** A pane id as the sidecar accepts it. */
export const paneSchema = z.string().regex(/^[\x21-\x7e]{1,200}$/);

const pieceSchema = z.object({
    n: z.string().min(1).max(255),
    k: z.string().uuid(),
    i: z.number().int().min(0),
    of: z.number().int().min(1).max(Math.ceil((TERMINAL_FRAME_BYTES * 4) / 3 / 4) + 1),
    d: z.string().max(live.NOTIFY_PAYLOAD_LIMIT).regex(/^[A-Za-z0-9+/]*={0,2}$/)
});

const callSchema = z.discriminatedUnion("path", [
    z.object({
        path: z.literal("/terminal/deliver"),
        body: z.object({
            instanceId: z.string().uuid(),
            id: z.string().uuid(),
            origin: z.string().min(1).max(255),
            envelope: z.unknown()
        })
    }),
    z.object({
        path: z.literal("/terminal/reply"),
        body: z.object({ id: z.string().uuid(), frame: z.unknown() })
    }),
    z.object({
        path: z.literal("/terminal/watch"),
        body: z.object({
            instanceId: z.string().uuid(),
            pane: paneSchema,
            origin: z.string().min(1).max(255),
            on: z.boolean()
        })
    }),
    z.object({
        path: z.literal("/terminal/stream"),
        body: z.object({ instanceId: z.string().uuid(), pane: paneSchema, frame: z.unknown() })
    })
]);

/** Split a call into the NOTIFY payloads that carry it to `node`. Pure. */
export function encodeRemoteCall(node: string, key: string, call: RemoteTerminalCall): string[] | null {
    const json = JSON.stringify(call);
    if (Buffer.byteLength(json) > TERMINAL_FRAME_BYTES + 4096) return null;
    const pieces = splitBase64(Buffer.from(json).toString("base64"), PIECE_CHARS);
    return pieces.map((d, i) => JSON.stringify({ n: node, k: key, i, of: pieces.length, d }));
}

/**
 * Reassembles calls from NOTIFY pieces addressed to `node`. Pieces of one call
 * arrive in order on one connection; a gap or a stall drops the call.
 */
export function createCallAssembler(node: () => string, now: () => number = Date.now) {
    const partial = new Map<string, { parts: string[]; of: number; at: number }>();
    return (payload: string): RemoteTerminalCall | null => {
        const at = now();
        for (const [key, entry] of partial) if (at - entry.at > ASSEMBLY_TTL_MS) partial.delete(key);
        let json: unknown;
        try {
            json = JSON.parse(payload);
        } catch {
            return null;
        }
        const piece = pieceSchema.safeParse(json);
        if (!piece.success || piece.data.n !== node()) return null;
        const { k, i, of, d } = piece.data;
        const entry = partial.get(k) ?? { parts: [], of, at };
        if (entry.of !== of || entry.parts.length !== i) {
            partial.delete(k);
            return null;
        }
        entry.parts.push(d);
        entry.at = at;
        if (entry.parts.length < of) {
            partial.set(k, entry);
            return null;
        }
        partial.delete(k);
        try {
            const call = callSchema.safeParse(JSON.parse(Buffer.from(entry.parts.join(""), "base64").toString("utf8")));
            return call.success ? (call.data as RemoteTerminalCall) : null;
        } catch {
            return null;
        }
    };
}

function sidecarUrl(path: string): string {
    return `http://127.0.0.1:${Number(process.env.POLARIS_WS_PORT || 3001)}${path}`;
}

/** Hand a call to the sidecar beside this web app. */
export async function callLocalSidecar(call: RemoteTerminalCall): Promise<boolean> {
    const response = await fetch(sidecarUrl(call.path), {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-key": process.env.POLARIS_AUTH_SECRET ?? "" },
        body: JSON.stringify(call.body),
        signal: AbortSignal.timeout(10_000)
    }).catch(() => null);
    return Boolean(response?.ok);
}

/** Send a call to the sidecar on `node`: straight to the one here, otherwise
 *  over NOTIFY. False when it is too large to carry. */
export async function sendRemoteCall(node: string, call: RemoteTerminalCall): Promise<boolean> {
    if (node === terminalNode()) return callLocalSidecar(call);
    const payloads = encodeRemoteCall(node, crypto.randomUUID(), call);
    if (!payloads) return false;
    for (const payload of payloads) await prisma.$executeRaw`SELECT pg_notify(${TERMINAL_CHANNEL}, ${payload})`;
    return true;
}

/** Calls are handed to the sidecar one at a time, in the order they completed. */
let chain: Promise<unknown> = Promise.resolve();
let listening = false;

/** Start taking other nodes' calls for this node's sidecar. Idempotent; called
 *  whenever the sidecar here reports a terminal or relays a request. */
export function listenForTerminalCalls(): void {
    if (listening) return;
    listening = true;
    const assemble = createCallAssembler(terminalNode);
    try {
        live.pgListener().listen(TERMINAL_CHANNEL, {
            onNotice: (payload) => {
                const call = assemble(payload);
                if (call) chain = chain.then(() => callLocalSidecar(call));
            }
        });
    } catch (caught) {
        listening = false;
        console.error("[terminal] calls from other nodes are off:", caught);
    }
}

/** Kept for the size check in the loopback route. */
export const TERMINAL_BODY_BYTES = TERMINAL_FRAME_BYTES + 8192;
