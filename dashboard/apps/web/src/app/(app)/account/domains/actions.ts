"use server";

/**
 * Adding, checking and giving up a domain of your own - yours, or one of an
 * organization's.
 *
 * One set of actions for both because the only thing that differs is who the
 * domain belongs to, and that is decided here rather than passed in: a request
 * naming an organization is cleared against that organization's own permission
 * before anything is written. Passing an owner straight through from the client
 * would be a way to add a domain to somebody else's shelf.
 *
 * Errors come back as `{ error }` rather than thrown, because a rejected server
 * action inside a transition escalates to the nearest error boundary and would
 * replace the whole screen over one refused write.
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { requireOrgPermission } from "@/lib/orgs/org-service";
import {
    addOwnerDomain,
    checkOwnerDomain,
    OwnerDomainError,
    removeOwnerDomain,
    type DomainOwner,
    type OwnerDomainView
} from "@/lib/owner-domains";

/** Which shelf the caller says the domain is on. An organization id is a claim
 *  and is checked; nothing else is accepted. */
export type DomainOwnerRef = { kind: "user" } | { kind: "org"; orgId: string };

interface Caller {
    readonly owner: DomainOwner;
    readonly userId: string;
    readonly isAdmin: boolean;
    readonly orgId: string | null;
}

/**
 * Resolve who is being written for, refusing anything the caller has no standing
 * on. An organization takes its `domains.manage` permission; the personal shelf
 * is always the session's own account and never an id from the request.
 */
async function callerFor(ref: DomainOwnerRef): Promise<Caller> {
    const user = await requireUser();
    if (ref.kind === "user") {
        return { owner: { kind: "user", id: user.id }, userId: user.id, isAdmin: user.isAdmin, orgId: null };
    }
    await requireOrgPermission({ id: user.id, isAdmin: user.isAdmin }, ref.orgId, "domains.manage");
    return { owner: { kind: "org", id: ref.orgId }, userId: user.id, isAdmin: user.isAdmin, orgId: ref.orgId };
}

function failure(caught: unknown, fallback: string): { error: string } {
    if (caught instanceof OwnerDomainError) return { error: caught.message };
    console.error(caught);
    return { error: fallback };
}

/** Both screens that show domains, since either owner's list may have changed. */
function refresh(): void {
    revalidatePath("/account/domains");
    revalidatePath("/account/organizations", "layout");
}

export async function addOwnerDomainAction(
    ref: DomainOwnerRef,
    domain: string
): Promise<{ domain?: OwnerDomainView; error?: string }> {
    try {
        const caller = await callerFor(ref);
        const added = await addOwnerDomain(caller.owner, { domain }, caller.isAdmin);
        await recordAudit({
            actorId: caller.userId,
            orgId: caller.orgId ?? undefined,
            action: "domain.owner.add",
            targetType: "domain",
            metadata: { domain: added.domain }
        });
        refresh();
        return { domain: added };
    } catch (caught) {
        return failure(caught, "Could not add that domain");
    }
}

export async function checkOwnerDomainAction(
    ref: DomainOwnerRef,
    id: string
): Promise<{ domain?: OwnerDomainView; error?: string }> {
    try {
        const caller = await callerFor(ref);
        const checked = await checkOwnerDomain(caller.owner, id);
        refresh();
        return { domain: checked };
    } catch (caught) {
        return failure(caught, "Could not check that domain");
    }
}

export async function removeOwnerDomainAction(ref: DomainOwnerRef, id: string): Promise<{ error?: string }> {
    try {
        const caller = await callerFor(ref);
        await removeOwnerDomain(caller.owner, id);
        await recordAudit({
            actorId: caller.userId,
            orgId: caller.orgId ?? undefined,
            action: "domain.owner.remove",
            targetType: "domain",
            targetId: id
        });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove that domain");
    }
}
