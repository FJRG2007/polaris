/**
 * The one response a Bitwarden client asks for on every start: everything it is
 * allowed to see, in one document.
 *
 * It is assembled rather than stored, and it is verbose on purpose. Clients read
 * these objects field by field and treat a missing field as a feature that is
 * off, so a lean response does not read as "a small vault" - it reads as a
 * server where attachments, TOTP and organizations do not work. Every flag here
 * that looks like billing is a flag that gates a feature in the client.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { listSends } from "@/lib/vault/sends";
import { listCiphers } from "@/lib/vault/ciphers";
import { listFolders } from "@/lib/vault/folders";

/** The organizations one account is a confirmed or pending member of. */
export async function membershipsFor(userId: string) {
    return prisma.vaultOrgUser.findMany({
        where: { userId, status: { not: core.ORG_USER_REVOKED } },
        select: {
            id: true,
            status: true,
            type: true,
            key: true,
            accessAll: true,
            organization: {
                select: {
                    id: true,
                    publicKey: true,
                    organization: { select: { name: true, slug: true } }
                }
            }
        }
    });
}

type Membership = Awaited<ReturnType<typeof membershipsFor>>[number];

/**
 * One organization as a client reads it off the profile.
 *
 * The `use*` flags say what the client may offer. Self-hosted Polaris has no
 * tiers, so the ones that describe a paid feature are on; the ones that describe
 * something Polaris genuinely does not have - single sign-on into the vault,
 * directory sync, a key connector - are off, because a client that offers them
 * leads somebody to a screen that cannot work.
 */
function toProfileOrganization(membership: Membership): Record<string, unknown> {
    return {
        object: "profileOrganization",
        id: membership.organization.id,
        name: membership.organization.organization.name,
        identifier: membership.organization.organization.slug,
        key: membership.key,
        status: membership.status,
        type: membership.type,
        enabled: true,
        usePolicies: true,
        useGroups: true,
        useDirectory: false,
        useEvents: true,
        useTotp: true,
        use2fa: true,
        useApi: true,
        useSso: false,
        useKeyConnector: false,
        useScim: false,
        useResetPassword: false,
        useSecretsManager: false,
        usePasswordManager: true,
        useCustomPermissions: true,
        usersGetPremium: true,
        selfHost: true,
        seats: null,
        maxCollections: null,
        maxStorageGb: null,
        hasPublicAndPrivateKeys: membership.organization.publicKey.length > 0,
        ssoBound: false,
        permissions: {},
        resetPasswordEnrolled: false,
        userId: null,
        organizationUserId: membership.id,
        providerId: null,
        providerName: null,
        productTierType: 2,
        keyConnectorEnabled: false,
        keyConnectorUrl: null,
        accessSecretsManager: false,
        limitCollectionCreationDeletion: false,
        allowAdminAccessToAllCollectionItems: true,
        familySponsorshipFriendlyName: null,
        familySponsorshipAvailable: false,
        familySponsorshipLastSyncDate: null,
        familySponsorshipValidUntil: null,
        familySponsorshipToDelete: null
    };
}

/** The account's own record, as clients read it. */
export async function profileFor(userId: string): Promise<Record<string, unknown> | null> {
    const [account, memberships] = await Promise.all([
        prisma.vaultAccount.findUnique({
            where: { userId },
            select: {
                masterPasswordHint: true,
                protectedKey: true,
                privateKey: true,
                securityStamp: true,
                user: {
                    select: { name: true, email: true, emailVerified: true, twoFactorEnabled: true }
                }
            }
        }),
        membershipsFor(userId)
    ]);
    if (!account) return null;

    return {
        object: "profile",
        id: userId,
        name: account.user.name,
        email: account.user.email,
        emailVerified: account.user.emailVerified,
        // No tiers on a self-hosted deployment. A client told otherwise hides
        // attachments and TOTP, which work here.
        premium: true,
        premiumFromOrganization: false,
        masterPasswordHint: account.masterPasswordHint,
        culture: "en-US",
        twoFactorEnabled: account.user.twoFactorEnabled,
        key: account.protectedKey,
        privateKey: account.privateKey,
        securityStamp: account.securityStamp,
        forcePasswordReset: false,
        usesKeyConnector: false,
        avatarColor: null,
        creationDate: null,
        verifyDevices: false,
        organizations: memberships.map(toProfileOrganization),
        providers: [],
        providerOrganizations: []
    };
}

/** The collections this account reaches, in the shape clients read. */
export async function collectionsFor(userId: string): Promise<Record<string, unknown>[]> {
    const memberships = await prisma.vaultOrgUser.findMany({
        where: { userId, status: core.ORG_USER_CONFIRMED },
        select: { id: true, orgId: true, accessAll: true }
    });
    if (memberships.length === 0) return [];

    const allAccess = memberships.filter((row) => row.accessAll).map((row) => row.orgId);
    const memberIds = memberships.map((row) => row.id);
    const rows = await prisma.vaultCollection.findMany({
        where: {
            OR: [
                ...(allAccess.length > 0 ? [{ orgId: { in: allAccess } }] : []),
                { members: { some: { orgUserId: { in: memberIds } } } }
            ]
        },
        select: {
            id: true,
            orgId: true,
            name: true,
            externalId: true,
            members: {
                where: { orgUserId: { in: memberIds } },
                select: { readOnly: true, hidePasswords: true }
            }
        }
    });
    return rows.map((row) => ({
        object: "collectionDetails",
        id: row.id,
        organizationId: row.orgId,
        name: row.name,
        externalId: row.externalId,
        // A member reaching a collection through accessAll has no row of their
        // own on it, and reaches it in full.
        readOnly: row.members[0]?.readOnly ?? false,
        hidePasswords: row.members[0]?.hidePasswords ?? false,
        manage: false
    }));
}

/**
 * The domains a client treats as one site when it matches a saved login.
 *
 * Bitwarden ships a list so that a password saved on one of a company's domains
 * is offered on the others. Polaris does not curate one: `global` is what the
 * client falls back to, and `equivalentDomains` is where an account's own
 * additions would go. Both are answered rather than omitted, because a client
 * that gets nothing here logs an error on every sync.
 */
export function domainsResponse(): Record<string, unknown> {
    return { object: "domains", equivalentDomains: null, globalEquivalentDomains: [] };
}

/** Everything a client pulls on a sync. */
export async function syncResponse(userId: string): Promise<Record<string, unknown> | null> {
    const profile = await profileFor(userId);
    if (!profile) return null;
    const [folders, collections, ciphers, sends] = await Promise.all([
        listFolders(userId),
        collectionsFor(userId),
        listCiphers(userId),
        listSends(userId)
    ]);
    return {
        object: "sync",
        profile,
        folders,
        collections,
        ciphers,
        // Policies are an enterprise feature Polaris does not implement; an empty
        // list is the honest answer and the one clients handle.
        policies: [],
        domains: domainsResponse(),
        sends,
        unofficialServer: true
    };
}
