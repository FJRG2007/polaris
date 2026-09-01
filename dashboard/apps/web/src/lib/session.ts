/**
 * Server-side session and authorization helpers. Every protected page, action,
 * and route resolves the session here and checks permissions server-side - the
 * client capability/role state is only ever cosmetic, so authorization decisions
 * never trust it.
 *
 * This is also the one place a session becomes an identity. An administrator can
 * be looking at Polaris as another account or through a role's grants (see
 * view-as-service), and requireUser is where that is applied - once, on the way
 * in - so no surface can accidentally resolve the administrator's own access
 * while the rest of the page shows somebody else's.
 */

import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { guardSession, type SessionVerdict } from "@/lib/session-guard";
import { canAny, userHasPermission } from "@polaris/auth";
import { isAppInstalled } from "@/lib/apps/install-presence";
import { hasPermission, type Permission } from "@polaris/core";
import { homePathFor, type AppAccessInput } from "@/lib/app-access";
import { resolveViewAs, type ViewAsIdentity } from "@/lib/view-as-service";

export interface SessionUser {
    id: string;
    email: string;
    name: string;
    image?: string | null;
    isAdmin: boolean;
    /** The session this request arrived on, so a user can manage their own. */
    sessionId: string;
    /** Set when an administrator is looking at Polaris as somebody else. The
     *  fields above are then the identity being looked at, not the
     *  administrator's - who they really are is in here. */
    viewingAs?: ViewAsIdentity;
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
 *
 * The guard always runs against the real session - the administrator's own - so
 * viewing another account never borrows or bypasses that account's controls.
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
    return identityFor(resolved, verdict.view);
}

/**
 * The same answer as requireUser, but null instead of a redirect.
 *
 * For the handful of pages that are readable without an account and only want to
 * know whether to draw the signed-in chrome around themselves - a public profile
 * is the whole of it today. Sending that reader to sign in would be turning them
 * away from a page built to be handed out, and drawing the app's navigation for
 * somebody whose session is locked or still waiting for approval would be a rail
 * full of links that all bounce them back to the gate.
 *
 * So a gate that requireUser would redirect on reads as "no chrome" here, not as
 * "no session": who the page is shown to is still resolveSession's answer and is
 * decided by each account's privacy, exactly as it is for a signed-out reader.
 */
export async function guardedUser(): Promise<SessionUser | null> {
    const resolved = await resolveSession();
    if (!resolved) return null;
    const verdict = await guardSession({
        userId: resolved.id,
        sessionId: resolved.sessionId,
        sessionCreatedAt: resolved.sessionCreatedAt
    });
    if (!verdict.ok) return null;
    return identityFor(resolved, verdict.view);
}

/** Which identity a cleared session is acting as. */
async function identityFor(
    resolved: SessionUser & { sessionCreatedAt: Date },
    view: Extract<SessionVerdict, { ok: true }>["view"]
): Promise<SessionUser> {
    const resolvedView = await resolveViewAs(resolved, view);
    if (!resolvedView) return resolved;
    // A user view swaps the identity outright; a role view keeps the
    // administrator's own and only takes their grants away, admin flag included -
    // a preview that still passed every check would not be a preview.
    if (resolvedView.mode === "user" && resolvedView.user) {
        return { ...resolvedView.user, sessionId: resolved.sessionId, viewingAs: resolvedView };
    }
    return { ...resolved, isAdmin: false, viewingAs: resolvedView };
}

/** The signed-in user with no security gate applied, or null. Only the screens
 *  that exist to clear a gate (lock, pending approval) may use this, plus the
 *  controls that start and end a view - those must see the real session. */
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

/**
 * Whether a resolved user holds a capability right now. One answer for all three
 * cases: a role preview is judged on the previewed grants alone, an administrator
 * passes everything, and anybody else is resolved against their roles and
 * policies.
 */
export async function sessionCan(user: SessionUser, permission: Permission): Promise<boolean> {
    if (user.viewingAs?.mode === "role") return hasPermission(user.viewingAs.grants ?? [], permission);
    if (user.isAdmin) return true;
    return userHasPermission(user.id, permission);
}

/**
 * Whether this user holds a capability globally, or on at least one thing.
 *
 * The question navigation asks, and only navigation. Somebody given one game
 * server holds no global `games.read`, so on the strict answer the rail hides Game
 * servers and "home" sends them to their account - they would reach the one screen
 * they were given access to only by being sent the link, every time.
 *
 * Never a substitute for sessionCan: creating a server, or anything else that is
 * not about a particular thing, stays on the global question.
 */
export async function sessionCanAny(user: SessionUser, permission: Permission): Promise<boolean> {
    if (user.viewingAs?.mode === "role") return hasPermission(user.viewingAs.grants ?? [], permission);
    if (user.isAdmin) return true;
    return canAny(user.id, permission);
}

/** This user's own capability check, in the shape the app registry asks for. Built
 *  on the "anywhere at all" answer, because that is what deciding whether to draw
 *  a link means. Carries the install probe too, so an app that only exists once
 *  somebody adds it is answered for here rather than at each screen that lists
 *  apps. */
export function accessFor(user: SessionUser): AppAccessInput {
    return {
        isAdmin: user.isAdmin,
        can: (permission) => sessionCanAny(user, permission),
        isInstalled: isAppInstalled
    };
}

/** Where this user belongs: the first app they can open, or their own account. */
export async function homePathForUser(user: SessionUser): Promise<string> {
    return homePathFor(accessFor(user));
}

/**
 * Require a specific permission. A user who lacks it is sent to whichever app
 * they can actually reach - for an account that reaches none, that is their own
 * account page. Sending everybody to Drive would loop forever for exactly the
 * people who most need to land somewhere.
 */
export async function requirePermission(permission: Permission): Promise<SessionUser> {
    const user = await requireUser();
    if (await sessionCan(user, permission)) return user;
    redirect(`${await homePathForUser(user)}?denied=1`);
}

/**
 * Require a permission held globally or on at least one thing.
 *
 * For the landing page of an app whose contents are then narrowed thing by thing -
 * the game server list, which shows what you own and what you were given, and
 * refuses each of them separately. Anything that acts on one thing uses
 * requireResource; anything instance-wide stays on requirePermission.
 */
export async function requirePermissionAny(permission: Permission): Promise<SessionUser> {
    const user = await requireUser();
    if (await sessionCanAny(user, permission)) return user;
    redirect(`${await homePathForUser(user)}?denied=1`);
}

/** Require the admin flag (the second gate for operator-only surfaces). */
export async function requireAdmin(): Promise<SessionUser> {
    const user = await requireUser();
    if (!user.isAdmin) redirect(`${await homePathForUser(user)}?denied=1`);
    return user;
}

/** Non-redirecting permission check for a resolved user. Admins always pass.
 *  Use to decide whether to surface an operator-only affordance to a user who
 *  is allowed on the page but may not manage it. */
export async function userHasManage(user: SessionUser, permission: Permission): Promise<boolean> {
    return sessionCan(user, permission);
}
