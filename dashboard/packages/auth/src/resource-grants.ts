/**
 * Grants scoped to one thing.
 *
 * A role says what somebody may do anywhere; this says what they may do here.
 * Rows are compiled into the same PolicyStatements the policy engine already
 * resolves, so there is still exactly one evaluator and a deny still wins - this
 * module only owns persistence and the compilation.
 *
 * It is DriveAcl's generic form, and it follows its rules: one row per (principal,
 * resource) replaced rather than stacked, actions stored as a stringified JSON
 * array, and a malformed row contributing nothing rather than everything.
 *
 * What it deliberately does NOT do is touch `markPrincipalsMoved`. That stamp
 * exists so an edge guard notices a token asserting the wrong groups and roles; a
 * resource grant changes neither, so bumping it would only send every guarded
 * session back for a token that says exactly what the old one did.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { principalsOfUser, type PrincipalType } from "./policies.js";

/** One stored grant, with its actions decoded. */
export interface ResourceGrantRow {
    readonly id: string;
    readonly principalType: PrincipalType;
    readonly principalId: string;
    readonly kind: core.ResourceKind;
    readonly resourceId: string;
    readonly actions: core.Permission[];
    readonly effect: "allow" | "deny";
    readonly canShare: boolean;
    readonly note: string | null;
    readonly expiresAt: Date | null;
}

/** What a caller supplies to write one. */
export interface SetResourceGrantInput {
    readonly principalType: PrincipalType;
    readonly principalId: string;
    readonly ref: core.ResourceRef;
    readonly actions: readonly core.Permission[];
    readonly effect?: "allow" | "deny";
    readonly canShare?: boolean;
    readonly note?: string | null;
    readonly expiresAt?: Date | null;
    readonly grantedById: string;
}

/** The columns every read needs, named once. */
const GRANT_FIELDS = {
    id: true,
    principalType: true,
    principalId: true,
    resourceKind: true,
    resourceId: true,
    actions: true,
    effect: true,
    canShare: true,
    note: true,
    expiresAt: true
} as const;

interface StoredGrant {
    id: string;
    principalType: string;
    principalId: string;
    resourceKind: string;
    resourceId: string;
    actions: string;
    effect: string;
    canShare: boolean;
    note: string | null;
    expiresAt: Date | null;
}

/** Decode a stored action list, dropping anything that is not a permission key.
 *  A row nobody can read grants nothing, which is the only safe direction. */
function parseActions(raw: string): core.Permission[] {
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const known = new Set(parsed.filter((value): value is string => typeof value === "string"));
        return core.PERMISSIONS.filter((permission) => known.has(permission));
    } catch {
        return [];
    }
}

/** A stored row in the shape the rest of Polaris reads. Returns null for a row
 *  naming a kind this version does not know. */
function toRow(row: StoredGrant): ResourceGrantRow | null {
    const ref = core.parseResource(`${row.resourceKind}:${row.resourceId}`);
    if (!ref) return null;
    return {
        id: row.id,
        principalType: row.principalType as PrincipalType,
        principalId: row.principalId,
        kind: ref.kind,
        resourceId: row.resourceId,
        actions: parseActions(row.actions),
        effect: row.effect === "deny" ? "deny" : "allow",
        canShare: row.canShare,
        note: row.note,
        expiresAt: row.expiresAt
    };
}

/** The clause that leaves an expired grant behind. Filtered in the query rather
 *  than in code, so a caller who forgets cannot read one back. */
function unexpired(now: Date) {
    return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

/**
 * Every unexpired grant reaching this user, across the three principals they
 * resolve to. The same set policy attachments use, because a group grant has to
 * mean the same thing in both places or one grant would mean two things.
 */
export async function grantsForUser(userId: string, now = new Date()): Promise<ResourceGrantRow[]> {
    const principals = await principalsOfUser(userId);
    if (principals.length === 0) return [];
    const rows = await prisma.resourceGrant.findMany({
        where: { AND: [{ OR: [...principals] }, unexpired(now)] },
        select: GRANT_FIELDS
    });
    return rows.map(toRow).filter((row): row is ResourceGrantRow => row !== null);
}

/** Those grants as engine statements. */
export async function resourceGrantStatements(userId: string, now = new Date()): Promise<core.PolicyStatement[]> {
    return (await grantsForUser(userId, now)).flatMap(grantStatements);
}

/** One grant, compiled. A row with no readable action contributes nothing at all
 *  rather than an empty statement the engine would have to reason about. */
export function grantStatements(grant: ResourceGrantRow): core.PolicyStatement[] {
    if (grant.actions.length === 0) return [];
    return [
        {
            effect: grant.effect,
            actions: grant.actions,
            resources: core.resourcePatterns({ kind: grant.kind, id: grant.resourceId })
        }
    ];
}

/** Every grant on one thing, for the panel that says who reaches it. Expired rows
 *  are included: somebody reading that list is owed the row that lapsed, and the
 *  screen says so. */
export async function grantsOnResource(ref: core.ResourceRef): Promise<ResourceGrantRow[]> {
    const rows = await prisma.resourceGrant.findMany({
        where: { resourceKind: ref.kind, resourceId: ref.id },
        orderBy: { createdAt: "asc" },
        select: GRANT_FIELDS
    });
    return rows.map(toRow).filter((row): row is ResourceGrantRow => row !== null);
}

/** Every grant held by one principal, for the page that shows one person's access. */
export async function grantsForPrincipal(
    principalType: PrincipalType,
    principalId: string
): Promise<ResourceGrantRow[]> {
    const rows = await prisma.resourceGrant.findMany({
        where: { principalType, principalId },
        orderBy: { createdAt: "asc" },
        select: GRANT_FIELDS
    });
    return rows.map(toRow).filter((row): row is ResourceGrantRow => row !== null);
}

/**
 * Create or replace the grant for one (principal, resource) pair.
 *
 * Actions are narrowed to what the kind can carry and then expanded, exactly as a
 * role's are: a moderator who cannot read the server they moderate is a grant
 * that only looks narrower than it is.
 */
export async function setResourceGrant(input: SetResourceGrantInput): Promise<void> {
    const actions = core.expandPermissions(core.grantableActions(input.ref.kind, input.actions));
    if (actions.length === 0) throw new Error("Choose at least one thing they may do");
    const data = {
        principalType: input.principalType,
        principalId: input.principalId,
        resourceKind: input.ref.kind,
        resourceId: input.ref.id,
        actions: JSON.stringify(actions),
        effect: input.effect === "deny" ? "deny" : "allow",
        canShare: input.canShare === true,
        note: input.note?.trim() || null,
        expiresAt: input.expiresAt ?? null,
        grantedById: input.grantedById
    };
    await prisma.resourceGrant.upsert({
        where: {
            principalType_principalId_resourceKind_resourceId: {
                principalType: input.principalType,
                principalId: input.principalId,
                resourceKind: input.ref.kind,
                resourceId: input.ref.id
            }
        },
        create: data,
        update: data
    });
}

/** Remove one grant. Scoped to its resource so an id from another screen cannot
 *  reach a grant on something else. */
export async function removeResourceGrant(ref: core.ResourceRef, grantId: string): Promise<void> {
    await prisma.resourceGrant.deleteMany({
        where: { id: grantId, resourceKind: ref.kind, resourceId: ref.id }
    });
}

/** Drop every grant on a thing. Called when the thing itself goes: an orphan grant
 *  is inert, since it can only reach a row that no longer loads, but leaving it is
 *  the kind of tidiness that stops being optional once ids are reused. */
export async function clearResourceGrants(ref: core.ResourceRef): Promise<void> {
    await prisma.resourceGrant.deleteMany({ where: { resourceKind: ref.kind, resourceId: ref.id } });
}

/**
 * The ids of every resource of a kind this user reaches through a grant carrying
 * the permission, minus anything a deny takes back.
 *
 * This is what widens a list page past "the things I own". It never answers the
 * whole question on its own: the caller still resolves each one properly before
 * acting on it.
 */
export async function grantedResourceIds(
    userId: string,
    kind: core.ResourceKind,
    permission: core.Permission
): Promise<{ ids: string[]; everyOne: boolean }> {
    const grants = (await grantsForUser(userId)).filter(
        (grant) => grant.kind === kind && grant.actions.includes(permission)
    );
    const denied = new Set<string>();
    let deniesEveryOne = false;
    for (const grant of grants) {
        if (grant.effect !== "deny") continue;
        if (grant.resourceId === core.EVERY_RESOURCE) deniesEveryOne = true;
        else denied.add(grant.resourceId);
    }
    if (deniesEveryOne) return { ids: [], everyOne: false };

    const allowed = new Set<string>();
    let everyOne = false;
    for (const grant of grants) {
        if (grant.effect !== "allow") continue;
        if (grant.resourceId === core.EVERY_RESOURCE) everyOne = true;
        else if (!denied.has(grant.resourceId)) allowed.add(grant.resourceId);
    }
    return { ids: [...allowed], everyOne };
}

/** Whether this user holds the permission on at least one thing. What a landing
 *  page and the app switcher ask: an account given one server has to be able to
 *  find the app that server lives in. */
export async function holdsAnyGrantCarrying(userId: string, permission: core.Permission): Promise<boolean> {
    const grants = await grantsForUser(userId);
    return grants.some((grant) => grant.effect === "allow" && grant.actions.includes(permission));
}
