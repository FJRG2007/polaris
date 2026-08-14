"use server";

/**
 * Sharing a vault, which is a different act from arranging one.
 *
 * A folder is how one person tidies their own items and its name is encrypted
 * under their own key. A COLLECTION is how items are shared: it belongs to an
 * organization, its contents are encrypted under that organization's key, and
 * holding that key is the whole of access. Being on the Polaris roster is not
 * enough and cannot be made enough - somebody who already holds the key has to
 * wrap it to your public key first.
 *
 * That is why every mint and every wrap in here happens in a browser and only
 * the result arrives. Two separate questions are asked on the way through:
 *
 *  - Polaris side: may this account administer this organization at all
 *    (`vault.manage`)? That gates who may create the vault, make collections,
 *    and vouch for people.
 *  - Vault side: is this account a CONFIRMED member holding the key? That gates
 *    what it can actually read, and no permission grants it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import * as vaultOrgs from "@/lib/vault/orgs";
import * as ciphers from "@/lib/vault/ciphers";
import { requirePermission } from "@/lib/session";
import { listMyOrgs, resolveOrgAccess, orgCan } from "@/lib/orgs/org-service";

/** One organization, as the vault screens need to see it. */
export interface VaultOrgView {
    /** The Polaris organization. */
    organizationId: string;
    name: string;
    slug: string;
    /** The vault organization's id, or null when it has no vault yet. */
    vaultOrgId: string | null;
    /** Whether this account may run the vault's shape - not read it. */
    mayAdminister: boolean;
    /** The organization's key, wrapped to this account's public key. */
    wrappedKey: string | null;
    /** True once somebody vouched for this account and it holds the key. */
    confirmed: boolean;
    /** The organization's public key, for wrapping something to it. */
    publicKey: string | null;
    /** The membership row's id, which is what collections grant access to. */
    memberId: string | null;
}

/**
 * Every organization this account is in, and where it stands in each vault.
 *
 * Batched rather than looped: this runs on every unlock and after every change
 * to an organization, and asking three questions per organization in turn made
 * opening the vault cost a round trip per row on the roster.
 */
export async function vaultOrganizationsAction(): Promise<VaultOrgView[]> {
    const user = await requirePermission("vault.use");
    const orgs = await listMyOrgs(user.id);
    if (orgs.length === 0) return [];

    const vaults = await vaultOrgs.vaultOrgsFor(orgs.map((org) => org.id));
    const [memberships, accesses] = await Promise.all([
        vaultOrgs.membershipsFor(
            user.id,
            [...vaults.values()].map((vault) => vault.id)
        ),
        // Not one query: resolving what somebody may do in an organization runs
        // through the role rules rather than a column. Concurrent is what is
        // available here, and it is the difference that was being paid for.
        Promise.all(
            orgs.map((org) => resolveOrgAccess({ id: user.id, isAdmin: user.isAdmin }, org.id))
        )
    ]);

    return orgs.map((org, index) => {
        const vault = vaults.get(org.id) ?? null;
        const membership = vault ? (memberships.get(vault.id) ?? null) : null;
        return {
            organizationId: org.id,
            name: org.name,
            slug: org.slug,
            vaultOrgId: vault?.id ?? null,
            mayAdminister: orgCan(accesses[index] ?? null, "vault.manage"),
            wrappedKey: membership?.key ?? null,
            confirmed: membership?.status === core.ORG_USER_CONFIRMED,
            publicKey: vault?.publicKey ?? null,
            memberId: membership?.id ?? null
        };
    });
}

/** Give a Polaris organization a vault, from keys a browser just minted. */
export async function createOrganizationVaultAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    const parsed = core.vaultOrganizationSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Those keys are not usable." };
    }
    const access = await resolveOrgAccess(
        { id: user.id, isAdmin: user.isAdmin },
        parsed.data.organizationId
    );
    if (!orgCan(access, "vault.manage")) {
        return { error: "You cannot set up a vault for that organization." };
    }
    const result = await vaultOrgs.createOrganizationVault({
        organizationId: parsed.data.organizationId,
        creatorUserId: user.id,
        creatorEmail: user.email,
        publicKey: parsed.data.keys.publicKey,
        encryptedPrivateKey: parsed.data.keys.encryptedPrivateKey,
        creatorKey: parsed.data.key,
        collectionName: parsed.data.collectionName
    });
    if (!result.ok) {
        return {
            error:
                result.reason === "exists"
                    ? "That organization already has a vault."
                    : "Those keys are not encrypted values."
        };
    }
    revalidatePath("/vault", "layout");
    return {};
}

/**
 * The one gate for everything below: this account administers that
 * organization's vault, and the vault exists.
 */
async function administered(
    organizationId: string
): Promise<{ ok: true; vaultOrgId: string } | { ok: false; error: string }> {
    const user = await requirePermission("vault.use");
    const access = await resolveOrgAccess({ id: user.id, isAdmin: user.isAdmin }, organizationId);
    if (!orgCan(access, "vault.manage")) {
        return { ok: false, error: "You cannot administer that organization's vault." };
    }
    const vault = await vaultOrgs.vaultOrgFor(organizationId);
    if (!vault) return { ok: false, error: "That organization has no vault yet." };
    return { ok: true, vaultOrgId: vault.id };
}

/** Who is in an organization's vault, and who on its roster is not yet. */
export async function vaultOrgMembersAction(organizationId: string): Promise<{
    members?: Record<string, unknown>[];
    /** Roster entries with a vault of their own who could be invited. */
    candidates?: { userId: string; name: string; email: string; hasVault: boolean }[];
    error?: string;
}> {
    const gate = await administered(organizationId);
    if (!gate.ok) return { error: gate.error };

    const members = await vaultOrgs.listMembers(gate.vaultOrgId);
    const invited = new Set(members.map((row) => String(row.email ?? "").toLowerCase()));
    const roster = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: {
            owner: { select: { id: true, name: true, email: true } },
            members: { select: { user: { select: { id: true, name: true, email: true } } } }
        }
    });
    const people = [
        ...(roster?.owner ? [roster.owner] : []),
        ...(roster?.members ?? []).map((row) => row.user)
    ];
    // Somebody with no vault of their own has no public key to wrap the
    // organization's key to, so they can be invited but never confirmed. Saying
    // which is which up front beats an invite that silently cannot complete.
    const withVaults = await prisma.vaultAccount.findMany({
        where: { userId: { in: people.map((person) => person.id) } },
        select: { userId: true, publicKey: true }
    });
    const keyed = new Set(withVaults.filter((row) => row.publicKey).map((row) => row.userId));
    return {
        members,
        candidates: people
            .filter((person) => !invited.has(person.email.toLowerCase()))
            .map((person) => ({
                userId: person.id,
                name: person.name,
                email: person.email,
                hasVault: keyed.has(person.id)
            }))
    };
}

/** Put somebody on the list. They hold no key until they are confirmed. */
export async function inviteVaultMemberAction(
    organizationId: string,
    email: string,
    type: number
): Promise<{ error?: string }> {
    const gate = await administered(organizationId);
    if (!gate.ok) return { error: gate.error };
    const role = core.ORG_ROLE_USER;
    await vaultOrgs.inviteMember(
        gate.vaultOrgId,
        email,
        [
            core.ORG_ROLE_OWNER,
            core.ORG_ROLE_ADMIN,
            core.ORG_ROLE_MANAGER,
            core.ORG_ROLE_USER
        ].includes(type)
            ? type
            : role
    );
    revalidatePath("/vault/shared");
    return {};
}

/** Somebody's public key, so an administrator's browser can wrap the
 *  organization's key to them. Public by nature, but only to somebody who
 *  already administers the vault they are being let into. */
export async function memberPublicKeyAction(
    organizationId: string,
    memberId: string
): Promise<{ publicKey?: string; error?: string }> {
    const gate = await administered(organizationId);
    if (!gate.ok) return { error: gate.error };
    const member = await prisma.vaultOrgUser.findFirst({
        where: { id: memberId, orgId: gate.vaultOrgId },
        select: { userId: true }
    });
    if (!member?.userId) return { error: "That person has no Polaris account yet." };
    const account = await prisma.vaultAccount.findUnique({
        where: { userId: member.userId },
        select: { publicKey: true }
    });
    if (!account?.publicKey) return { error: "That person has not set their own vault up yet." };
    return { publicKey: account.publicKey };
}

/** Hand the organization's key to a member, wrapped to them by a browser. */
export async function confirmVaultMemberAction(
    organizationId: string,
    memberId: string,
    wrappedKey: string
): Promise<{ error?: string }> {
    const gate = await administered(organizationId);
    if (!gate.ok) return { error: gate.error };
    if (!(await vaultOrgs.confirmMember(gate.vaultOrgId, memberId, wrappedKey))) {
        return { error: "That member could not be confirmed." };
    }
    revalidatePath("/vault/shared");
    return {};
}

export async function removeVaultMemberAction(
    organizationId: string,
    memberId: string
): Promise<{ error?: string }> {
    const gate = await administered(organizationId);
    if (!gate.ok) return { error: gate.error };
    if (!(await vaultOrgs.removeMember(gate.vaultOrgId, memberId))) {
        return { error: "That member is not in this vault." };
    }
    revalidatePath("/vault/shared");
    return {};
}

/** The collections of an organization's vault, still encrypted. */
export async function vaultCollectionsAction(
    organizationId: string
): Promise<{ collections?: Record<string, unknown>[]; error?: string }> {
    const user = await requirePermission("vault.use");
    const vault = await vaultOrgs.vaultOrgFor(organizationId);
    if (!vault) return { collections: [] };
    // Reading the list is for anybody who holds the key, not only for whoever
    // administers the organization: it is how a member picks where to file.
    const standing = await vaultOrgs.standingIn(user.id, vault.id);
    const access = await resolveOrgAccess({ id: user.id, isAdmin: user.isAdmin }, organizationId);
    if (!standing?.confirmed && !orgCan(access, "vault.manage")) {
        return { error: "You are not in that organization's vault." };
    }
    return { collections: await vaultOrgs.listOrgCollections(vault.id) };
}

/** Make or rename a collection. The name is encrypted under the organization's key. */
export async function saveVaultCollectionAction(
    organizationId: string,
    collectionId: string | null,
    name: string
): Promise<{ collection?: Record<string, unknown>; error?: string }> {
    const gate = await administered(organizationId);
    if (!gate.ok) return { error: gate.error };
    if (!core.isEncString(name)) return { error: "A collection name must be encrypted." };
    const collection = collectionId
        ? await vaultOrgs.updateCollection(gate.vaultOrgId, collectionId, name)
        : await vaultOrgs.createCollection(gate.vaultOrgId, name);
    if (!collection) return { error: "That collection is not in this vault." };
    revalidatePath("/vault/shared");
    return { collection };
}

export async function deleteVaultCollectionAction(
    organizationId: string,
    collectionId: string
): Promise<{ error?: string }> {
    const gate = await administered(organizationId);
    if (!gate.ok) return { error: gate.error };
    if (!(await vaultOrgs.deleteCollection(gate.vaultOrgId, collectionId))) {
        return { error: "That collection is not in this vault." };
    }
    revalidatePath("/vault/shared");
    return {};
}

/** Put a member in a collection, or change what they may do in it. */
export async function setCollectionAccessAction(
    organizationId: string,
    collectionId: string,
    memberId: string,
    access: { readOnly: boolean; hidePasswords: boolean }
): Promise<{ error?: string }> {
    const gate = await administered(organizationId);
    if (!gate.ok) return { error: gate.error };
    // Both ids have to belong to THIS vault, or an administrator of one
    // organization could grant access inside another.
    const [collection, member] = await Promise.all([
        prisma.vaultCollection.findFirst({
            where: { id: collectionId, orgId: gate.vaultOrgId },
            select: { id: true }
        }),
        prisma.vaultOrgUser.findFirst({
            where: { id: memberId, orgId: gate.vaultOrgId },
            select: { id: true }
        })
    ]);
    if (!collection || !member) return { error: "That is not in this vault." };
    await vaultOrgs.setCollectionAccess(collectionId, memberId, access);
    revalidatePath("/vault/shared");
    return {};
}

/** Who reaches one collection, so the screen can say so rather than imply it. */
export async function collectionAccessAction(
    organizationId: string,
    collectionId: string
): Promise<{
    access?: { memberId: string; readOnly: boolean; hidePasswords: boolean }[];
    error?: string;
}> {
    const gate = await administered(organizationId);
    if (!gate.ok) return { error: gate.error };
    const rows = await prisma.vaultCollectionAccess.findMany({
        where: { collectionId, collection: { orgId: gate.vaultOrgId } },
        select: { orgUserId: true, readOnly: true, hidePasswords: true }
    });
    return {
        access: rows.map((row) => ({
            memberId: row.orgUserId,
            readOnly: row.readOnly,
            hidePasswords: row.hidePasswords
        }))
    };
}

/**
 * Hand a personal item to an organization.
 *
 * The browser re-encrypted it under the organization's key before calling, which
 * is why the whole item arrives again: this is not a change of owner on a row,
 * it is different ciphertext replacing the old. It is one-way on purpose -
 * taking it back would mean re-encrypting it under a personal key while other
 * members still have it.
 */
export async function shareItemAction(
    itemId: string,
    input: unknown,
    collectionIds: string[]
): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    const parsed = core.cipherSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "That item is not encrypted." };
    }
    if (collectionIds.length === 0) return { error: "Pick a collection to share it into." };
    const result = await ciphers.shareCipher(user.id, itemId, parsed.data, collectionIds);
    if (!result.ok) {
        return { error: "That item could not be shared into that collection." };
    }
    revalidatePath("/vault");
    return {};
}
