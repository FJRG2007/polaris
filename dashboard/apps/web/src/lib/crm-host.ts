/**
 * What the CRM app needs from the dashboard beyond what other apps take: which
 * shelf the reader is working from, what their organization's roles let them do
 * there, and who is on that shelf to own a record.
 *
 * Each function is one of the dashboard's own services narrowed to the question
 * the app asks, so `lib/app-host/server.ts` can hand it over without handing the
 * app the whole module behind it.
 *
 * Server-only.
 */

import { resolveScope } from "@/lib/workspace-scope";
import { listOrgMembers, orgCan, resolveOrgAccess, type OrgActor } from "@/lib/orgs/org-service";

/** The shelf somebody is working from: an organization, or their own (null). */
export interface CrmShelf {
    readonly orgId: string | null;
    readonly orgName: string | null;
}

/** The shelf open in this request, with the membership re-checked. */
export async function crmShelf(userId: string): Promise<CrmShelf> {
    const { org } = await resolveScope(userId);
    return { orgId: org?.id ?? null, orgName: org?.name ?? null };
}

/**
 * What this account's role holds in one organization, or null when it is not
 * theirs to see. The wildcard comes back as is; `hasOrgPermission` from
 * `@polaris/core` reads it.
 */
export async function crmOrgPermissions(
    actor: OrgActor,
    orgId: string
): Promise<readonly string[] | null> {
    return (await resolveOrgAccess(actor, orgId))?.permissions ?? null;
}

/** Somebody who can own a record on a shelf. */
export interface CrmShelfPerson {
    readonly id: string;
    readonly name: string;
    /** Their address or handle, as far as they let this reader see it. */
    readonly contact: string;
}

/**
 * Who may be named as a record's owner on an organization's shelf: its roster,
 * with each line under a name as private as the roster screen draws it.
 * Nobody, for a reader whose role does not see the roster.
 */
export async function crmOrgPeople(actor: OrgActor, orgId: string): Promise<CrmShelfPerson[]> {
    if (!orgCan(await resolveOrgAccess(actor, orgId), "org.read")) return [];
    return (await listOrgMembers(orgId, actor)).map((member) => ({
        id: member.userId,
        name: member.name,
        contact: member.contact
    }));
}
