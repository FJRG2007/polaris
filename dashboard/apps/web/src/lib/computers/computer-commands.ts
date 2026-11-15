/**
 * Telling a runner to do something, whichever dashboard node holds its socket.
 *
 * A runner keeps one WebSocket open to one node's sidecar. The node that wants
 * it to act (the one the phone's request landed on) is often another. So:
 *
 * - On the node that holds it, the command goes straight to the sidecar over
 *   loopback (`POST /runner/send`, internal key), which writes it to the socket.
 * - Anywhere else it is a NOTIFY on `polaris_runner` naming the runner and the
 *   node; every node listens through the process's one listener connection
 *   (`lib/live/pg-listener`), and the named one hands it to its sidecar. A
 *   command too large for a NOTIFY payload is parked in `AgentRunnerCommand`
 *   and only its id travels; the receiver reads and deletes it.
 *
 * Which node holds a runner is on its row (`relayNode`), written when the
 * sidecar reports it connected. Built from injected parts so the fan-out is
 * asserted against a fake database.
 */

import { z } from "zod";
import os from "node:os";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as live from "@/lib/live/pg-listener";

export const RUNNER_CHANNEL = "polaris_runner";

/** Room left in a NOTIFY payload for the envelope. */
const INLINE_LIMIT = live.NOTIFY_PAYLOAD_LIMIT - 256;

/** A parked command older than this was never collected (its node went away). */
const PARKED_TTL_MS = 5 * 60_000;

/** What a node can be told to do with a runner: a protocol command, or close
 *  its socket (revoked). */
export type RunnerCommand = core.ServerCommand | { readonly type: "close" };

/** This node's name, as the sidecar beside it reports runners under. The two
 *  share a container, so they share a hostname. */
export function relayNode(): string {
    return os.hostname();
}

const noticeSchema = z.object({
    r: z.string().uuid(),
    n: z.string().min(1).max(255),
    m: z.unknown().optional(),
    c: z.string().uuid().optional()
});

/** A command as it arrives from another node: the close marker or a frame
 *  this build would send itself. */
export function readCommand(value: unknown): RunnerCommand | null {
    if (typeof value !== "object" || value === null) return null;
    if ((value as { type?: unknown }).type === "close") return { type: "close" };
    const parsed = core.serverMessageSchema.safeParse({
        ...(value as object),
        v: core.RUNNER_PROTOCOL_VERSION
    });
    if (!parsed.success) return null;
    if (!(core.RELAYED_SERVER_TYPES as readonly string[]).includes(parsed.data.type)) return null;
    const { v: _version, ...command } = parsed.data;
    return command as core.ServerCommand;
}

export interface CommandDeps {
    readonly node: () => string;
    /** Where the runner's socket is, or null when it is not connected. */
    readonly locate: (runnerId: string) => Promise<string | null>;
    readonly notify: (payload: string) => Promise<void>;
    readonly park: (runnerId: string, body: string) => Promise<string>;
    readonly collect: (id: string) => Promise<{ runnerId: string; body: string } | null>;
    /** Hand a command to the sidecar on this node. True when it held the runner. */
    readonly local: (runnerId: string, command: RunnerCommand) => Promise<boolean>;
}

export function createRunnerCommands(deps: CommandDeps) {
    return {
        /** Send a command. False when the runner is not connected anywhere, or
         *  its node is this one and the sidecar no longer holds it. True for a
         *  command handed to another node: delivery there is best effort. */
        async send(runnerId: string, command: RunnerCommand): Promise<boolean> {
            const node = await deps.locate(runnerId);
            if (!node) return false;
            if (node === deps.node()) return deps.local(runnerId, command);
            const inline = JSON.stringify({ r: runnerId, n: node, m: command });
            if (inline.length <= INLINE_LIMIT) {
                await deps.notify(inline);
                return true;
            }
            const id = await deps.park(runnerId, JSON.stringify(command));
            await deps.notify(JSON.stringify({ r: runnerId, n: node, c: id }));
            return true;
        },

        /** A notice from another node. Acted on only by the node it names. */
        async receive(payload: string): Promise<void> {
            let json: unknown;
            try {
                json = JSON.parse(payload);
            } catch {
                return;
            }
            const notice = noticeSchema.safeParse(json);
            if (!notice.success || notice.data.n !== deps.node()) return;
            let raw: unknown = notice.data.m;
            if (notice.data.c) {
                const parked = await deps.collect(notice.data.c);
                if (!parked || parked.runnerId !== notice.data.r) return;
                try {
                    raw = JSON.parse(parked.body);
                } catch {
                    return;
                }
            }
            const command = readCommand(raw);
            if (command) await deps.local(notice.data.r, command).catch(() => false);
        }
    };
}

/** The sidecar's loopback address on this node. Same default as ws-server.mjs. */
function sidecarUrl(path: string): string {
    return `http://127.0.0.1:${Number(process.env.POLARIS_WS_PORT || 3001)}${path}`;
}

const runnerCommands = createRunnerCommands({
    node: relayNode,
    locate: async (runnerId) => {
        const row = await prisma.agentRunner.findUnique({
            where: { id: runnerId },
            select: { relayNode: true }
        });
        return row?.relayNode ?? null;
    },
    notify: async (payload) => {
        await prisma.$executeRaw`SELECT pg_notify(${RUNNER_CHANNEL}, ${payload})`;
    },
    park: async (runnerId, body) => {
        await prisma.agentRunnerCommand
            .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - PARKED_TTL_MS) } } })
            .catch(() => undefined);
        const row = await prisma.agentRunnerCommand.create({
            data: { runnerId, body },
            select: { id: true }
        });
        return row.id;
    },
    collect: async (id) => {
        const row = await prisma.agentRunnerCommand.findUnique({
            where: { id },
            select: { runnerId: true, body: true }
        });
        if (!row) return null;
        const spent = await prisma.agentRunnerCommand.deleteMany({ where: { id } });
        return spent.count > 0 ? row : null;
    },
    local: async (runnerId, command) => {
        const response = await fetch(sidecarUrl("/runner/send"), {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-internal-key": process.env.POLARIS_AUTH_SECRET ?? ""
            },
            body: JSON.stringify({ runnerId, command }),
            signal: AbortSignal.timeout(5_000)
        }).catch(() => null);
        if (!response?.ok) return false;
        const body = (await response.json().catch(() => null)) as { held?: unknown } | null;
        return body?.held === true;
    }
});

let listening = false;

/** Start taking other nodes' commands for runners held here. Idempotent;
 *  called whenever this node's sidecar reports a runner. */
export function listenForRunnerCommands(): void {
    if (listening) return;
    listening = true;
    try {
        live.pgListener().listen(RUNNER_CHANNEL, {
            onNotice: (payload) => void runnerCommands.receive(payload)
        });
    } catch (caught) {
        console.error("[runner] commands from other nodes are off:", caught);
    }
}

/** Send a runner a command. See `createRunnerCommands().send`. */
export function sendToRunner(runnerId: string, command: RunnerCommand): Promise<boolean> {
    return runnerCommands.send(runnerId, command).catch((caught: unknown) => {
        console.error(`[runner] ${runnerId}: command not sent:`, caught);
        return false;
    });
}
