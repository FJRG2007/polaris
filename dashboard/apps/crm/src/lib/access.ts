/**
 * Who reaches which CRM records, and what they may do with them.
 *
 * One sentence: the CRM open in a request is the one on the shelf the reader
 * is working from - their own, where they may do everything, or an
 * organization's, where its roles decide per kind of record whether they may
 * see, change or delete. Being able to open the CRM at all is the instance
 * permission `crm.use`; it never widens what an organization's role allows.
 *
 * Every read and write narrows by `shelfWhere` inside the query; nothing
 * fetches a record and checks its shelf afterwards.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { CrmRefusal } from "./errors";
import { host } from "@polaris/app-host";
import type { CrmObject } from "../model/objects";
import type { AppHostTypes } from "@polaris/app-host";
import { CRM_OBJECTS, CRM_VERBS, hasOrgPermission, type CrmVerb } from "@polaris/core";

export type SessionUser = AppHostTypes["SessionUser"];

/** Where the records live: an organization's shelf or one account's own. */
export interface Shelf {
    readonly orgId: string | null;
    /** Set on a personal shelf only. */
    readonly userId: string | null;
    /** The two above as one string, as `CrmView.shelf` stores it. */
    readonly key: string;
    readonly orgName: string | null;
}

/** What one reader may do with each kind of record on their shelf. */
export type Abilities = Readonly<Record<CrmObject, Readonly<Record<CrmVerb, boolean>>>>;

export interface CrmActor {
    readonly user: SessionUser;
    readonly shelf: Shelf;
    readonly can: Abilities;
}

/** The signed-in person, refusing anybody without the CRM. */
export async function requireCrmUser(): Promise<SessionUser> {
    return host.session.requirePermission("crm.use");
}

function abilities(granted: (object: CrmObject, verb: CrmVerb) => boolean): Abilities {
    return Object.fromEntries(
        CRM_OBJECTS.map((object) => [
            object,
            Object.fromEntries(CRM_VERBS.map((verb) => [verb, granted(object, verb)]))
        ])
    ) as unknown as Abilities;
}

/**
 * The reader, their shelf and what they may do there.
 *
 * In an organization, seeing its CRM is being on its roster (holding
 * `org.read`, which every role but a restricted one does) - the way its Drive
 * is read. Changing and deleting are what a role grants, per kind of record,
 * and either one implies seeing: a restricted role given "edit" on companies is
 * not offered a table it cannot load.
 */
export async function crmActor(user: SessionUser): Promise<CrmActor> {
    const { orgId, orgName } = await host.crmHost.crmShelf(user.id);
    if (!orgId) {
        return {
            user,
            shelf: { orgId: null, userId: user.id, key: `user:${user.id}`, orgName: null },
            can: abilities(() => true)
        };
    }
    const granted =
        (await host.crmHost.crmOrgPermissions({ id: user.id, isAdmin: user.isAdmin }, orgId)) ?? [];
    const holds = (object: CrmObject, verb: CrmVerb) =>
        verb !== "read" && hasOrgPermission(granted, `crm.${object}.${verb}`);
    const member = hasOrgPermission(granted, "org.read");
    return {
        user,
        shelf: { orgId, userId: null, key: `org:${orgId}`, orgName },
        can: abilities(
            (object, verb) =>
                holds(object, verb) ||
                (verb === "read" && (member || holds(object, "edit") || holds(object, "delete")))
        )
    };
}

/** The signed-in reader of the CRM, resolved. */
export async function requireCrmActor(): Promise<CrmActor> {
    return crmActor(await requireCrmUser());
}

/** Refuse unless the reader may do this with this kind of record here. */
export async function requireCan(actor: CrmActor, object: CrmObject, verb: CrmVerb): Promise<void> {
    if (actor.can[object][verb]) return;
    const t = await crmT();
    throw new CrmRefusal(t("errors.forbidden", { verb, object }));
}

/** The rows on this shelf, as a Prisma `where`. */
export function shelfWhere(shelf: Shelf): { orgId: string } | { userId: string; orgId: null } {
    return shelf.orgId ? { orgId: shelf.orgId } : { userId: shelf.userId!, orgId: null };
}

/** The columns that put a new row on this shelf. */
export function shelfData(shelf: Shelf): { orgId: string | null; userId: string | null } {
    return { orgId: shelf.orgId, userId: shelf.orgId ? null : shelf.userId };
}
