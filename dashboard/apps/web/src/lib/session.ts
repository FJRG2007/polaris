/**
 * Server-side session and authorization helpers. Every protected page, action,
 * and route resolves the session here and checks permissions server-side - the
 * client capability/role state is only ever cosmetic, so authorization decisions
 * never trust it.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { userHasPermission } from "@polaris/auth";
import type { Permission } from "@polaris/core";
import { auth } from "@/lib/auth";
import { guardSession } from "@/lib/session-guard";

export interface SessionUser {
    id: string;
    email: string;
    name: string;
    image?: string | null;
    isAdmin: boolean;
    /** The session this request arrived on, so a user can manage their own. */
    sessionId: string;
}

/**
 * The current session, or null when unauthenticated. A cookie that cannot be
 * verified (for example one signed with a previous POLARIS_AUTH_SECRET) makes
 * better-auth throw "Unsupported state or unable to authenticate data"; treat
 * that as simply logged-out so the user is sent to sign in again with a fresh
 * cookie, instead of the raw error surfacing on a protected page.
 */
export async function getSession() {
    try {
        return await auth.api.getSession({ headers: await headers() });
    } catch {
        return null;
    }
}

/**
 * Resolve the current user or redirect. Beyond "is there a session", this is
 * where every account-security control is enforced: a ban, an expired or refused
 * session, a sign-in still waiting for approval, and the inactivity lock all end
 * here as a redirect (see session-guard). The screens that resolve those states
 * use resolveSession() instead, or they would redirect to themselves.
 */
export async function requireUser(): Promise<SessionUser> {
    const resolved = await resolveSession();
    if (!resolved) redirect("/oauth/login");
    const verdict = await guardSession({
        userId: resolved.id,
        sessionId: resolved.sessionId,
        sessionCreatedAt: resolved.sessionCreatedAt
    });
    if (!verdict.ok) redirect(verdict.redirect);
    return resolved;
}

/** The signed-in user with no security gate applied, or null. Only the screens
 *  that exist to clear a gate (lock, pending approval) may use this. */
export async function resolveSession(): Promise<(SessionUser & { sessionCreatedAt: Date }) | null> {
    const session = await getSession();
    if (!session?.user || !session.session) return null;
    const user = session.user as { id: string; email: string; name: string; image?: string | null };
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        isAdmin: (session.user as { isAdmin?: boolean }).isAdmin === true,
        sessionId: session.session.id,
        sessionCreatedAt: new Date(session.session.createdAt)
    };
}

/** Require a specific permission; redirect to the drive with a denial flag if missing. */
export async function requirePermission(permission: Permission): Promise<SessionUser> {
    const user = await requireUser();
    if (user.isAdmin) return user;
    if (!(await userHasPermission(user.id, permission))) redirect("/drive?denied=1");
    return user;
}

/** Require the admin flag (the second gate for operator-only surfaces). */
export async function requireAdmin(): Promise<SessionUser> {
    const user = await requireUser();
    if (!user.isAdmin) redirect("/drive?denied=1");
    return user;
}

/** Non-redirecting permission check for a resolved user. Admins always pass.
 *  Use to decide whether to surface an operator-only affordance to a user who
 *  is allowed on the page but may not manage it. */
export async function userHasManage(user: SessionUser, permission: Permission): Promise<boolean> {
    return user.isAdmin || userHasPermission(user.id, permission);
}
