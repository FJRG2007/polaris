/**
 * Global activity log. Every meaningful action a user takes - connecting a NAS,
 * reading or writing a file, managing containers, inviting people - is recorded
 * here so operators have one auditable history across all of Polaris. The client
 * IP is stored hashed for privacy while still supporting abuse review; the
 * payload never includes secrets.
 */

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { prisma } from "@polaris/db";

export interface AuditEvent {
    readonly actorId: string | null;
    readonly action: string;
    readonly targetType?: string;
    readonly targetId?: string;
    readonly metadata?: Record<string, unknown>;
}

/** Truncated SHA-256 of the client IP, or undefined when unknown. */
async function clientIpHash(): Promise<string | undefined> {
    const store = await headers();
    const forwarded = store.get("x-forwarded-for")?.split(",")[0]?.trim();
    const ip = forwarded || store.get("x-real-ip") || undefined;
    if (!ip) return undefined;
    return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/** Record one activity event. Never throws - auditing must not break the action. */
export async function recordAudit(event: AuditEvent): Promise<void> {
    try {
        await prisma.auditLog.create({
            data: {
                actorId: event.actorId,
                action: event.action,
                targetType: event.targetType,
                targetId: event.targetId,
                metadata: event.metadata ? JSON.stringify(event.metadata) : null,
                ipHash: await clientIpHash()
            }
        });
    } catch {
        // Swallow: a failed audit write must not fail the user's action.
    }
}

/** Recent activity for the admin view, newest first. */
export async function listActivity(limit = 100) {
    return prisma.auditLog.findMany({
        orderBy: { at: "desc" },
        take: limit,
        select: { id: true, actorId: true, action: true, targetType: true, targetId: true, metadata: true, at: true }
    });
}
