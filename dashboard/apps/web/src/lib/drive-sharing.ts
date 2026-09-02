/**
 * Handing a file or a folder to somebody else.
 *
 * There is already a way to let a person into a location - the access rules on a
 * connection, which say "this principal may do these verbs under this path". A
 * share is that, asked the way a person asks it: pick who, pick whether they may
 * only look or also change things, optionally say when it lapses and why you
 * sent it. So this writes the same rows the access rules do and adds no second
 * notion of permission; what it adds is the two readings nobody had before -
 * what has been shared WITH me, and what I have shared OUT - which the rule
 * table could always answer and nothing ever asked it.
 *
 * Two roles rather than six checkboxes, because that is the choice being made:
 * whether the other person can change your file. The checkboxes are still there
 * for whoever wants them, on the access rules screen, and a grant made that way
 * shows up here honestly as its own thing rather than being rounded to a role.
 */

import { getUserGroupIds } from "@polaris/auth";
import { prisma, VISIBLE_USER } from "@polaris/db";
import { memberOrgIds } from "@/lib/orgs/org-service";
import { baseName, normalizeRelPath, type DriveAction } from "@polaris/core";
import { liveGrants, removeDriveAcl, setDriveAcl } from "@/lib/drive-acl-service";

/** What one person may do with something somebody shared with them. */
export const DRIVE_SHARE_ROLES = ["viewer", "editor"] as const;
export type DriveShareRole = (typeof DRIVE_SHARE_ROLES)[number];

/** The verbs each role stands for. A viewer may open it and take a copy; an
 *  editor may also change, rename and remove what is inside it. */
const ROLE_ACTIONS: Record<DriveShareRole, DriveAction[]> = {
    viewer: ["read", "download"],
    editor: ["read", "download", "write", "rename", "copy", "delete"]
};

export function shareRoleActions(role: DriveShareRole): DriveAction[] {
    return [...ROLE_ACTIONS[role]];
}

/**
 * Which role a set of verbs is, or `custom` when it is not either of them.
 *
 * Never rounded: a grant of read and write only is not "can edit", and calling
 * it that on the screen where somebody checks who can change their files would
 * be the kind of lie that is only found out afterwards.
 */
export function shareRoleOf(actions: readonly DriveAction[]): DriveShareRole | "custom" {
    const held = new Set(actions);
    for (const role of DRIVE_SHARE_ROLES) {
        const wanted = ROLE_ACTIONS[role];
        if (held.size === wanted.length && wanted.every((action) => held.has(action))) return role;
    }
    return "custom";
}

/** Who a share is with, or who it came from. */
export interface SharePerson {
    readonly type: "user" | "group";
    readonly id: string;
    readonly name: string;
}

export interface SharedItem {
    /** The grant's id, which is what stopping the share names. */
    readonly id: string;
    readonly connectionId: string;
    /** Empty string means the whole drive was shared. */
    readonly path: string;
    /** What to call it: the item's own name, or the storage's when it is the lot. */
    readonly name: string;
    readonly role: DriveShareRole | "custom";
    readonly actions: DriveAction[];
    readonly note: string | null;
    /** ISO strings so these cross to the browser unchanged. */
    readonly expiresAt: string | null;
    readonly sharedAt: string;
    /** Whose files these are. */
    readonly owner: SharePerson;
    /** Who it was given to. Absent on the list of what was shared with you -
     *  there it is you. */
    readonly recipient?: SharePerson;
}

/** Give somebody a file or folder. Replaces whatever they held on it before. */
export async function shareWithPerson(input: {
    readonly connectionId: string;
    readonly path: string;
    readonly principalType: "user" | "group";
    readonly principalId: string;
    readonly role: DriveShareRole;
    readonly note?: string | null;
    readonly expiresAt?: Date | null;
    readonly sharedById: string;
}): Promise<void> {
    if (input.principalType === "user" && input.principalId === input.sharedById) {
        throw new Error("That is already yours");
    }
    await setDriveAcl({
        connectionId: input.connectionId,
        path: normalizeRelPath(input.path),
        principalType: input.principalType,
        principalId: input.principalId,
        actions: shareRoleActions(input.role),
        effect: "allow",
        createdById: input.sharedById,
        note: input.note ?? null,
        expiresAt: input.expiresAt ?? null
    });
}

/** Take a share back. Scoped to its connection so an id alone is not a key. */
export async function stopSharing(connectionId: string, grantId: string): Promise<void> {
    await removeDriveAcl(connectionId, grantId);
}

interface GrantRow {
    id: string;
    connectionId: string;
    path: string;
    principalType: string;
    principalId: string;
    actions: string;
    note: string | null;
    expiresAt: Date | null;
    createdAt: Date;
    // Null on an organization's Drive, which belongs to no account. Every
    // caller here is about what one person handed another, so those rows are
    // filtered out before they reach this.
    connection: { name: string; ownerId: string | null };
}

const GRANT_SELECT = {
    id: true,
    connectionId: true,
    path: true,
    principalType: true,
    principalId: true,
    actions: true,
    note: true,
    expiresAt: true,
    createdAt: true,
    connection: { select: { name: true, ownerId: true, orgId: true } }
};

function decodeActions(raw: string): DriveAction[] {
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed)
            ? (parsed.filter((v) => typeof v === "string") as DriveAction[])
            : [];
    } catch {
        return [];
    }
}

/**
 * Everything other people have shared with this account.
 *
 * Both what was given to them by name and what was given to a group they are in,
 * because from where they are standing those are the same thing: something of
 * somebody else's that they can now open.
 */
export async function listSharedWithMe(userId: string): Promise<SharedItem[]> {
    const groupIds = await getUserGroupIds(userId);
    const principals = [
        { principalType: "user", principalId: userId },
        ...groupIds.map((id) => ({ principalType: "group", principalId: id }))
    ];
    const rows = await prisma.driveAcl.findMany({
        where: {
            effect: "allow",
            ...liveGrants(principals),
            // Your own things are not shared with you. This happens for real: a
            // rule written on your own storage naming you, and an administrator
            // handing themselves a grant they already had.
            connection: { ownerId: { not: userId } }
        },
        orderBy: { createdAt: "desc" },
        select: GRANT_SELECT
    });
    if (rows.length === 0) return [];

    // Whose files these are, which is an account for a personal drive and the
    // organization itself for a company shelf.
    //
    // A grant on a company shelf is dropped for the people already on its
    // roster - they reach the whole thing from the shelf's own entry, and it is
    // not something a person handed them. It is kept for everybody else, and
    // that case is the reason the per-folder rules exist: a contractor given one
    // directory is not a member, gets no sidebar entry from
    // `organizationDrivesFor`, and without this has an authorized grant that no
    // screen anywhere produces a link to.
    const mine = new Set(await memberOrgIds(userId));
    const shared = rows.filter(
        (row) => row.connection.ownerId !== null || !mine.has(row.connection.orgId ?? "")
    );
    if (shared.length === 0) return [];

    const [owners, orgs] = await Promise.all([
        peopleByIds(shared.map((row) => row.connection.ownerId).filter((id) => id !== null)),
        prisma.organization.findMany({
            where: {
                id: {
                    in: [
                        ...new Set(
                            shared
                                .filter((row) => row.connection.ownerId === null)
                                .map((row) => row.connection.orgId)
                                .filter((id) => id !== null)
                        )
                    ]
                }
            },
            select: { id: true, name: true }
        })
    ]);
    const byOrg = new Map(orgs.map((org) => [org.id, org.name]));
    return shared.map((row) => {
        const ownerId = row.connection.ownerId;
        if (ownerId !== null) return itemOf(row, owners.get(ownerId) ?? unknownPerson(ownerId));
        const orgId = row.connection.orgId ?? "";
        // An organization stands in the sender's place, as a group rather than
        // a person - which is what it is, and what the screen already draws.
        return itemOf(row, {
            type: "group",
            id: orgId,
            name: byOrg.get(orgId) ?? "An organization that is no longer here"
        });
    });
}

/**
 * Everything this account has given to somebody else, newest first.
 *
 * Their own storages, and the organization shelves they run. A company shelf is
 * owned by no account, so filtering on ownership alone leaves somebody who
 * shared a folder out of it with a grant they can see on the folder's own Access
 * dialog and nowhere on the screen that exists to answer "what have I handed
 * out" - and nowhere to take it back from. It is still only what THEY wrote:
 * `createdById` is what makes this a list of one person's shares rather than of
 * every rule on the shelf.
 */
export async function listSharedByMe(userId: string): Promise<SharedItem[]> {
    const mine = await memberOrgIds(userId);
    const rows = await prisma.driveAcl.findMany({
        where: {
            effect: "allow",
            OR: [
                { connection: { ownerId: userId } },
                ...(mine.length > 0 ? [{ connection: { orgId: { in: mine } } }] : [])
            ],
            // A rule naming the owner is not a share; nor is one somebody else
            // wrote on this storage, which belongs on the access rules screen.
            createdById: userId,
            NOT: { principalType: "user", principalId: userId }
        },
        orderBy: { createdAt: "desc" },
        select: GRANT_SELECT
    });
    if (rows.length === 0) return [];

    const [owner] = await Promise.all([peopleByIds([userId])]);
    const me = owner.get(userId) ?? unknownPerson(userId);
    const recipients = await recipientsOf(rows);
    return rows.map((row) => ({
        ...itemOf(row, me),
        recipient: recipients.get(`${row.principalType}:${row.principalId}`) ?? {
            type: row.principalType === "group" ? "group" : "user",
            id: row.principalId,
            name: "Someone who is no longer here"
        }
    }));
}

function itemOf(row: GrantRow, owner: SharePerson): SharedItem {
    const actions = decodeActions(row.actions);
    return {
        id: row.id,
        connectionId: row.connectionId,
        path: row.path,
        name: row.path === "" ? row.connection.name : baseName(row.path),
        role: shareRoleOf(actions),
        actions,
        note: row.note,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        sharedAt: row.createdAt.toISOString(),
        owner
    };
}

function unknownPerson(id: string): SharePerson {
    return { type: "user", id, name: "Someone who is no longer here" };
}

/** Names for a set of accounts, skipping the ones that are gone or shut. */
async function peopleByIds(ids: readonly string[]): Promise<Map<string, SharePerson>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await prisma.user.findMany({
        where: { id: { in: unique }, ...VISIBLE_USER },
        select: { id: true, name: true }
    });
    return new Map(
        rows.map((row) => [row.id, { type: "user" as const, id: row.id, name: row.name }])
    );
}

/** Names for whoever each grant was written to, people and groups together. */
async function recipientsOf(
    rows: ReadonlyArray<{ principalType: string; principalId: string }>
): Promise<Map<string, SharePerson>> {
    const userIds = rows
        .filter((row) => row.principalType === "user")
        .map((row) => row.principalId);
    const groupIds = rows
        .filter((row) => row.principalType === "group")
        .map((row) => row.principalId);
    const [users, groups] = await Promise.all([
        peopleByIds(userIds),
        groupIds.length === 0
            ? []
            : prisma.group.findMany({
                  where: { id: { in: [...new Set(groupIds)] } },
                  select: { id: true, name: true }
              })
    ]);
    const out = new Map<string, SharePerson>();
    for (const [id, person] of users) out.set(`user:${id}`, person);
    for (const group of groups) {
        out.set(`group:${group.id}`, { type: "group", id: group.id, name: group.name });
    }
    return out;
}
