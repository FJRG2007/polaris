/**
 * Who a request about a domain of one's own is written for.
 *
 * Shared by every action on those domains - adding, checking, their
 * certificate, their DNS records - so the one rule that keeps a request off
 * somebody else's shelf is written once: an organization id is a claim and is
 * cleared against that organization's `domains.manage` permission, and the
 * personal shelf is always the session's own account, never an id from the
 * request. Not a server action file on purpose: exporting this from one would
 * make it callable from the browser.
 */

import { requireUser } from "@/lib/session";
import type { DomainOwner } from "@/lib/owner-domains";
import { requireOrgPermission } from "@/lib/orgs/org-service";

/** Which shelf the caller says the domain is on. */
export type DomainOwnerRef = { kind: "user" } | { kind: "org"; orgId: string };

export interface DomainCaller {
    readonly owner: DomainOwner;
    readonly userId: string;
    readonly isAdmin: boolean;
    readonly orgId: string | null;
}

export async function domainCallerFor(ref: DomainOwnerRef): Promise<DomainCaller> {
    const user = await requireUser();
    if (ref.kind === "user") {
        return {
            owner: { kind: "user", id: user.id },
            userId: user.id,
            isAdmin: user.isAdmin,
            orgId: null
        };
    }
    await requireOrgPermission({ id: user.id, isAdmin: user.isAdmin }, ref.orgId, "domains.manage");
    return {
        owner: { kind: "org", id: ref.orgId },
        userId: user.id,
        isAdmin: user.isAdmin,
        orgId: ref.orgId
    };
}
