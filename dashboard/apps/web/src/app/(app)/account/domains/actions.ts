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
import { recordAudit } from "@/lib/audit-service";
import { domainCallerFor as callerFor, type DomainOwnerRef } from "@/lib/owner-domain-caller";
import {
    addOwnerDomain,
    checkOwnerDomain,
    getOwnerDomain,
    OwnerDomainError,
    removeOwnerDomain,
    retryOwnerDomainCertificateFor,
    setOwnerDomainDnsToken,
    type OwnerDomainView
} from "@/lib/owner-domains";

export type { DomainOwnerRef } from "@/lib/owner-domain-caller";

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

/** One domain as it stands, for a screen waiting on its certificate. */
export async function readOwnerDomainAction(
    ref: DomainOwnerRef,
    id: string
): Promise<{ domain?: OwnerDomainView; error?: string }> {
    try {
        const caller = await callerFor(ref);
        return { domain: await getOwnerDomain(caller.owner, id) };
    } catch (caught) {
        return failure(caught, "Could not read that domain");
    }
}

/** Give a domain a DNS token of its own for its wildcard certificate, or clear it
 *  with an empty token. The token itself is never logged or sent back. */
export async function setOwnerDomainDnsTokenAction(
    ref: DomainOwnerRef,
    id: string,
    token: string
): Promise<{ domain?: OwnerDomainView; error?: string }> {
    try {
        const caller = await callerFor(ref);
        const updated = await setOwnerDomainDnsToken(caller.owner, id, { token });
        await recordAudit({
            actorId: caller.userId,
            orgId: caller.orgId ?? undefined,
            action: updated.hasDnsToken ? "domain.owner.dns-token.set" : "domain.owner.dns-token.clear",
            targetType: "domain",
            targetId: id,
            metadata: { domain: updated.domain }
        });
        refresh();
        return { domain: updated };
    } catch (caught) {
        return failure(caught, "Could not save that token");
    }
}

/** Order a domain's certificate now rather than after the wait a failure set. */
export async function retryOwnerDomainCertificateAction(
    ref: DomainOwnerRef,
    id: string
): Promise<{ domain?: OwnerDomainView; error?: string }> {
    try {
        const caller = await callerFor(ref);
        await retryOwnerDomainCertificateFor(caller.owner, id);
        return { domain: await getOwnerDomain(caller.owner, id) };
    } catch (caught) {
        return failure(caught, "Could not start the certificate order");
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
