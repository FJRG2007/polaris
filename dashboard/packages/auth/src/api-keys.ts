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
    type ApiKeyEnvironment,
    type CreateApiKeyInput,
    type EffectiveAccessRules,
    type Permission,
    type UpdateApiKeyInput,
    type UserAgentRules
} from "@polaris/core";

/** One key as the management UI shows it. The secret is never part of this. */
export interface ApiKeyView {
    id: string;
    name: string;
    prefix: string;
    /** Which setup it was made for. A label its owner sorts by. */
    environment: ApiKeyEnvironment;
    /** The last characters of the secret, or null for a key issued before these
     *  were kept. What the list shows after the ellipsis, so a row can be
     *  matched against the value in a password manager. */
    tail: string | null;
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
    /** The app whose settings minted this key, for one that came from there.
     *  Where it came from rather than what it may touch - a project token
     *  carries its owner's permissions like any other key. */
    projectId: string | null;
    projectName: string | null;
    /** Calls answered today, and over the window the counter keeps. Two numbers
     *  because one of them answers "is this still in use" and the other answers
     *  "was it ever" - a key used once in April and one answering a call a
     *  second both read as "last used" and nothing else. */
    usedToday: number;
    usedRecently: number;
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

/** How many characters of the secret are kept for recognising a key. Four of a
 *  random token identify nothing on their own. */
const TAIL_LENGTH = 4;

/** How many days of usage counters are kept. A month is what a screen can
 *  usefully show and what answers "did anything still call this"; older rows are
 *  removed by the first call of a new day. */
const USAGE_WINDOW_DAYS = 30;

/** The day a counter belongs to. UTC, so a key used across a midnight is not
 *  counted twice by two readers in different places. */
function dayKey(at: Date): string {
    return at.toISOString().slice(0, 10);
}

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
            environment: input.environment,
            prefix,
            keyHash: hashToken(secret),
            tail: secret.slice(-TAIL_LENGTH),
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

/**
 * Every key a user owns, newest first.
 *
 * The usage counters come back with the rows rather than being asked for per
 * key: a list of fourteen keys would otherwise be fifteen queries, and the
 * screen draws all of them at once. Only the window the counter keeps is read,
 * which is what bounds this - a key in constant use for a year still has thirty
 * rows.
 */
export async function listApiKeys(userId: string): Promise<ApiKeyView[]> {
    const rows = await prisma.apiKey.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: {
            groups: { select: { groupId: true } },
            project: { select: { name: true } },
            usage: { select: { day: true, calls: true } }
        }
    });
    const today = dayKey(new Date());
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        environment: (row.environment as ApiKeyEnvironment) ?? "production",
        prefix: row.prefix,
        tail: row.tail,
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
        createdAt: row.createdAt.toISOString(),
        projectId: row.projectId,
        projectName: row.project?.name ?? null,
        usedToday: row.usage.find((day) => day.day === today)?.calls ?? 0,
        usedRecently: row.usage.reduce((total, day) => total + day.calls, 0)
    }));
}

/**
 * Change a key that already exists.
 *
 * Everything except the secret, which cannot be changed: it exists for a moment
 * at creation and is a hash afterwards. So a key whose reach or expiry was set
 * wrongly is edited here rather than deleted and re-issued, which is what people
 * otherwise do - and what leaves a script broken until somebody pastes the new
 * value into it.
 *
 * The caller has already narrowed the scopes to what this user actually holds;
 * this trusts that no more than the create path does, which is to say the
 * `userId` in the filter is what makes it theirs.
 */
export async function updateApiKey(userId: string, input: UpdateApiKeyInput): Promise<void> {
    const owned = await prisma.apiKey.findFirst({
        where: { id: input.id, userId },
        select: { id: true }
    });
    if (!owned) return;

    const groups = await prisma.accessGroup.findMany({
        where: { ownerId: userId, id: { in: input.groupIds } },
        select: { id: true }
    });

    await prisma.$transaction([
        prisma.apiKey.update({
            where: { id: input.id },
            data: {
                name: input.name,
                environment: input.environment,
                scopes: stringifyList(input.scopes),
                allowedCidrs: stringifyList(input.allowedCidrs),
                allowedCountries: stringifyList(input.allowedCountries),
                allowedContinents: stringifyList(input.allowedContinents),
                allowedUserAgents: stringifyList(input.allowedUserAgents),
                deniedUserAgents: stringifyList(input.deniedUserAgents),
                // Left exactly as it was when the edit says nothing about it,
                // which is what renaming a key means - see `updateApiKeySchema`.
                ...(newExpiry(input) === undefined ? {} : { expiresAt: newExpiry(input) })
            }
        }),
        // Replaced rather than merged: the editor shows the whole set, so what
        // comes back is the whole answer.
        prisma.apiKeyAccessGroup.deleteMany({ where: { apiKeyId: input.id } }),
        prisma.apiKeyAccessGroup.createMany({
            data: groups.map((group) => ({ apiKeyId: input.id, groupId: group.id }))
        })
    ]);
}

/** When an edited key should stop working: a date, never, or `undefined` for
 *  "leave it as it is". */
function newExpiry(input: UpdateApiKeyInput): Date | null | undefined {
    if (input.expiresAt === null) return null;
    if (input.expiresAt) return new Date(input.expiresAt);
    if (input.expiresInDays === undefined) return undefined;
    if (input.expiresInDays === 0) return null;
    return new Date(Date.now() + input.expiresInDays * MINUTES_PER_DAY * 60 * 1000);
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

/**
 * Record that a key was just used, and by what.
 *
 * Two writes, and the second is the one that makes a list of keys worth reading:
 * a stamp alone cannot tell a key answering a call a second from one that was
 * used once in April, so the day's calls are counted as well. The counter is
 * addressed by its primary key, so it is an upsert and never a scan, and the
 * rows that have aged out of the window go with the first call of a new day -
 * which is the only moment anything here has to walk more than one row.
 *
 * Best-effort throughout: none of it is worth failing an authorized call over.
 */
export async function touchApiKey(
    id: string,
    ip: string | undefined,
    userAgent?: string
): Promise<void> {
    const now = new Date();
    const day = dayKey(now);
    try {
        await prisma.apiKey.update({
            where: { id },
            data: {
                lastUsedAt: now,
                lastUsedIp: ip ?? null,
                lastUsedUserAgent: userAgent?.slice(0, MAX_USER_AGENT) ?? null
            }
        });
    } catch {
        // A usage stamp is not worth failing an authorized call over.
    }
    try {
        const counted = await prisma.apiKeyUsage.upsert({
            where: { apiKeyId_day: { apiKeyId: id, day } },
            create: { apiKeyId: id, day, calls: 1 },
            update: { calls: { increment: 1 } },
            select: { calls: true }
        });
        // The first call of a day is where the window is trimmed. Doing it on
        // every call would be a delete per request for nothing to delete.
        if (counted.calls === 1) {
            const oldest = dayKey(new Date(now.getTime() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000));
            await prisma.apiKeyUsage.deleteMany({ where: { apiKeyId: id, day: { lt: oldest } } });
        }
    } catch {
        // Same again: a counter is not worth an error the caller can do nothing
        // about.
    }
}
