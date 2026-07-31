/**
 * One-shot terminal tickets. A terminal is a WebSocket to the deploy sidecar; the
 * browser cannot set an Authorization header on a WS, so the client mints a
 * short-lived, single-use ticket here and presents its token over the
 * Sec-WebSocket-Protocol header. The sidecar redeems it (burning it) and derives
 * the authorized target and container server-side - the client never names the
 * exec command.
 *
 * Two kinds of terminal share the mechanism. `terminal` and `logs` open a channel
 * on a container through the host daemon; `ssh` opens a shell on a registered
 * server, and there `targetId` holds the Host id. Redeeming an `ssh` ticket also
 * decrypts that host's credentials, because the sidecar runs outside the Next
 * bundle and cannot reach the master key or Prisma itself.
 */

import { prisma } from "@polaris/db";
import { getHostConnection } from "@/lib/host-service";
import { generateToken, hashToken } from "@polaris/core/tokens";

const TICKET_TTL_MS = 60_000;

/** What a ticket authorizes. `ssh` is a shell on a registered server. */
export type TerminalMode = "terminal" | "logs" | "ssh";

export interface MintTicketInput {
    targetId: string;
    containerRef: string;
    mode: TerminalMode;
}

/** Mint a ticket and return the raw token (shown to the client once). */
export async function mintTerminalTicket(userId: string, input: MintTicketInput): Promise<string> {
    const token = generateToken();
    await prisma.deployTicket.create({
        data: {
            tokenHash: hashToken(token),
            userId,
            targetId: input.targetId,
            containerRef: input.containerRef,
            mode: input.mode,
            expiresAt: new Date(Date.now() + TICKET_TTL_MS)
        }
    });
    return token;
}

/** SSH connection parameters handed to the sidecar for an `ssh` ticket. The
 *  private key is included because only this process can decrypt it. */
export interface SshTarget {
    host: string;
    port: number;
    username: string;
    privateKey?: string;
    password?: string;
    passphrase?: string;
    hostKey?: string;
}

export interface RedeemedTicket {
    targetId: string;
    containerRef: string;
    mode: TerminalMode;
    /** Present only for `ssh`, and only when the host still resolves. */
    ssh?: SshTarget;
}

/**
 * Redeem and burn a one-shot ticket, returning its server-derived target. The
 * terminal sidecar calls this over an internal HTTP route rather than touching
 * Prisma directly, because it runs as a separate process outside the Next
 * standalone bundle where the workspace packages are not resolvable.
 *
 * The host is resolved scoped to the user who minted the ticket, so a ticket
 * cannot outlive their access to the server it names.
 */
export async function redeemTerminalTicket(token: string): Promise<RedeemedTicket | null> {
    const ticket = await prisma.deployTicket.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!ticket || ticket.usedAt || ticket.expiresAt < new Date()) return null;
    await prisma.deployTicket.update({ where: { id: ticket.id }, data: { usedAt: new Date() } });

    const mode = resolveMode(ticket.mode);
    if (mode !== "ssh") return { targetId: ticket.targetId, containerRef: ticket.containerRef, mode };

    try {
        const connection = await getHostConnection(ticket.targetId, ticket.userId);
        return {
            targetId: ticket.targetId,
            containerRef: ticket.containerRef,
            mode,
            ssh: {
                host: connection.address,
                port: connection.port,
                username: connection.username,
                privateKey: connection.auth.method === "key" ? connection.auth.privateKey : undefined,
                password: connection.auth.method === "password" ? connection.auth.password : undefined,
                passphrase: connection.auth.method === "key" ? connection.auth.passphrase : undefined,
                hostKey: connection.hostKey
            }
        };
    } catch {
        // The host was removed, or was never this user's. The ticket is already
        // burned, which is the right outcome either way.
        return null;
    }
}

function resolveMode(value: string): TerminalMode {
    if (value === "logs") return "logs";
    if (value === "ssh") return "ssh";
    return "terminal";
}

/** Whether a user may open a shell on this server. Owner-scoped, checked before a
 *  ticket exists so an unauthorized request never mints one. */
export async function canOpenHostShell(userId: string, hostId: string): Promise<boolean> {
    const row = await prisma.host.findFirst({ where: { id: hostId, ownerId: userId }, select: { id: true } });
    return row !== null;
}
