"use server";

/**
 * Vaults beyond your own, and who is in them.
 *
 * A folder is how one person tidies their own items and its name is encrypted
 * under their own key. A COLLECTION is how items are shared: it belongs to a
 * vault, its contents are encrypted under that vault's key, and holding that key
 * is the whole of access. Being on the Polaris roster is not enough and cannot
 * be made enough - somebody who already holds the key has to wrap it to your
 * public key first.
 *
 * That is why every mint and every wrap in here happens in a browser and only
 * the result arrives. Two separate questions are asked on the way through:
 *
 *  - May this account administer this vault? For an organization's, that is the
 *    Polaris permission `vault.manage`; for somebody's own, it is owning it or
 *    having been made an administrator of it. It gates who may create the vault,
 *    make collections, and vouch for people.
 *  - Is this account a CONFIRMED member holding the key? That gates what it can
 *    actually read, and no permission grants it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import * as vaultOrgs from "@/lib/vault/orgs";
import * as ciphers from "@/lib/vault/ciphers";
import { requirePermission } from "@/lib/session";
import * as vaultAccount from "@/lib/vault/account";
import { listMyOrgs, resolveOrgAccess, orgCan } from "@/lib/orgs/org-service";

/** One vault, as the vault screens need to see it. */
export interface VaultView {
    /** The vault itself, or null for an organization that has no vault yet. */
    vaultId: string | null;
    /** The Polaris organization it belongs to, or null when it is one person's. */
    organizationId: string | null;
    name: string;
    /** True when this account owns it outright, rather than being let into it. */
    mine: boolean;
    /** Whether this account may run the vault's shape - not read it. */
    mayAdminister: boolean;
    /** The vault's key, wrapped to this account's public key. */
    wrappedKey: string | null;
    /** True once somebody vouched for this account and it holds the key. */
    confirmed: boolean;
    /** The vault's public key, for wrapping something to it. */
    publicKey: string | null;
    /** The membership row's id, which is what collections grant access to. */
    memberId: string | null;
    /**
     * True for the one vault every account already has - the one its items land
     * in by default. It is a VaultAccount rather than a VaultOrganization, so it
     * has folders instead of collections and nobody to invite, and the screen
     * draws it differently. Listed all the same: a screen headed "Vaults" that
     * leaves out the vault you actually use reads as though you have none.
     */
    account: boolean;
}

/**
 * Every vault this account can see, and where it stands in each.
 *
 * Batched rather than looped: this runs on every unlock and after every change,
 * and asking three questions per vault in turn made opening the vault cost a
 * round trip per row.
 *
 * An organization on the roster with no vault yet is listed too, with a null id.
 * That entry is what the screen offers to create one through, and leaving it out
 * would hide the only way in.
 */
export async function vaultListAction(): Promise<VaultView[]> {
    const user = await requirePermission("vault.use");
    const orgs = await listMyOrgs(user.id);
    const [rows, accesses] = await Promise.all([
        vaultOrgs.vaultsReachableBy(
            user.id,
            orgs.map((org) => org.id)
        ),
        // Not one query: resolving what somebody may do in an organization runs
        // through the role rules rather than a column. Concurrent is what is
        // available here, and it is the difference that was being paid for.
        Promise.all(
            orgs.map((org) => resolveOrgAccess({ id: user.id, isAdmin: user.isAdmin }, org.id))
        )
    ]);
    const mayManage = new Map(
        orgs.map((org, index) => [org.id, orgCan(accesses[index] ?? null, "vault.manage")])
    );

    const views: VaultView[] = rows.map((row) => {
        const membership = row.members[0] ?? null;
        const standing = membership
            ? {
                  memberId: membership.id,
                  type: membership.type,
                  accessAll: membership.accessAll,
                  confirmed: membership.status === core.ORG_USER_CONFIRMED
              }
            : null;
        return {
            vaultId: row.id,
            organizationId: row.organizationId,
            name: row.organization?.name ?? row.name ?? "Vault",
            mine: row.ownerUserId === user.id,
            mayAdminister: row.organizationId
                ? (mayManage.get(row.organizationId) ?? false)
                : row.ownerUserId === user.id || vaultOrgs.mayAdminister(standing),
            wrappedKey: membership?.key ?? null,
            confirmed: standing?.confirmed === true,
            publicKey: row.publicKey,
            memberId: membership?.id ?? null,
            account: false
        };
    });

    const covered = new Set(views.map((view) => view.organizationId).filter(Boolean));
    for (const org of orgs) {
        if (covered.has(org.id)) continue;
        views.push({
            vaultId: null,
            organizationId: org.id,
            name: org.name,
            mine: false,
            mayAdminister: mayManage.get(org.id) ?? false,
            wrappedKey: null,
            confirmed: false,
            publicKey: null,
            memberId: null,
            account: false
        });
    }

    // First, and first for a reason: it is the one the reader has, and every
    // item they have not deliberately moved is in it.
    const own = await vaultAccount.getVault(user.id);
    if (own) {
        views.unshift({
            vaultId: null,
            organizationId: null,
            name: "My own vault",
            mine: true,
            mayAdminister: false,
            wrappedKey: null,
            confirmed: true,
            publicKey: own.publicKey,
            memberId: null,
            account: true
        });
    }
    return views;
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

/** Give this account a second vault of its own, from keys a browser minted. */
export async function createPersonalVaultAction(
    input: unknown
): Promise<{ vaultId?: string; error?: string }> {
    const user = await requirePermission("vault.use");
    const parsed = core.personalVaultSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Those keys are not usable." };
    }
    const result = await vaultOrgs.createPersonalVault({
        name: parsed.data.name,
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
                result.reason === "too_many"
                    ? `You can keep ${core.MAX_OWNED_VAULTS} vaults of your own. Delete one first.`
                    : "Those keys are not encrypted values."
        };
    }
    revalidatePath("/vault", "layout");
    return { vaultId: result.id };
}

/**
 * The one gate for everything below: this account administers that vault.
 *
 * The same refusal whether the vault is somebody else's or does not exist. A
 * different message for each would answer "is there a vault with this id" to
 * anybody who asks.
 */
async function administered(
    vaultId: string
): Promise<{ ok: true; vaultId: string; userId: string } | { ok: false; error: string }> {
    const user = await requirePermission("vault.use");
    const refused = { ok: false, error: "You cannot administer that vault." } as const;
    const vault = await vaultOrgs.vaultById(vaultId);
    if (!vault) return refused;

    if (vault.organizationId) {
        const access = await resolveOrgAccess(
            { id: user.id, isAdmin: user.isAdmin },
            vault.organizationId
        );
        return orgCan(access, "vault.manage")
            ? { ok: true, vaultId: vault.id, userId: user.id }
            : refused;
    }
    if (vault.ownerUserId === user.id) return { ok: true, vaultId: vault.id, userId: user.id };
    const standing = await vaultOrgs.standingIn(user.id, vault.id);
    return vaultOrgs.mayAdminister(standing)
        ? { ok: true, vaultId: vault.id, userId: user.id }
        : refused;
}

/** Rename a vault of somebody's own. */
export async function renameVaultAction(
    vaultId: string,
    name: unknown
): Promise<{ error?: string }> {
    const gate = await administered(vaultId);
    if (!gate.ok) return { error: gate.error };
    const parsed = core.vaultNameField.safeParse(name);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Give it a name." };
    if (!(await vaultOrgs.renameVault(vaultId, parsed.data))) {
        return { error: "An organization's vault is named after the organization." };
    }
    revalidatePath("/vault", "layout");
    return {};
}

/**
 * Delete a vault and everything in it.
 *
 * Only its owner, and only a vault of somebody's own: an organization's outlives
 * whoever set it up, and deleting it is the organization's decision rather than
 * one administrator's.
 */
export async function deleteVaultAction(vaultId: string): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    const vault = await vaultOrgs.vaultById(vaultId);
    if (!vault || vault.ownerUserId !== user.id) {
        return { error: "That is not a vault of yours to delete." };
    }
    await vaultOrgs.deleteVault(vaultId);
    revalidatePath("/vault", "layout");
    return {};
}

/**
 * Take yourself out of a vault somebody let you into.
 *
 * The other half of being added without being asked: an invitation reaches an
 * account whether or not it wanted one, so leaving has to be reachable without
 * asking whoever added you. It stops nothing arriving that already arrived - the
 * items synced so far are still on that device.
 */
export async function leaveVaultAction(vaultId: string): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    const vault = await vaultOrgs.vaultById(vaultId);
    if (!vault) return { error: "That vault does not exist." };
    if (vault.ownerUserId === user.id) {
        return { error: "You own this vault. Delete it instead of leaving it." };
    }
    const standing = await vaultOrgs.standingIn(user.id, vaultId);
    if (!standing) return { error: "You are not in that vault." };
    await vaultOrgs.removeMember(vaultId, standing.memberId);
    revalidatePath("/vault", "layout");
    return {};
}

/** Who is in a vault, and who could be added without further ado. */
export async function vaultMembersAction(vaultId: string): Promise<{
    members?: Record<string, unknown>[];
    /** People on the organization's roster who are not in its vault yet. */
    candidates?: { userId: string; name: string; email: string; hasVault: boolean }[];
    error?: string;
}> {
    const gate = await administered(vaultId);
    if (!gate.ok) return { error: gate.error };

    const members = await vaultOrgs.listMembers(gate.vaultId);
    const vault = await vaultOrgs.vaultById(vaultId);
    // A vault of somebody's own has no roster to suggest from - it is shared with
    // whoever its owner names - so the screen asks for an address instead.
    if (!vault?.organizationId) return { members, candidates: [] };

    const invited = new Set(members.map((row) => String(row.email ?? "").toLowerCase()));
    const roster = await prisma.organization.findUnique({
        where: { id: vault.organizationId },
        select: {
            owner: { select: { id: true, name: true, email: true } },
            members: { select: { user: { select: { id: true, name: true, email: true } } } }
        }
    });
    const people = [
        ...(roster?.owner ? [roster.owner] : []),
        ...(roster?.members ?? []).map((row) => row.user)
    ];
    // Somebody with no vault of their own has no public key to wrap the vault's
    // key to, so they can be invited but never confirmed. Saying which is which
    // up front beats an invite that silently cannot complete.
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
    vaultId: string,
    email: unknown,
    type: number
): Promise<{ error?: string }> {
    const gate = await administered(vaultId);
    if (!gate.ok) return { error: gate.error };
    const parsed = core.emailField.safeParse(email);
    if (!parsed.success) return { error: "Enter a valid email address." };
    const roles = [
        core.ORG_ROLE_OWNER,
        core.ORG_ROLE_ADMIN,
        core.ORG_ROLE_MANAGER,
        core.ORG_ROLE_USER
    ];
    await vaultOrgs.inviteMember(
        gate.vaultId,
        parsed.data,
        roles.includes(type) ? type : core.ORG_ROLE_USER
    );
    revalidatePath("/vault/vaults");
    return {};
}

/**
 * Somebody's public key, so an administrator's browser can wrap the vault's key
 * to them.
 *
 * Public by nature, but only to somebody who already administers the vault they
 * are being let into - and the same answer whether they have no account or no
 * vault, so this cannot be used to ask whether an address is registered.
 */
export async function memberPublicKeyAction(
    vaultId: string,
    memberId: string
): Promise<{ publicKey?: string; error?: string }> {
    const gate = await administered(vaultId);
    if (!gate.ok) return { error: gate.error };
    const member = await prisma.vaultOrgUser.findFirst({
        where: { id: memberId, orgId: gate.vaultId },
        select: { userId: true }
    });
    const account = member?.userId
        ? await prisma.vaultAccount.findUnique({
              where: { userId: member.userId },
              select: { publicKey: true }
          })
        : null;
    if (!account?.publicKey) {
        return { error: "They have not set up a vault of their own yet, so there is no key to wrap this to." };
    }
    return { publicKey: account.publicKey };
}

/** Hand the vault's key to a member, wrapped to them by a browser, and say how
 *  much of the vault they reach. */
export async function confirmVaultMemberAction(
    vaultId: string,
    memberId: string,
    wrappedKey: string,
    scope: unknown
): Promise<{ error?: string }> {
    const gate = await administered(vaultId);
    if (!gate.ok) return { error: gate.error };
    const parsed = core.vaultScopeSchema.safeParse(scope);
    if (!parsed.success) return { error: "Say what they should reach." };
    // Handing the key over while granting nothing is strictly worse than not
    // handing it over: they hold it and see an empty vault.
    if (!parsed.data.accessAll && parsed.data.collections.length === 0) {
        return { error: "Pick the whole vault or at least one collection." };
    }
    if (!(await vaultOrgs.confirmMember(gate.vaultId, memberId, wrappedKey, parsed.data))) {
        return { error: "That member could not be confirmed." };
    }
    revalidatePath("/vault/vaults");
    return {};
}

/** Change what a member reaches: the whole vault, or named collections. */
export async function setMemberScopeAction(
    vaultId: string,
    memberId: string,
    scope: unknown
): Promise<{ error?: string }> {
    const gate = await administered(vaultId);
    if (!gate.ok) return { error: gate.error };
    const parsed = core.vaultScopeSchema.safeParse(scope);
    if (!parsed.success) return { error: "Say what they should reach." };
    if (!(await vaultOrgs.setMemberScope(gate.vaultId, memberId, parsed.data))) {
        return { error: "That member is not in this vault." };
    }
    revalidatePath("/vault/vaults");
    return {};
}

export async function removeVaultMemberAction(
    vaultId: string,
    memberId: string
): Promise<{ error?: string }> {
    const gate = await administered(vaultId);
    if (!gate.ok) return { error: gate.error };
    if (!(await vaultOrgs.removeMember(gate.vaultId, memberId))) {
        return { error: "That member is not in this vault." };
    }
    revalidatePath("/vault/vaults");
    return {};
}

/** The collections of a vault, still encrypted. */
export async function vaultCollectionsAction(
    vaultId: string
): Promise<{ collections?: Record<string, unknown>[]; error?: string }> {
    const user = await requirePermission("vault.use");
    // Reading the list is for anybody who holds the key, not only for whoever
    // administers the vault: it is how a member picks where to file.
    const standing = await vaultOrgs.standingIn(user.id, vaultId);
    if (!standing?.confirmed) {
        const gate = await administered(vaultId);
        if (!gate.ok) return { error: "You are not in that vault." };
    }
    return { collections: await vaultOrgs.listOrgCollections(vaultId) };
}

/** Make or rename a collection. The name is encrypted under the vault's key. */
export async function saveVaultCollectionAction(
    vaultId: string,
    collectionId: string | null,
    name: string
): Promise<{ collection?: Record<string, unknown>; error?: string }> {
    const gate = await administered(vaultId);
    if (!gate.ok) return { error: gate.error };
    if (!core.isEncString(name)) return { error: "A collection name must be encrypted." };
    const collection = collectionId
        ? await vaultOrgs.updateCollection(gate.vaultId, collectionId, name)
        : await vaultOrgs.createCollection(gate.vaultId, name);
    if (!collection) return { error: "That collection is not in this vault." };
    revalidatePath("/vault/vaults");
    return { collection };
}

export async function deleteVaultCollectionAction(
    vaultId: string,
    collectionId: string
): Promise<{ error?: string }> {
    const gate = await administered(vaultId);
    if (!gate.ok) return { error: gate.error };
    if (!(await vaultOrgs.deleteCollection(gate.vaultId, collectionId))) {
        return { error: "That collection is not in this vault." };
    }
    revalidatePath("/vault/vaults");
    return {};
}

/**
 * Move an item into a vault, into a different one, or back to being personal.
 *
 * The browser re-encrypted it under the key of wherever it is going before
 * calling, which is why the whole item arrives again: this is not a change of
 * owner on a row, it is different ciphertext replacing the old. Whoever already
 * synced it keeps their copy - a key cannot be un-given - so this decides where
 * it is kept from now on, not where it has been.
 */
export async function moveItemAction(
    itemId: string,
    input: unknown,
    collectionIds: string[]
): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    const parsed = core.cipherSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "That item is not encrypted." };
    }
    if (parsed.data.organizationId && collectionIds.length === 0) {
        return { error: "Pick a collection to move it into." };
    }
    const result = await ciphers.moveCipher(user.id, itemId, parsed.data, collectionIds);
    if (!result.ok) return { error: "That item could not be moved there." };
    revalidatePath("/vault");
    return {};
}
