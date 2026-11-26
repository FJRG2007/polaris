/**
 * Which organisation recovery key (`ORK`, docs/chat-e2ee-mls.md "Recovery")
 * an account's history falls back to, for the legacy migration. Kept apart
 * from `recovery-service.ts` so the migrator needs nothing but the database.
 */

import { prisma } from "@polaris/db";
import * as policy from "./recovery-policy";

/** How an `ORK` is named as a `ChatHistoryKey` recipient. */
export function recoveryRecipient(keyId: string): string {
    return `ork:${keyId}`;
}

/**
 * The live `ORK` of each scope these accounts belong to, by the same rule as an
 * account's own shares (the organisation joined or created first, else the
 * instance). Scopes with no key yet are left out; one key per scope, the oldest.
 */
export async function liveRecoveryKeysFor(userIds: readonly string[]): Promise<Array<{ id: string; hpkePublicKey: Uint8Array }>> {
    if (userIds.length === 0) return [];
    const ids = [...userIds];
    const [memberships, owned] = await Promise.all([
        prisma.organizationMember.findMany({
            where: { userId: { in: ids } },
            orderBy: { createdAt: "asc" },
            select: { userId: true, orgId: true, createdAt: true }
        }),
        prisma.organization.findMany({
            where: { ownerId: { in: ids } },
            orderBy: { createdAt: "asc" },
            select: { id: true, ownerId: true, createdAt: true }
        })
    ]);
    // Rows come oldest first, so the first one seen per account is its earliest.
    const firstMembership = new Map<string, { orgId: string; createdAt: Date }>();
    for (const row of memberships) if (!firstMembership.has(row.userId)) firstMembership.set(row.userId, row);
    const firstOwned = new Map<string, { id: string; createdAt: Date }>();
    for (const row of owned) if (!firstOwned.has(row.ownerId)) firstOwned.set(row.ownerId, row);
    const scopes = new Set<string>();
    for (const userId of ids) {
        const orgId = policy.firstOrg(firstMembership.get(userId), firstOwned.get(userId));
        scopes.add(orgId ? `org:${orgId}` : "instance");
    }
    const keys = await prisma.chatRecoveryKey.findMany({
        where: { scope: { in: [...scopes] }, retiredAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, scope: true, hpkePublicKey: true },
        take: 200
    });
    const seen = new Set<string>();
    return keys.flatMap((key) => {
        if (seen.has(key.scope)) return [];
        seen.add(key.scope);
        return [{ id: key.id, hpkePublicKey: new Uint8Array(key.hpkePublicKey) }];
    });
}
