"use server";

/**
 * Session-management actions. Each re-resolves the session, so the ids a client
 * sends are only ever matched against the caller's own sessions - a forged id
 * belonging to another account simply matches nothing.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { listSessionActivity, type SessionActivityEntry } from "@/lib/audit-service";
import { requireUser } from "@/lib/session";
import { decideLoginApproval, revokeOtherSessions, revokeUserSession } from "@/lib/session-directory";

const sessionIdSchema = z.string().uuid();

export async function revokeSessionAction(sessionId: string): Promise<{ error?: string }> {
    const user = await requireUser();
    if (sessionId === user.sessionId) return { error: "Use Sign out to end this session." };
    await revokeUserSession(user.id, String(sessionId));
    revalidatePath("/account/sessions");
    return {};
}

export async function revokeOtherSessionsAction(): Promise<{ count: number }> {
    const user = await requireUser();
    const count = await revokeOtherSessions(user.id, user.sessionId);
    revalidatePath("/account/sessions");
    return { count };
}

/** What was done from one of the caller's sessions, newest first. */
export async function sessionActivityAction(
    sessionId: unknown
): Promise<{ entries?: SessionActivityEntry[]; error?: string }> {
    const user = await requireUser();
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) return { error: "Unknown session." };
    return { entries: await listSessionActivity(user.id, parsed.data) };
}

export async function decideLoginApprovalAction(
    sessionId: string,
    approve: boolean
): Promise<{ error?: string }> {
    const user = await requireUser();
    const result = await decideLoginApproval(user.id, String(sessionId), approve === true);
    if (!result.error) revalidatePath("/account/sessions");
    return result;
}
