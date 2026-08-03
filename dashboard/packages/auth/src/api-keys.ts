/**
 * Personal API keys. A key is a bearer credential a user issues to themselves so
 * a script or an integration can act on their behalf without their password.
 *
 * Two properties keep that safe. The secret is shown once at creation and stored
 * only as a SHA-256 hash keyed by a public prefix, so a database dump yields
 * nothing replayable and a lookup never scans. And a key can only ever narrow its
 * owner's own permissions: `verifyApiKey` intersects the requested scopes with
 * what the user actually holds at call time, so revoking someone's role revokes
 * their keys' reach with it - no stale grant survives in a token.
 */

import { prisma } from "@polaris/db";
import { randomBytes } from "node:crypto";
import { getUserPermissions } from "./roles.js";
import { generateToken, hashToken, tokenMatchesHash } from "@polaris/core/tokens";
import {
    ALL_PERMISSIONS,
    API_KEY_PREFIX,
    PERMISSIONS,
    hasPermission,
    parseStringList,
    stringifyList,
    unionRules,
    type CreateApiKeyInput,
    type EffectiveAccessRules,
    type Permission,
    type UserAgentRules
} from "@polaris/core";

/** One key as the management UI shows it. The secret is never part of this. */
export interface ApiKeyView {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
    /** Client patterns the key answers to, and the ones it always refuses. */
    allowedUserAgents: string[];
    deniedUserAgents: string[];
    groupIds: string[];
    expiresAt: string | null;
    lastUsedAt: string | null;
    lastUsedIp: string | null;
    lastUsedUserAgent: string | null;
    revokedAt: string | null;
    createdAt: string;
}

/** A verified key: who it acts as, what it may do, and where it may be used from. */
export interface VerifiedApiKey {
    id: string;
    userId: string;
    /** Scopes intersected with the owner's live permissions. */
    scopes: Permission[];
    rules: EffectiveAccessRules;
    /** Which clients may present it. Returned unevaluated for the same reason
     *  the network rules are: the request is the caller's to read. */
    clients: UserAgentRules;
}

/** The public half of a key: "plk_" plus 8 URL-safe characters. */
function generatePrefix(): string {
    return `${API_KEY_PREFIX}_${randomBytes(6).toString("base64url")}`;
}

const MINUTES_PER_DAY = 24 * 60;

/** How much of a presented user-agent is kept. It is a header, so its length is
 *  the caller's to choose. */
const MAX_USER_AGENT = 512;

/** When a key stops working: a hand-picked date if there is one, otherwise the
 *  chosen span, and null for a key that never expires. */
function expiryFor(input: CreateApiKeyInput): Date | null {
    if (input.expiresAt) return new Date(input.expiresAt);
    if (input.expiresInDays > 0) {
        return new Date(Date.now() + input.expiresInDays * MINUTES_PER_DAY * 60 * 1000);
    }
    return null;
}

/**
 * Issue a key. The returned `secret` is the only time the full value exists
 * outside the caller's hands - it is not recoverable afterwards.
 */
export async function createApiKey(
    userId: string,
    input: CreateApiKeyInput
): Promise<{ id: string; prefix: string; secret: string }> {
    const prefix = generatePrefix();
    const secret = `${prefix}.${generateToken()}`;
    const owned = await prisma.accessGroup.findMany({
        where: { ownerId: userId, id: { in: input.groupIds } },
        select: { id: true }
    });
    const created = await prisma.apiKey.create({
        data: {
            userId,
            name: input.name,
            prefix,
            keyHash: hashToken(secret),
            scopes: stringifyList(input.scopes),
            allowedCidrs: stringifyList(input.allowedCidrs),
            allowedCountries: stringifyList(input.allowedCountries),
            allowedContinents: stringifyList(input.allowedContinents),
            allowedUserAgents: stringifyList(input.allowedUserAgents),
            deniedUserAgents: stringifyList(input.deniedUserAgents),
            expiresAt: expiryFor(input),
            groups: { createMany: { data: owned.map((group) => ({ groupId: group.id })) } }
        },
        select: { id: true }
    });
    return { id: created.id, prefix, secret };
}

/** Every key a user owns, newest first. */
export async function listApiKeys(userId: string): Promise<ApiKeyView[]> {
    const rows = await prisma.apiKey.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: { groups: { select: { groupId: true } } }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        scopes: parseStringList(row.scopes),
        allowedCidrs: parseStringList(row.allowedCidrs),
        allowedCountries: parseStringList(row.allowedCountries),
        allowedContinents: parseStringList(row.allowedContinents),
        allowedUserAgents: parseStringList(row.allowedUserAgents),
        deniedUserAgents: parseStringList(row.deniedUserAgents),
        groupIds: row.groups.map((group) => group.groupId),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        lastUsedIp: row.lastUsedIp,
        lastUsedUserAgent: row.lastUsedUserAgent,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString()
    }));
}

/** Revoke a key the caller owns. The row is kept so the audit trail survives. */
export async function revokeApiKey(userId: string, id: string): Promise<void> {
    await prisma.apiKey.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Delete a key the caller owns, once they no longer want it listed. */
export async function deleteApiKey(userId: string, id: string): Promise<void> {
    await prisma.apiKey.deleteMany({ where: { id, userId } });
}

/**
 * Resolve a presented key to its owner and effective scopes, or null when it is
 * unknown, revoked, expired, or its owner is banned. The network rules come back
 * unevaluated: the IP/geo decision needs the request context and the geolocation
 * cache, both of which live in the app, so the caller applies them.
 */
export async function verifyApiKey(presented: string): Promise<VerifiedApiKey | null> {
    const prefix = presented.split(".")[0];
    if (!prefix?.startsWith(`${API_KEY_PREFIX}_`)) return null;

    const row = await prisma.apiKey.findUnique({
        where: { prefix },
        include: {
            groups: {
                select: {
                    group: { select: { allowedCidrs: true, allowedCountries: true, allowedContinents: true } }
                }
            },
            user: { select: { bannedAt: true, isAdmin: true } }
        }
    });
    if (!row || !tokenMatchesHash(presented, row.keyHash)) return null;
    if (row.revokedAt || row.user.bannedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

    // A key narrows, never grants: intersect its scopes with what the owner
    // holds right now, so a demoted user's old keys shrink with them. An
    // administrator passes every permission gate, so their scopes stand as-is.
    const granted = await getUserPermissions(row.userId);
    const requested = parseStringList(row.scopes) as Permission[];
    const scopes = row.user.isAdmin
        ? requested
        : requested.filter((scope) => hasPermission(granted, scope));

    return {
        id: row.id,
        userId: row.userId,
        scopes,
        rules: unionRules([row, ...row.groups.map((binding) => binding.group)]),
        clients: {
            allowedUserAgents: parseStringList(row.allowedUserAgents),
            deniedUserAgents: parseStringList(row.deniedUserAgents)
        }
    };
}

/**
 * The scopes a user may put on a key: exactly what they hold themselves, with a
 * wildcard grant expanded so the dialog can show real checkboxes. Administrators
 * pass every permission gate, so their keys may carry any scope.
 */
export async function scopesAvailableTo(userId: string, isAdmin = false): Promise<Permission[]> {
    if (isAdmin) return [...PERMISSIONS];
    const granted = await getUserPermissions(userId);
    if (granted.has(ALL_PERMISSIONS)) return [...PERMISSIONS];
    return PERMISSIONS.filter((permission) => granted.has(permission));
}

/** Record that a key was just used, and by what. Best-effort: never fails the
 *  request. */
export async function touchApiKey(
    id: string,
    ip: string | undefined,
    userAgent?: string
): Promise<void> {
    try {
        await prisma.apiKey.update({
            where: { id },
            data: {
                lastUsedAt: new Date(),
                lastUsedIp: ip ?? null,
                lastUsedUserAgent: userAgent?.slice(0, MAX_USER_AGENT) ?? null
            }
        });
    } catch {
        // A usage stamp is not worth failing an authorized call over.
    }
}
