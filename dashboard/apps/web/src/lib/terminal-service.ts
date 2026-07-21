/**
 * One-shot terminal tickets. A terminal is a WebSocket to the deploy sidecar; the
 * browser cannot set an Authorization header on a WS, so the client mints a
 * short-lived, single-use ticket here and presents its token over the
 * Sec-WebSocket-Protocol header. The sidecar redeems it (burning it) and derives
 * the authorized target and container server-side - the client never names the
 * exec command.
 */

import { prisma } from "@polaris/db";
import { generateToken, hashToken } from "@polaris/core/tokens";

const TICKET_TTL_MS = 60_000;

export interface MintTicketInput {
    targetId: string;
    containerRef: string;
    mode: "terminal" | "logs";
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

export interface RedeemedTicket {
    targetId: string;
    containerRef: string;
    mode: "terminal" | "logs";
}

/**
 * Redeem and burn a one-shot ticket, returning its server-derived target and
 * container. The terminal sidecar calls this over an internal HTTP route rather
 * than touching Prisma directly, because it runs as a separate process outside
 * the Next standalone bundle where the workspace packages are not resolvable.
 */
export async function redeemTerminalTicket(token: string): Promise<RedeemedTicket | null> {
    const ticket = await prisma.deployTicket.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!ticket || ticket.usedAt || ticket.expiresAt < new Date()) return null;
    await prisma.deployTicket.update({ where: { id: ticket.id }, data: { usedAt: new Date() } });
    return {
        targetId: ticket.targetId,
        containerRef: ticket.containerRef,
        mode: ticket.mode === "logs" ? "logs" : "terminal"
    };
}
