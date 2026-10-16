/**
 * Who an automation acts as, and who may touch one.
 *
 * An automation runs as whoever last published it, re-checked on every run: a
 * banned, disabled or deleted author, one who lost `automations.use`, or one who
 * no longer administers the organization the automation belongs to, stops it.
 * Nothing it does is more than that account could do by hand.
 */

import { prisma } from "@polaris/db";
import { isUuid } from "@/lib/uuid";
import type { RunActor } from "./types";
import { sessionCan, type SessionUser } from "@/lib/session";
import { orgCan, resolveOrgAccess } from "@/lib/orgs/org-service";

/** A shelf: an organization's, or one account's. */
export interface Shelf {
    readonly orgId: string | null;
    readonly userId: string | null;
}

/** What org permission makes someone the author of an organization's automations. */
export const ORG_EDIT_PERMISSION = "spaces.manage";

export async function mayReadShelf(actor: RunActor, shelf: Shelf): Promise<boolean> {
    if (shelf.orgId) return orgCan(await resolveOrgAccess(actor, shelf.orgId), "org.read");
    return shelf.userId === actor.id;
}

/** Create, edit, publish, run by hand. The same check the screens use to hide what it refuses. */
export async function mayEditShelf(actor: RunActor, shelf: Shelf): Promise<boolean> {
    if (shelf.orgId) return orgCan(await resolveOrgAccess(actor, shelf.orgId), ORG_EDIT_PERMISSION);
    return shelf.userId === actor.id;
}

/**
 * Whether this actor may let an automation reach the local network: an
 * administrator of the organization for an org automation, an instance
 * administrator for their own personal one.
 */
export async function mayAllowLocalNetwork(actor: RunActor, shelf: Shelf): Promise<boolean> {
    if (shelf.orgId) return mayEditShelf(actor, shelf);
    return shelf.userId === actor.id && actor.isAdmin;
}

/** The account a run acts as, when it still may; null stops the run. */
export async function automationRunner(automation: {
    runAsId: string | null;
    orgId: string | null;
    userId: string | null;
}): Promise<RunActor | null> {
    const userId = automation.runAsId;
    if (!userId || !isUuid(userId)) return null;
    const found = await prisma.user.findFirst({
        where: { id: userId, bannedAt: null, disabledAt: null },
        select: { id: true, email: true, name: true, isAdmin: true }
    });
    if (!found) return null;
    const user: SessionUser = { ...found, sessionId: "" };
    if (!(await sessionCan(user, "automations.use"))) return null;
    const actor = { id: found.id, isAdmin: found.isAdmin };
    if (!(await mayEditShelf(actor, automation))) return null;
    return actor;
}
