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
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import type { CrmObject } from "../model/objects";
import { OPEN_RULES, ownWhere, readRules, type RoleRules } from "../model/roles";
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
    /** What the reader's role is further held to; absent is open. */
    readonly rules?: RoleRules;
    /** Whether the reader may change those rules for the organization's roles. */
    readonly manageRoles?: boolean;
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
    return actorOn(user, orgId, orgName);
}

/** Somebody working on a given shelf - their own when `orgId` is null - with
 *  what their role there lets them do now. A workflow runs as this. */
export async function actorOn(
    user: SessionUser,
    orgId: string | null,
    orgName: string | null
): Promise<CrmActor> {
    if (!orgId) {
        return {
            user,
            shelf: { orgId: null, userId: user.id, key: `user:${user.id}`, orgName: null },
            can: abilities(() => true),
            rules: OPEN_RULES,
            manageRoles: false
        };
    }
    const access = await host.crmHost.crmOrgAccess({ id: user.id, isAdmin: user.isAdmin }, orgId);
    const granted = access?.permissions ?? [];
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
        ),
        // The owner and a full-access role are held to nothing.
        rules:
            access?.role && !granted.includes("*") ? await loadRules(orgId, access.role) : OPEN_RULES,
        manageRoles: hasOrgPermission(granted, "roles.manage")
    };
}

/** The CRM rules stored for one role of an organization. */
async function loadRules(orgId: string, role: string): Promise<RoleRules> {
    return readRules(
        await prisma.crmRoleRule.findMany({
            where: { orgId, role },
            select: { object: true, rows: true, hidden: true, readOnly: true }
        })
    );
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

/**
 * The records of a kind this reader reaches, as a Prisma `where`: the shelf,
 * narrowed to their own records when their role is held to those. Every query
 * on a record table goes through this or `listWhere`.
 */
export function recordWhere(actor: CrmActor, object: CrmObject): Record<string, unknown> {
    const own = ownClause(actor, object);
    return own ? { ...shelfWhere(actor.shelf), AND: [own] } : shelfWhere(actor.shelf);
}

/** The clause keeping a reader to their own records, or null when they reach all. */
export function ownClause(actor: CrmActor, object: CrmObject): Record<string, unknown> | null {
    return actor.rules?.[object].rows === "own" ? ownWhere(object, actor.user.id) : null;
}

/** Refuse when the reader's role keeps any of these fields hidden. */
export async function requireShown(
    actor: CrmActor,
    object: CrmObject,
    keys: Iterable<string>
): Promise<void> {
    const hidden = actor.rules?.[object].hidden ?? [];
    if (hidden.length === 0) return;
    for (const key of keys) {
        if (hidden.includes(key)) {
            const t = await crmT();
            throw new CrmRefusal(t("errors.fieldHidden"));
        }
    }
}

/** Refuse when the reader's role may not change any of these fields. */
export async function requireChangeable(
    actor: CrmActor,
    object: CrmObject,
    keys: Iterable<string>,
    label: (key: string) => Promise<string>
): Promise<void> {
    const rule = actor.rules?.[object];
    if (!rule) return;
    for (const key of keys) {
        if (rule.hidden.includes(key) || rule.readOnly.includes(key)) {
            const t = await crmT();
            throw new CrmRefusal(t("errors.fieldLocked", { field: await label(key) }));
        }
    }
}

/** The columns that put a new row on this shelf. */
export function shelfData(shelf: Shelf): { orgId: string | null; userId: string | null } {
    return { orgId: shelf.orgId, userId: shelf.orgId ? null : shelf.userId };
}
