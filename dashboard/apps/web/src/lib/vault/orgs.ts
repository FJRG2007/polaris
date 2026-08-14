/**
 * Vaults beyond the one every account starts with: a second vault of somebody's
 * own, or an organization's.
 *
 * Both are one row and one set of rules here, because they are the same thing -
 * a key, and the people who hold it. What differs is only who decides the shape:
 * an organization's is governed by the Polaris roster and the `vault.manage`
 * permission, a personal one by whoever owns it.
 *
 * The key is the part Polaris cannot help with. Items are encrypted under the
 * vault's own key, and being on a roster does not hand it to you - somebody who
 * already holds it has to wrap it to your public key. That step is the whole
 * difference between a permission and access, and it is why membership lives
 * here beside the Polaris rows rather than being read off them.
 *
 * Creating one and confirming a member both happen from the Polaris screens,
 * because both need a browser holding an unlocked vault. Clients read what
 * exists and work inside it; they do not create it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { bumpRevision } from "@/lib/vault/account";
import { deleteVaultBlob } from "@/lib/vault/blobs";
import { vaultAttachmentPaths } from "@/lib/vault/ciphers";

/** The one form an address is stored in. `VaultOrgUser` is unique on
 *  `(orgId, email)`, so a creator stored with different case than an invite
 *  would be the same person twice. */
function address(email: string): string {
    return email.trim().toLowerCase();
}

/** What somebody may do in an organization's vault. */
export interface OrgStanding {
    /** The membership row, when there is one. */
    memberId: string;
    type: number;
    accessAll: boolean;
    confirmed: boolean;
}

/** Where this account stands in one organization's vault, or null. */
export async function standingIn(userId: string, orgId: string): Promise<OrgStanding | null> {
    const row = await prisma.vaultOrgUser.findFirst({
        where: { userId, orgId },
        select: { id: true, type: true, accessAll: true, status: true }
    });
    if (!row) return null;
    return {
        memberId: row.id,
        type: row.type,
        accessAll: row.accessAll,
        confirmed: row.status === core.ORG_USER_CONFIRMED
    };
}

/** Whether this account may change an organization's shape - its collections,
 *  its members - rather than only use what is in it. */
export function mayAdminister(standing: OrgStanding | null): boolean {
    if (!standing?.confirmed) return false;
    return (
        standing.type === core.ORG_ROLE_OWNER ||
        standing.type === core.ORG_ROLE_ADMIN ||
        standing.type === core.ORG_ROLE_MANAGER
    );
}

/** The keys a browser minted for a new vault, whoever it is going to belong to. */
interface NewVaultKeys {
    creatorUserId: string;
    creatorEmail: string;
    publicKey: string;
    encryptedPrivateKey: string;
    /** The vault's key, wrapped to the creator's public key. */
    creatorKey: string;
    /** The first collection's name, encrypted under the vault's key. */
    collectionName: string;
}

/** Whether a set of minted keys is the shape a vault can be built from. */
function keysUsable(input: NewVaultKeys): boolean {
    return (
        core.isEncString(input.encryptedPrivateKey) &&
        core.isEncString(input.creatorKey) &&
        core.isEncString(input.collectionName) &&
        input.publicKey.length > 0
    );
}

/**
 * Write the vault, its first collection, and its creator as the one member who
 * holds the key. The owner is whichever of the two ids is set.
 */
async function insertVault(
    owner: { organizationId: string; name?: undefined } | { organizationId?: undefined; name: string },
    input: NewVaultKeys
): Promise<string> {
    const created = await prisma.vaultOrganization.create({
        data: {
            organizationId: owner.organizationId ?? null,
            ownerUserId: owner.organizationId ? null : input.creatorUserId,
            name: owner.name ?? null,
            publicKey: input.publicKey,
            privateKey: input.encryptedPrivateKey,
            members: {
                create: {
                    userId: input.creatorUserId,
                    email: address(input.creatorEmail),
                    status: core.ORG_USER_CONFIRMED,
                    type: core.ORG_ROLE_OWNER,
                    key: input.creatorKey,
                    accessAll: true
                }
            },
            collections: { create: { name: input.collectionName } }
        },
        select: { id: true }
    });
    await bumpRevision(input.creatorUserId);
    return created.id;
}

/**
 * Give a Polaris organization a vault.
 *
 * The keys are minted in a browser: the organization's own pair, and its
 * symmetric key wrapped to the creator's public key so they can open it again.
 * Nothing here can produce them, which is the point.
 */
export async function createOrganizationVault(
    input: NewVaultKeys & { organizationId: string }
): Promise<{ ok: true; id: string } | { ok: false; reason: "exists" | "keys" }> {
    if (!keysUsable(input)) return { ok: false, reason: "keys" };
    const existing = await prisma.vaultOrganization.findUnique({
        where: { organizationId: input.organizationId },
        select: { id: true }
    });
    if (existing) return { ok: false, reason: "exists" };

    const id = await insertVault({ organizationId: input.organizationId }, input);
    await recordAudit({
        actorId: input.creatorUserId,
        action: "vault.org.create",
        targetType: "organization",
        targetId: input.organizationId
    });
    return { ok: true, id };
}

/**
 * Give somebody a second vault of their own.
 *
 * The same row an organization's vault uses, with one member in it. That is what
 * makes it shareable later without moving anything: letting somebody in is the
 * step that already exists, and until it happens this is a vault of one.
 */
export async function createPersonalVault(
    input: NewVaultKeys & { name: string }
): Promise<{ ok: true; id: string } | { ok: false; reason: "keys" | "too_many" }> {
    if (!keysUsable(input)) return { ok: false, reason: "keys" };
    const held = await prisma.vaultOrganization.count({
        where: { ownerUserId: input.creatorUserId }
    });
    if (held >= core.MAX_OWNED_VAULTS) return { ok: false, reason: "too_many" };

    const id = await insertVault({ name: input.name }, input);
    await recordAudit({
        actorId: input.creatorUserId,
        action: "vault.create",
        targetType: "vault",
        targetId: id
    });
    return { ok: true, id };
}

/** One vault, whoever owns it. */
export async function vaultById(vaultId: string) {
    return prisma.vaultOrganization.findUnique({
        where: { id: vaultId },
        select: {
            id: true,
            organizationId: true,
            ownerUserId: true,
            name: true,
            publicKey: true,
            organization: { select: { name: true, slug: true } }
        }
    });
}

/**
 * Every vault this account can see, in one query.
 *
 * Three ways in, and they are not the same: a vault of your own, one somebody
 * let you into, and one belonging to an organization you are on the roster of -
 * that last one appears even before anybody hands you its key, because it is
 * what the screen offers to let you in through.
 */
export async function vaultsReachableBy(userId: string, organizationIds: string[]) {
    return prisma.vaultOrganization.findMany({
        where: {
            OR: [
                { ownerUserId: userId },
                { members: { some: { userId, status: { not: core.ORG_USER_REVOKED } } } },
                ...(organizationIds.length > 0
                    ? [{ organizationId: { in: organizationIds } }]
                    : [])
            ]
        },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            organizationId: true,
            ownerUserId: true,
            name: true,
            publicKey: true,
            organization: { select: { name: true, slug: true } },
            members: {
                where: { userId },
                select: { id: true, key: true, status: true, type: true, accessAll: true }
            }
        }
    });
}

/** Rename a vault of somebody's own. An organization's takes its name from the
 *  organization, so there is nothing here to change. */
export async function renameVault(vaultId: string, name: string): Promise<boolean> {
    const { count } = await prisma.vaultOrganization.updateMany({
        where: { id: vaultId, ownerUserId: { not: null } },
        data: { name }
    });
    return count === 1;
}

/**
 * Delete a vault and everything in it.
 *
 * The rows cascade; the attachment ciphertext does not, so it is read before the
 * delete and removed after. Every member's revision is bumped first - a client
 * that never notices keeps drawing a vault whose key opens nothing.
 */
export async function deleteVault(vaultId: string): Promise<boolean> {
    const members = await prisma.vaultOrgUser.findMany({
        where: { orgId: vaultId },
        select: { userId: true }
    });
    const paths = await vaultAttachmentPaths(vaultId);
    const { count } = await prisma.vaultOrganization.deleteMany({ where: { id: vaultId } });
    if (count === 0) return false;
    for (const path of paths) await deleteVaultBlob(path);
    for (const member of members) await bumpRevision(member.userId);
    return true;
}

/** Invite somebody by address. They hold no key until they are confirmed. */
export async function inviteMember(
    orgId: string,
    email: string,
    type: number
): Promise<{ ok: boolean }> {
    const stored = address(email);
    const user = await prisma.user.findUnique({ where: { email: stored }, select: { id: true } });
    await prisma.vaultOrgUser.upsert({
        where: { orgId_email: { orgId, email: stored } },
        create: {
            orgId,
            email: stored,
            userId: user?.id ?? null,
            type,
            status: core.ORG_USER_INVITED
        },
        update: { type }
    });
    return { ok: true };
}

/**
 * Hand the vault's key to a member, and say how much of the vault they reach.
 *
 * The wrapped key is produced by an administrator's browser, to that member's
 * public key. Until this runs the member is on the list and can decrypt nothing,
 * which is the correct state for somebody who has been invited but not vouched
 * for.
 *
 * The key opens the whole vault either way - one key, one vault, and there is no
 * arithmetic that hands over half of it. What the scope decides is what the
 * server will SHOW them and let them write: a member scoped to two collections
 * syncs those two. That is a real boundary against the clients people use and a
 * paper one against somebody who keeps the key and writes their own client, and
 * it is the same trade Bitwarden makes. Sharing a vault with somebody you would
 * not trust with all of it means a second vault, not a narrower scope.
 */
export async function confirmMember(
    orgId: string,
    memberId: string,
    wrappedKey: string,
    scope: core.VaultScope
): Promise<boolean> {
    if (!core.isEncString(wrappedKey)) return false;
    const { count } = await prisma.vaultOrgUser.updateMany({
        where: { id: memberId, orgId },
        data: { key: wrappedKey, status: core.ORG_USER_CONFIRMED, accessAll: scope.accessAll }
    });
    if (count === 0) return false;
    await writeScope(orgId, memberId, scope);
    return true;
}

/**
 * Change what a member reaches: the whole vault, or the collections named.
 *
 * The rows are replaced rather than merged. Taking somebody out of a collection
 * is the half that matters, and a merge cannot express it.
 */
export async function setMemberScope(
    orgId: string,
    memberId: string,
    scope: core.VaultScope
): Promise<boolean> {
    const { count } = await prisma.vaultOrgUser.updateMany({
        where: { id: memberId, orgId },
        data: { accessAll: scope.accessAll }
    });
    if (count === 0) return false;
    await writeScope(orgId, memberId, scope);
    return true;
}

/** The collection rows behind a scope, kept to collections of THIS vault. */
async function writeScope(
    orgId: string,
    memberId: string,
    scope: core.VaultScope
): Promise<void> {
    const wanted = scope.accessAll ? [] : scope.collections;
    const allowed = new Set(
        (
            await prisma.vaultCollection.findMany({
                where: { orgId, id: { in: wanted.map((row) => row.collectionId) } },
                select: { id: true }
            })
        ).map((row) => row.id)
    );
    await prisma.$transaction([
        prisma.vaultCollectionAccess.deleteMany({ where: { orgUserId: memberId } }),
        ...(allowed.size > 0
            ? [
                  prisma.vaultCollectionAccess.createMany({
                      data: wanted
                          .filter((row) => allowed.has(row.collectionId))
                          .map((row) => ({
                              orgUserId: memberId,
                              collectionId: row.collectionId,
                              readOnly: row.readOnly,
                              hidePasswords: row.hidePasswords
                          }))
                  })
              ]
            : [])
    ]);
    const member = await prisma.vaultOrgUser.findUnique({
        where: { id: memberId },
        select: { userId: true }
    });
    await bumpRevision(member?.userId);
}

/** Take somebody out of an organization's vault. Their key stops being valid
 *  for anything new, and the items stay where they are. */
export async function removeMember(orgId: string, memberId: string): Promise<boolean> {
    const member = await prisma.vaultOrgUser.findFirst({
        where: { id: memberId, orgId },
        select: { userId: true }
    });
    if (!member) return false;
    await prisma.vaultOrgUser.delete({ where: { id: memberId } });
    await bumpRevision(member.userId);
    return true;
}

/** Everybody in an organization's vault, as a client lists them. */
export async function listMembers(orgId: string): Promise<Record<string, unknown>[]> {
    const rows = await prisma.vaultOrgUser.findMany({
        where: { orgId },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            userId: true,
            email: true,
            status: true,
            type: true,
            accessAll: true,
            vault: { select: { user: { select: { name: true } } } },
            collections: {
                where: { collection: { orgId } },
                select: { collectionId: true, readOnly: true, hidePasswords: true }
            }
        }
    });
    return rows.map((row) => ({
        object: "organizationUserUserDetails",
        id: row.id,
        userId: row.userId,
        name: row.vault?.user.name ?? null,
        email: row.email,
        status: row.status,
        type: row.type,
        accessAll: row.accessAll,
        twoFactorEnabled: false,
        permissions: {},
        resetPasswordEnrolled: false,
        // What they reach when they do not reach everything. A client draws this
        // beside the member, and an empty list under `accessAll: false` is the
        // honest way to say "nothing yet".
        collections: row.collections.map((access) => ({
            id: access.collectionId,
            readOnly: access.readOnly,
            hidePasswords: access.hidePasswords,
            manage: false
        }))
    }));
}

/** The collections in one organization, for somebody who administers it. */
export async function listOrgCollections(orgId: string): Promise<Record<string, unknown>[]> {
    const rows = await prisma.vaultCollection.findMany({
        where: { orgId },
        select: { id: true, name: true, externalId: true }
    });
    return rows.map((row) => ({
        object: "collection",
        id: row.id,
        organizationId: orgId,
        name: row.name,
        externalId: row.externalId
    }));
}

/** Add a collection. Its name is encrypted under the organization's key. */
export async function createCollection(
    orgId: string,
    name: string,
    externalId?: string | null
): Promise<Record<string, unknown> | null> {
    if (!core.isEncString(name)) return null;
    const row = await prisma.vaultCollection.create({
        data: { orgId, name, externalId: externalId ?? null },
        select: { id: true, name: true, externalId: true }
    });
    return {
        object: "collection",
        id: row.id,
        organizationId: orgId,
        name: row.name,
        externalId: row.externalId
    };
}

export async function updateCollection(
    orgId: string,
    collectionId: string,
    name: string
): Promise<Record<string, unknown> | null> {
    if (!core.isEncString(name)) return null;
    const { count } = await prisma.vaultCollection.updateMany({
        where: { id: collectionId, orgId },
        data: { name }
    });
    if (count === 0) return null;
    return { object: "collection", id: collectionId, organizationId: orgId, name };
}

/**
 * Delete a collection.
 *
 * The items in it are NOT deleted. A collection is how something is shared, not
 * where it lives, and an item that ends up in none is one only an administrator
 * can still reach - which is recoverable, unlike having destroyed it.
 */
export async function deleteCollection(orgId: string, collectionId: string): Promise<boolean> {
    const { count } = await prisma.vaultCollection.deleteMany({
        where: { id: collectionId, orgId }
    });
    return count === 1;
}

/**
 * Who is in one collection, replacing whoever was.
 *
 * The other side of `setMemberScope`, and the one clients use: they send a
 * collection with its whole user list rather than a member with their whole
 * scope. Both write the same rows, and both drop what is not in the list -
 * taking somebody out is the half that matters.
 */
export async function setCollectionMembers(
    orgId: string,
    collectionId: string,
    users: { id: string; readOnly: boolean; hidePasswords: boolean }[]
): Promise<void> {
    const collection = await prisma.vaultCollection.findFirst({
        where: { id: collectionId, orgId },
        select: { id: true }
    });
    if (!collection) return;
    // Only members of THIS vault: an id from another one would grant access
    // across a boundary that nothing else would ever check again.
    const members = await prisma.vaultOrgUser.findMany({
        where: { orgId, id: { in: users.map((user) => user.id) } },
        select: { id: true, userId: true }
    });
    const allowed = new Map(members.map((member) => [member.id, member.userId]));
    await prisma.$transaction([
        prisma.vaultCollectionAccess.deleteMany({ where: { collectionId } }),
        ...(allowed.size > 0
            ? [
                  prisma.vaultCollectionAccess.createMany({
                      data: users
                          .filter((user) => allowed.has(user.id))
                          .map((user) => ({
                              collectionId,
                              orgUserId: user.id,
                              readOnly: user.readOnly,
                              hidePasswords: user.hidePasswords
                          }))
                  })
              ]
            : [])
    ]);
    for (const userId of allowed.values()) await bumpRevision(userId);
}
