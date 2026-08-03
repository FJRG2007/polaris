/**
 * Looking at Polaris as somebody else. Two things an operator needs and neither
 * is guesswork from a screenshot: what a role actually sees, and what is going on
 * inside one person's account.
 *
 * Both are recorded on the administrator's OWN session rather than by signing in
 * as anybody. That is the whole design: the account being looked at gets no
 * session, so nothing appears on its devices list, nothing is there to be
 * revoked, and the pretence dies with the administrator's own sign-out. It also
 * means a single request never has two identities to reconcile - the session is
 * the administrator's, and what it resolves to is decided in one place.
 *
 * A user view is not a preview: the administrator acts as that person, with their
 * access, and every write lands on their account for real. It is written down at
 * both ends (start and stop) and the banner never leaves the screen, because the
 * only safe version of this feature is a loud one.
 *
 * A role view keeps the administrator's own identity and swaps their grants for
 * the role's, admin bypass included - otherwise every screen would answer "yes"
 * and the preview would be a lie.
 */

import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { ALL_PERMISSIONS, expandPermissions, PERMISSIONS, type Permission } from "@polaris/core";

/**
 * How long a view lasts before it lapses on its own. Long enough to work through
 * whatever prompted it, short enough that an administrator who walked away is not
 * still holding somebody else's account tomorrow.
 */
const VIEW_AS_TTL_MS = 60 * 60 * 1000;

/** The columns that carry a view, as they sit on the session row. */
export interface ViewAsRow {
    viewAsUserId: string | null;
    viewAsRoleId: string | null;
    viewAsAt: Date | null;
}

/** Nothing is being viewed. Cleared rows read this way too. */
const NO_VIEW: ViewAsRow = { viewAsUserId: null, viewAsRoleId: null, viewAsAt: null };

/** What a session resolves to while a view is on. */
export interface ViewAsIdentity {
    mode: "user" | "role";
    /** The administrator who started it - always the real owner of the session. */
    actorId: string;
    actorName: string;
    /** Who or what is being looked at, for the banner. */
    label: string;
    startedAt: string;
    /** When the view lapses on its own. */
    endsAt: string;
    /** The account being acted as. Absent for a role preview, which keeps the
     *  administrator's own identity. */
    user?: { id: string; email: string; name: string; image: string | null; isAdmin: boolean };
    /** The grants that stand in for the administrator's, for a role preview. */
    grants?: Permission[];
}

/** True while the row still carries a view that has not lapsed. */
function isLive(row: ViewAsRow): boolean {
    if (!row.viewAsAt) return false;
    if (!row.viewAsUserId && !row.viewAsRoleId) return false;
    return Date.now() - row.viewAsAt.getTime() < VIEW_AS_TTL_MS;
}

/** Put a session back to being itself. Safe to call when nothing is set. */
async function clear(sessionId: string): Promise<void> {
    await prisma.sessionState.updateMany({ where: { sessionId }, data: NO_VIEW });
}

/**
 * Resolve what this session is looking at, or null when it is simply itself.
 *
 * A view that has lapsed, or that points at an account or role that has since
 * been deleted, is cleared here rather than reported - the administrator lands
 * back in their own session instead of on an error.
 */
export async function resolveViewAs(
    actor: { id: string; name: string; sessionId: string },
    row: ViewAsRow
): Promise<ViewAsIdentity | null> {
    if (!row.viewAsAt) return null;
    if (!isLive(row)) {
        await clear(actor.sessionId);
        return null;
    }

    const common = {
        actorId: actor.id,
        actorName: actor.name,
        startedAt: row.viewAsAt.toISOString(),
        endsAt: new Date(row.viewAsAt.getTime() + VIEW_AS_TTL_MS).toISOString()
    };

    if (row.viewAsUserId) {
        const user = await prisma.user.findUnique({
            where: { id: row.viewAsUserId },
            select: { id: true, email: true, name: true, image: true, isAdmin: true }
        });
        if (!user) {
            await clear(actor.sessionId);
            return null;
        }
        return { mode: "user", ...common, label: user.name, user };
    }

    const role = await prisma.role.findUnique({
        where: { id: row.viewAsRoleId ?? "" },
        select: { name: true, permissions: true }
    });
    if (!role) {
        await clear(actor.sessionId);
        return null;
    }
    return { mode: "role", ...common, label: role.name, grants: roleGrants(role.permissions) };
}

/** A role's grants as a plain list. The wildcard is written out in full, so a
 *  preview of the administrator role behaves like one rather than like an empty
 *  role - what it does NOT carry across is the admin flag, which is the part a
 *  preview exists to take away. */
function roleGrants(raw: string): Permission[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const keys = parsed.filter((value): value is string => typeof value === "string");
    if (keys.includes(ALL_PERMISSIONS)) return [...PERMISSIONS];
    return expandPermissions(keys as Permission[]);
}

/** Start acting as another account. The caller has already established that the
 *  actor is a real administrator on their own, unassumed session. */
export async function viewAsUser(
    actor: { id: string; sessionId: string },
    targetId: string
): Promise<{ error?: string }> {
    if (targetId === actor.id) return { error: "That is already your account." };
    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, email: true } });
    if (!target) return { error: "User not found." };

    const started = await prisma.sessionState.updateMany({
        where: { sessionId: actor.sessionId },
        data: { viewAsUserId: target.id, viewAsRoleId: null, viewAsAt: new Date() }
    });
    if (started.count === 0) return { error: "This session cannot open another account." };

    await recordAudit({
        actorId: actor.id,
        action: "user.view-as.start",
        targetType: "user",
        targetId: target.id,
        sessionId: actor.sessionId,
        metadata: { email: target.email }
    });
    return {};
}

/** Start seeing Polaris with a role's grants instead of your own. */
export async function viewAsRole(
    actor: { id: string; sessionId: string },
    roleId: string
): Promise<{ error?: string }> {
    const role = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true, name: true } });
    if (!role) return { error: "Unknown role." };

    const started = await prisma.sessionState.updateMany({
        where: { sessionId: actor.sessionId },
        data: { viewAsRoleId: role.id, viewAsUserId: null, viewAsAt: new Date() }
    });
    if (started.count === 0) return { error: "This session cannot preview a role." };

    await recordAudit({
        actorId: actor.id,
        action: "role.view-as.start",
        targetType: "role",
        targetId: role.id,
        sessionId: actor.sessionId,
        metadata: { name: role.name }
    });
    return {};
}

/**
 * Go back to being yourself. Recorded against the administrator, not against
 * whoever was being looked at, so the pair of entries reads as one episode.
 */
export async function stopViewAs(actor: { id: string; sessionId: string }): Promise<void> {
    const state = await prisma.sessionState.findUnique({
        where: { sessionId: actor.sessionId },
        select: { viewAsUserId: true, viewAsRoleId: true, viewAsAt: true }
    });
    await clear(actor.sessionId);
    if (!state?.viewAsAt) return;
    await recordAudit({
        actorId: actor.id,
        action: state.viewAsUserId ? "user.view-as.stop" : "role.view-as.stop",
        targetType: state.viewAsUserId ? "user" : "role",
        targetId: state.viewAsUserId ?? state.viewAsRoleId ?? "",
        sessionId: actor.sessionId,
        metadata: { minutes: Math.round((Date.now() - state.viewAsAt.getTime()) / 60_000) }
    });
}
