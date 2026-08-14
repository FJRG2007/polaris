/**
 * Organization vaults.
 *
 * Polaris already knows who is in an organization and what they may do there.
 * What it has no concept of is the key: an organization's items are encrypted
 * under a key of its own, and being on the roster does not hand it to you -
 * somebody who already holds it has to wrap it to your public key. That step is
 * the whole difference between a permission and access, and it is why this has
 * its own membership rows beside the Polaris ones.
 *
 * Setting one up and confirming a member both happen from the Polaris screens,
 * because both need a browser holding an unlocked vault. Clients read what
 * exists and work inside it; they do not create it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { bumpRevision } from "@/lib/vault/account";

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

/**
 * Give a Polaris organization a vault.
 *
 * The keys are minted in a browser: the organization's own pair, and its
 * symmetric key wrapped to the creator's public key so they can open it again.
 * Nothing here can produce them, which is the point.
 */
export async function createOrganizationVault(input: {
    organizationId: string;
    creatorUserId: string;
    publicKey: string;
    encryptedPrivateKey: string;
    /** The organization key, wrapped to the creator's public key. */
    creatorKey: string;
    /** The first collection's name, encrypted under the organization key. */
    collectionName: string;
    creatorEmail: string;
}): Promise<{ ok: true; id: string } | { ok: false; reason: "exists" | "keys" }> {
    if (
        !core.isEncString(input.encryptedPrivateKey) ||
        !core.isEncString(input.creatorKey) ||
        !core.isEncString(input.collectionName) ||
        input.publicKey.length === 0
    ) {
        return { ok: false, reason: "keys" };
    }
    const existing = await prisma.vaultOrganization.findUnique({
        where: { organizationId: input.organizationId },
        select: { id: true }
    });
    if (existing) return { ok: false, reason: "exists" };

    const created = await prisma.vaultOrganization.create({
        data: {
            organizationId: input.organizationId,
            publicKey: input.publicKey,
            privateKey: input.encryptedPrivateKey,
            members: {
                create: {
                    userId: input.creatorUserId,
                    email: input.creatorEmail,
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
    await recordAudit({
        actorId: input.creatorUserId,
        action: "vault.org.create",
        targetType: "organization",
        targetId: input.organizationId
    });
    await bumpRevision(input.creatorUserId);
    return { ok: true, id: created.id };
}

/** The vault organization behind a Polaris organization, or null. */
export async function vaultOrgFor(organizationId: string) {
    return prisma.vaultOrganization.findUnique({
        where: { organizationId },
        select: { id: true, publicKey: true, privateKey: true }
    });
}

/** Invite somebody by address. They hold no key until they are confirmed. */
export async function inviteMember(
    orgId: string,
    email: string,
    type: number
): Promise<{ ok: boolean }> {
    const address = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: address }, select: { id: true } });
    await prisma.vaultOrgUser.upsert({
        where: { orgId_email: { orgId, email: address } },
        create: {
            orgId,
            email: address,
            userId: user?.id ?? null,
            type,
            status: core.ORG_USER_INVITED
        },
        update: { type }
    });
    return { ok: true };
}

/**
 * Hand the organization's key to a member.
 *
 * The wrapped key is produced by an administrator's browser, to that member's
 * public key. Until this runs the member is on the list and can decrypt nothing,
 * which is the correct state for somebody who has been invited but not vouched
 * for.
 */
export async function confirmMember(
    orgId: string,
    memberId: string,
    wrappedKey: string
): Promise<boolean> {
    if (!core.isEncString(wrappedKey)) return false;
    const { count } = await prisma.vaultOrgUser.updateMany({
        where: { id: memberId, orgId },
        data: { key: wrappedKey, status: core.ORG_USER_CONFIRMED }
    });
    if (count === 0) return false;
    const member = await prisma.vaultOrgUser.findUnique({
        where: { id: memberId },
        select: { userId: true }
    });
    await bumpRevision(member?.userId);
    return true;
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
            vault: { select: { user: { select: { name: true } } } }
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
        collections: []
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

/** Put a member in a collection, or change what they may do in it. */
export async function setCollectionAccess(
    collectionId: string,
    orgUserId: string,
    access: { readOnly: boolean; hidePasswords: boolean }
): Promise<void> {
    await prisma.vaultCollectionAccess.upsert({
        where: { collectionId_orgUserId: { collectionId, orgUserId } },
        create: { collectionId, orgUserId, ...access },
        update: access
    });
    const member = await prisma.vaultOrgUser.findUnique({
        where: { id: orgUserId },
        select: { userId: true }
    });
    await bumpRevision(member?.userId);
}
