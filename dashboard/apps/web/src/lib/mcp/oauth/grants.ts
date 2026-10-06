/**
 * Grants, codes and tokens: everything a person's yes turns into.
 *
 * The rules, from OAuth 2.1 and the MCP authorization spec:
 *
 *   - Every secret is random, 256 bits, and stored only as its SHA-256. Looking
 *     one up is by that hash, so nothing compares a presented value byte by
 *     byte against a stored one.
 *   - A code is single use, five minutes long, and bound to the PKCE challenge,
 *     the client, the exact redirect address and the resource. Exchanged twice,
 *     it was intercepted, and every token issued under the grant is ended.
 *   - An access token lasts an hour and is good for one resource: this
 *     instance's MCP endpoint. Nothing else in Polaris reads it.
 *   - A refresh token is rotated on every use (required for public clients).
 *     One presented again after it was rotated has been copied, and the whole
 *     grant is ended - the thief and the app both have to come back through the
 *     consent screen, which only the person can pass.
 *   - What a token may do is what was approved, cut to what its person holds at
 *     the moment of the call. A grant never outlives the permission behind it.
 */

import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { sameResource } from "./urls";
import { scopeString } from "./scopes";
import { verifierMatches } from "./pkce";
import { clientBrand, type ClientBrand } from "./client-brand";
import { IP_REFUSED_DESCRIPTION, grantAllowsIp } from "./ip-guard";
import { readIpPolicy, type IpPolicy } from "./ip-policy";
import { readDatabaseReach, storedDatabaseReach, type DatabaseReach } from "./database-reach";
import {
    readNetworkException,
    storedNetworkException,
    type NetworkException
} from "./network-exception";
import { getUserPermissions } from "@polaris/auth";
import type { OAuthClientRecord } from "./clients";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { readScopes, scopeRequires, type McpScope } from "@/lib/mcp/scope-table";
import { hasPermission, parseStringList, stringifyList } from "@polaris/core";

export const ACCESS_TOKEN_PREFIX = "pmo_";
const REFRESH_TOKEN_PREFIX = "pmr_";
const CODE_PREFIX = "pma_";

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;
/** How long a rotated refresh token is remembered, so a replay of it is still
 *  recognised as one rather than as an unknown token. */
const ROTATED_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;
/** A grant's last-used stamp is written at most this often. */
const TOUCH_INTERVAL_MS = 60 * 1000;

/** The token endpoint's answer, success or the RFC 6749 section 5.2 error. */
export type TokenOutcome =
    | {
          ok: true;
          body: {
              access_token: string;
              token_type: "Bearer";
              expires_in: number;
              refresh_token: string;
              scope: string;
          };
      }
    | {
          ok: false;
          error: "invalid_grant" | "invalid_request" | "invalid_scope" | "invalid_target";
          description: string;
      };

function refused(
    error: "invalid_grant" | "invalid_request" | "invalid_scope" | "invalid_target",
    description: string
): TokenOutcome {
    return { ok: false, error, description };
}

/**
 * End a grant because something presented under it was a copy: a code
 * exchanged twice, or a refresh token used after it was rotated. Written to the
 * person's activity, because it means somebody else held one of their tokens.
 */
async function endReplayedGrant(grantId: string, what: "code" | "refresh-token"): Promise<void> {
    const grant = await prisma.oAuthGrant.findUnique({
        where: { id: grantId },
        select: { userId: true, client: { select: { name: true } } }
    });
    await endGrant(grantId);
    await recordAudit({
        actorId: grant?.userId ?? null,
        action: "account.oauth.replay-detected",
        targetType: "oauthGrant",
        targetId: grantId,
        metadata: { app: grant?.client.name ?? null, replayed: what }
    });
}

/** End a grant: every token and code under it is deleted and the grant is
 *  marked revoked, which is what the connected-apps list shows. */
async function endGrant(grantId: string): Promise<void> {
    await prisma.$transaction([
        prisma.oAuthToken.deleteMany({ where: { grantId } }),
        prisma.oAuthCode.deleteMany({ where: { grantId } }),
        prisma.oAuthGrant.updateMany({
            where: { id: grantId, revokedAt: null },
            data: { revokedAt: new Date() }
        })
    ]);
}

/**
 * Record a person's approval and hand back the code for the app.
 *
 * One grant per person and app: approving the same app again replaces what it
 * may do with what was approved now, and brings a revoked grant back. What the
 * app asked for is kept beside it, as the ceiling for changing it later.
 */
export async function approve(input: {
    userId: string;
    client: OAuthClientRecord;
    redirectUri: string;
    codeChallenge: string;
    resource: string;
    scopes: readonly McpScope[];
    requested: readonly McpScope[];
    /** Where the person approved it from, for the "only from there" rule. */
    approvedIp?: string | null;
}): Promise<{ code: string; grantId: string }> {
    const scopes = stringifyList([...input.scopes]);
    const requestedScopes = stringifyList([...input.requested]);
    const grant = await prisma.oAuthGrant.upsert({
        where: { userId_clientId: { userId: input.userId, clientId: input.client.id } },
        create: {
            userId: input.userId,
            clientId: input.client.id,
            scopes,
            requestedScopes,
            approvedIp: input.approvedIp ?? null,
            resource: input.resource
        },
        // The address rule the person set is kept across a reconnection; the
        // address it was approved from is the new one.
        update: {
            scopes,
            requestedScopes,
            approvedIp: input.approvedIp ?? null,
            resource: input.resource,
            revokedAt: null
        },
        select: { id: true }
    });
    const code = `${CODE_PREFIX}${generateToken()}`;
    const now = Date.now();
    await prisma.$transaction([
        prisma.oAuthCode.deleteMany({
            where: { grantId: grant.id, expiresAt: { lt: new Date(now) } }
        }),
        prisma.oAuthCode.create({
            data: {
                codeHash: hashToken(code),
                grantId: grant.id,
                redirectUri: input.redirectUri,
                codeChallenge: input.codeChallenge,
                resource: input.resource,
                scopes,
                expiresAt: new Date(now + CODE_TTL_MS)
            }
        })
    ]);
    return { code, grantId: grant.id };
}

/** Mint an access and refresh token pair under a grant, and tidy what has
 *  expired under it while there. */
async function issue(
    grantId: string,
    scopes: readonly string[],
    resource: string
): Promise<TokenOutcome> {
    const access = `${ACCESS_TOKEN_PREFIX}${generateToken()}`;
    const refresh = `${REFRESH_TOKEN_PREFIX}${generateToken()}`;
    const now = Date.now();
    const stored = stringifyList([...scopes]);
    await prisma.$transaction([
        prisma.oAuthToken.deleteMany({
            where: {
                grantId,
                OR: [
                    { expiresAt: { lt: new Date(now) } },
                    { usedAt: { lt: new Date(now - ROTATED_MEMORY_MS) } }
                ]
            }
        }),
        prisma.oAuthToken.create({
            data: {
                grantId,
                kind: "access",
                tokenHash: hashToken(access),
                scopes: stored,
                resource,
                expiresAt: new Date(now + ACCESS_TTL_MS)
            }
        }),
        prisma.oAuthToken.create({
            data: {
                grantId,
                kind: "refresh",
                tokenHash: hashToken(refresh),
                scopes: stored,
                resource,
                expiresAt: new Date(now + REFRESH_TTL_MS)
            }
        })
    ]);
    return {
        ok: true,
        body: {
            access_token: access,
            token_type: "Bearer",
            expires_in: Math.floor(ACCESS_TTL_MS / 1000),
            refresh_token: refresh,
            scope: scopeString(scopes)
        }
    };
}

/** Whether a grant's person can still be acted for at all. */
async function grantStands(grant: {
    revokedAt: Date | null;
    user: { bannedAt: Date | null };
}): Promise<boolean> {
    return grant.revokedAt === null && grant.user.bannedAt === null;
}

/** Exchange an authorization code (RFC 6749 section 4.1.3, RFC 7636 section 4.6). */
export async function exchangeCode(input: {
    client: OAuthClientRecord;
    code: string | null;
    redirectUri: string | null;
    verifier: string | null;
    resource: string | null;
    /** The caller's address, as `clientIp()` resolved it. */
    ip?: string;
}): Promise<TokenOutcome> {
    if (!input.code || !input.verifier || !input.redirectUri) {
        return refused("invalid_request", "code, code_verifier and redirect_uri are required");
    }
    if (input.code.length > 200 || !input.code.startsWith(CODE_PREFIX)) {
        return refused("invalid_grant", "The code is not valid");
    }
    const row = await prisma.oAuthCode.findUnique({
        where: { codeHash: hashToken(input.code) },
        include: {
            grant: {
                select: {
                    id: true,
                    userId: true,
                    clientId: true,
                    revokedAt: true,
                    ipPolicy: true,
                    approvedIp: true,
                    user: { select: { bannedAt: true } }
                }
            }
        }
    });
    // One answer for every way a code can be wrong, so a guess learns nothing.
    const invalid = refused(
        "invalid_grant",
        "The code is not valid, has expired, or was already used"
    );
    if (!row || row.grant.clientId !== input.client.id) return invalid;
    if (row.usedAt) {
        // Exchanged once already: whoever is presenting it now, one of the two
        // copies was not the app's. RFC 6749 section 4.1.2 says to revoke what
        // the code produced; ending the grant does that and more.
        await endReplayedGrant(row.grantId, "code");
        return invalid;
    }
    if (row.expiresAt.getTime() <= Date.now()) return invalid;
    if (row.redirectUri !== input.redirectUri) return invalid;
    if (!verifierMatches(input.verifier, row.codeChallenge)) return invalid;
    if (input.resource !== null && !sameResource(input.resource, row.resource)) {
        return refused("invalid_target", "resource does not match the one that was authorized");
    }
    if (!(await grantStands(row.grant))) return invalid;
    if (!(await grantAllowsIp(row.grant, input.ip))) {
        return refused("invalid_grant", IP_REFUSED_DESCRIPTION);
    }

    // Spent before anything is issued, and only by the one request that finds it
    // unspent: two exchanges racing each other get one pair between them.
    const spent = await prisma.oAuthCode.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() }
    });
    if (spent.count !== 1) {
        await endReplayedGrant(row.grantId, "code");
        return invalid;
    }
    return issue(row.grantId, parseStringList(row.scopes), row.resource);
}

/** Exchange a refresh token for a new pair (RFC 6749 section 6), rotating it. */
export async function refresh(input: {
    client: OAuthClientRecord;
    refreshToken: string | null;
    scope: string | null;
    resource: string | null;
    /** The caller's address, as `clientIp()` resolved it. */
    ip?: string;
}): Promise<TokenOutcome> {
    if (!input.refreshToken) return refused("invalid_request", "refresh_token is required");
    const invalid = refused("invalid_grant", "The refresh token is not valid or has expired");
    if (input.refreshToken.length > 200 || !input.refreshToken.startsWith(REFRESH_TOKEN_PREFIX))
        return invalid;

    const row = await prisma.oAuthToken.findUnique({
        where: { tokenHash: hashToken(input.refreshToken) },
        include: {
            grant: {
                select: {
                    id: true,
                    userId: true,
                    clientId: true,
                    revokedAt: true,
                    scopes: true,
                    ipPolicy: true,
                    approvedIp: true,
                    user: { select: { bannedAt: true } }
                }
            }
        }
    });
    if (!row || row.kind !== "refresh" || row.grant.clientId !== input.client.id) return invalid;
    if (row.usedAt) {
        // Rotated already. The app holds the newer one, so this is a copy.
        await endReplayedGrant(row.grantId, "refresh-token");
        return invalid;
    }
    if (row.expiresAt.getTime() <= Date.now()) return invalid;
    if (!(await grantStands(row.grant))) return invalid;
    if (input.resource !== null && !sameResource(input.resource, row.resource)) {
        return refused("invalid_target", "resource does not match the one that was authorized");
    }
    // Refused before the token is spent, so the app can retry from an address
    // the rule allows with the same refresh token.
    if (!(await grantAllowsIp(row.grant, input.ip))) {
        return refused("invalid_grant", IP_REFUSED_DESCRIPTION);
    }

    // A refresh may ask for less than the grant, never for more - and never for
    // more than the person approved most recently, which is narrower than this
    // token when they connected the app again and ticked fewer boxes.
    const approved = new Set(parseStringList(row.grant.scopes));
    const held = parseStringList(row.scopes).filter((scope) => approved.has(scope));
    let scopes = held;
    if (input.scope?.trim()) {
        const asked = [...new Set(input.scope.trim().split(/\s+/))];
        if (asked.some((scope) => !held.includes(scope))) {
            return refused("invalid_scope", "A refresh cannot add scopes that were not approved");
        }
        scopes = held.filter((scope) => asked.includes(scope));
    }

    const spent = await prisma.oAuthToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() }
    });
    if (spent.count !== 1) {
        await endReplayedGrant(row.grantId, "refresh-token");
        return invalid;
    }
    return issue(row.grantId, scopes, row.resource);
}

/**
 * Revoke a token an app holds (RFC 7009). An access token goes on its own; a
 * refresh token takes the grant with it, because an app revoking its refresh
 * token is an app disconnecting. A token that is unknown, or another app's, is
 * answered the same as one that was revoked - the RFC says so, and it keeps the
 * endpoint from telling anybody which tokens exist.
 */
export async function revokeToken(client: OAuthClientRecord, token: string): Promise<void> {
    if (!token || token.length > 200) return;
    const row = await prisma.oAuthToken.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { id: true, kind: true, grantId: true, grant: { select: { clientId: true } } }
    });
    if (!row || row.grant.clientId !== client.id) return;
    if (row.kind === "refresh") await endGrant(row.grantId);
    else await prisma.oAuthToken.deleteMany({ where: { id: row.id } });
}

/** A verified access token: who it acts for and what it may do right now. */
export interface VerifiedAccess {
    readonly grantId: string;
    readonly userId: string;
    readonly isAdmin: boolean;
    readonly scopes: McpScope[];
    /** What the connection's address rule reads, for the caller to apply. */
    readonly ipPolicy: string | null;
    readonly approvedIp: string | null;
    /** Where it may call from past the account's network rules. */
    readonly networkException: NetworkException;
    /** Which databases the database tools may reach; null for every one the
     *  person can open. */
    readonly databaseIds: DatabaseReach;
}

/**
 * Resolve an access token presented to the MCP endpoint, or null.
 *
 * Refused unless it was issued for exactly this resource - a token is not a
 * key to anything else in Polaris, and one minted for another address of this
 * instance does not open this one.
 */
export async function verifyAccessToken(
    token: string,
    resource: string
): Promise<VerifiedAccess | null> {
    if (!token.startsWith(ACCESS_TOKEN_PREFIX) || token.length > 200) return null;
    const row = await prisma.oAuthToken.findUnique({
        where: { tokenHash: hashToken(token) },
        select: {
            kind: true,
            scopes: true,
            resource: true,
            expiresAt: true,
            grant: {
                select: {
                    id: true,
                    userId: true,
                    revokedAt: true,
                    scopes: true,
                    ipPolicy: true,
                    approvedIp: true,
                    networkException: true,
                    databaseIds: true,
                    lastUsedAt: true,
                    user: { select: { bannedAt: true, isAdmin: true } }
                }
            }
        }
    });
    if (!row || row.kind !== "access") return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    if (row.grant.revokedAt || row.grant.user.bannedAt) return null;
    if (!sameResource(row.resource, resource)) return null;

    // What this token was issued with, cut to the grant as it stands now (the
    // person may have connected the app again with fewer boxes ticked) and then
    // to what the person holds right now - for a finer scope, the permission it
    // stands on. A stored scope this Polaris no longer knows is dropped here,
    // never trusted.
    const approved = new Set(parseStringList(row.grant.scopes));
    const requested = readScopes(parseStringList(row.scopes)).filter((scope) =>
        approved.has(scope)
    );
    const granted = await getUserPermissions(row.grant.userId);
    const scopes = row.grant.user.isAdmin
        ? requested
        : requested.filter((scope) => hasPermission(granted, scopeRequires(scope)));
    return {
        grantId: row.grant.id,
        userId: row.grant.userId,
        isAdmin: row.grant.user.isAdmin,
        scopes,
        ipPolicy: row.grant.ipPolicy,
        approvedIp: row.grant.approvedIp,
        networkException: readNetworkException(row.grant.networkException),
        databaseIds: readDatabaseReach(row.grant.databaseIds)
    };
}

/** Stamp a grant as used, at most once a minute. Never throws. */
export async function touchGrant(grantId: string, ip: string | undefined): Promise<void> {
    try {
        await prisma.oAuthGrant.updateMany({
            where: {
                id: grantId,
                OR: [
                    { lastUsedAt: null },
                    { lastUsedAt: { lt: new Date(Date.now() - TOUCH_INTERVAL_MS) } }
                ]
            },
            data: { lastUsedAt: new Date(), lastUsedIp: ip ?? null }
        });
    } catch {
        // A usage stamp is not worth failing an authorized call over.
    }
}

/** One connected app, as the account screen lists it. */
export interface ConnectedAppView {
    readonly id: string;
    readonly name: string;
    readonly clientUri: string | null;
    /** Where it sends people back to, which is what identifies it. */
    readonly redirectHost: string | null;
    /** The known assistant it is, for its mark; null draws its initial. */
    readonly brand: ClientBrand | null;
    readonly scopes: McpScope[];
    /** What the app asked for when it was approved. The edit dialog marks what
     *  it offers beyond this; a grant from before that was kept reads as what
     *  it holds. */
    readonly requestable: McpScope[];
    readonly createdAt: string;
    readonly lastUsedAt: string | null;
    readonly lastUsedIp: string | null;
    /** Where it may call from. */
    readonly ipPolicy: IpPolicy;
    readonly approvedIp: string | null;
    /** The last call that rule refused. */
    readonly lastRefusedAt: string | null;
    readonly lastRefusedIp: string | null;
    /** Where it may call from past the account's network rules. */
    readonly networkException: NetworkException;
    /** Which databases the database tools may reach; null for every one. */
    readonly databaseIds: DatabaseReach;
}

/** What the account screen reads of a grant and its app. */
const APP_SELECT = {
    id: true,
    scopes: true,
    requestedScopes: true,
    createdAt: true,
    lastUsedAt: true,
    lastUsedIp: true,
    ipPolicy: true,
    approvedIp: true,
    lastRefusedAt: true,
    lastRefusedIp: true,
    networkException: true,
    databaseIds: true,
    client: { select: { name: true, clientUri: true, clientId: true, redirectUris: true } }
} as const;

function appView(row: {
    id: string;
    scopes: string;
    requestedScopes: string | null;
    createdAt: Date;
    lastUsedAt: Date | null;
    lastUsedIp: string | null;
    ipPolicy: string | null;
    approvedIp: string | null;
    lastRefusedAt: Date | null;
    lastRefusedIp: string | null;
    networkException: string | null;
    databaseIds: string | null;
    client: { name: string; clientUri: string | null; redirectUris: string };
}): ConnectedAppView {
    const redirects = parseStringList(row.client.redirectUris);
    const first = redirects[0];
    let redirectHost: string | null = null;
    try {
        redirectHost = first ? new URL(first).hostname : null;
    } catch {
        redirectHost = null;
    }
    return {
        id: row.id,
        name: row.client.name,
        clientUri: row.client.clientUri,
        redirectHost,
        brand: clientBrand(row.client.name, redirects),
        // Only scopes this Polaris knows: one stored by a version that had a
        // scope since removed is left in the row and out of the screen.
        scopes: readScopes(parseStringList(row.scopes)),
        requestable: readScopes(parseStringList(row.requestedScopes ?? row.scopes)),
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        lastUsedIp: row.lastUsedIp,
        ipPolicy: readIpPolicy(row.ipPolicy),
        approvedIp: row.approvedIp,
        lastRefusedAt: row.lastRefusedAt?.toISOString() ?? null,
        lastRefusedIp: row.lastRefusedIp,
        networkException: readNetworkException(row.networkException),
        databaseIds: readDatabaseReach(row.databaseIds)
    };
}

/** The apps a person has connected and not disconnected, most recent first. */
export async function listConnectedApps(userId: string): Promise<ConnectedAppView[]> {
    const rows = await prisma.oAuthGrant.findMany({
        where: { userId, revokedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 100,
        select: APP_SELECT
    });
    return rows.map(appView);
}

/** One app this person has connected, or null when it is not theirs. */
export async function findConnectedApp(
    userId: string,
    grantId: string
): Promise<ConnectedAppView | null> {
    const row = await prisma.oAuthGrant.findFirst({
        where: { id: grantId, userId, revokedAt: null },
        select: APP_SELECT
    });
    return row ? appView(row) : null;
}

/** Disconnect an app a person connected. False when it is not theirs. */
export async function revokeConnectedApp(userId: string, grantId: string): Promise<boolean> {
    const grant = await prisma.oAuthGrant.findFirst({
        where: { id: grantId, userId, revokedAt: null },
        select: { id: true }
    });
    if (!grant) return false;
    await endGrant(grant.id);
    return true;
}

/**
 * Change what a connected app may do, at once.
 *
 * `scopes` is the whole new set, already cut by the caller to what the app
 * asked for, what MCP offers and what the person holds. The grant and every
 * live token under it are rewritten together: a scope taken away is refused on
 * the app's very next call (every call reads the grant), and one added works
 * on that call too, without waiting for the app to refresh. Codes in flight
 * are left alone; they carry the grant's own check when exchanged.
 *
 * Null when the grant is not this person's or was disconnected; otherwise what
 * it held before, for the audit.
 */
export async function changeGrantScopes(
    userId: string,
    grantId: string,
    scopes: readonly McpScope[]
): Promise<{ before: string[] } | null> {
    const grant = await prisma.oAuthGrant.findFirst({
        where: { id: grantId, userId, revokedAt: null },
        select: { id: true, scopes: true }
    });
    if (!grant) return null;
    const stored = stringifyList([...scopes]);
    await prisma.$transaction([
        prisma.oAuthGrant.update({ where: { id: grant.id }, data: { scopes: stored } }),
        prisma.oAuthToken.updateMany({ where: { grantId: grant.id }, data: { scopes: stored } })
    ]);
    return { before: parseStringList(grant.scopes) };
}

/**
 * Set where a connected app may call from. Applies to its very next call: the
 * MCP endpoint and the token endpoint read the rule from the grant every time.
 * False when the grant is not this person's or was disconnected.
 */
export async function setGrantIpPolicy(
    userId: string,
    grantId: string,
    policy: IpPolicy
): Promise<boolean> {
    const changed = await prisma.oAuthGrant.updateMany({
        where: { id: grantId, userId, revokedAt: null },
        data: {
            ipPolicy: policy.mode === "none" ? null : JSON.stringify(policy),
            lastRefusedAt: null,
            lastRefusedIp: null
        }
    });
    return changed.count === 1;
}

/**
 * Set where a connected app may call from past the account's network rules.
 * Applies to its very next call. False when the grant is not this person's or
 * was disconnected.
 */
export async function setGrantNetworkException(
    userId: string,
    grantId: string,
    exception: NetworkException
): Promise<boolean> {
    const changed = await prisma.oAuthGrant.updateMany({
        where: { id: grantId, userId, revokedAt: null },
        data: { networkException: storedNetworkException(exception) }
    });
    return changed.count === 1;
}

/**
 * Set which databases a connected app's database tools may reach. Applies to
 * its very next call: the MCP endpoint reads it from the grant every time.
 * False when the grant is not this person's or was disconnected.
 */
export async function setGrantDatabases(
    userId: string,
    grantId: string,
    reach: DatabaseReach
): Promise<boolean> {
    const changed = await prisma.oAuthGrant.updateMany({
        where: { id: grantId, userId, revokedAt: null },
        data: { databaseIds: storedDatabaseReach(reach) }
    });
    return changed.count === 1;
}
