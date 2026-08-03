/**
 * Which outside accounts belong to which Polaris account.
 *
 * Everything here exists so Polaris never holds one credential that reaches
 * everybody's repositories or calendars. A row is written only from a provider's
 * own callback, or from a token its owner pasted about their own account, so
 * "these people's repositories" is a sentence the people themselves said.
 *
 * The credential is the sensitive part, so it never leaves this module in a
 * shape anything else could store: it is envelope-encrypted under the master key
 * the same way storage credentials and integration keys are, and callers get it
 * back only for the one request they are making.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { getSetting } from "@/lib/setting-store";
import { encryptSecret, decryptSecret, CredentialDecryptError } from "@polaris/storage";
import { connectionLimitKey, connectionSignInKey, findConnectionProvider } from "@polaris/core";

/** Auditing is imported where it is used rather than at the top, because the
 *  audit service reaches the auth instance and this module sits on the read path
 *  of every deploy - loading it eagerly pulls the whole auth stack into a build
 *  plan. Writes are rare, so the extra resolution costs nothing that matters. */
async function audit(entry: {
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    const { recordAudit } = await import("@/lib/audit-service");
    await recordAudit(entry);
}

/** What a screen may know about a linked account: never the credential. */
export interface ConnectionView {
    readonly id: string;
    readonly provider: string;
    /** The provider's own id for the account. */
    readonly accountId: string;
    /** The GitHub login, the Google address. */
    readonly label: string;
    readonly avatarUrl: string | null;
    readonly method: "oauth" | "token";
    readonly scope: string;
    /** Whether the owner lets this account sign them in. The operator's own
     *  switch is separate, and both have to allow it. */
    readonly signInEnabled: boolean;
    readonly linkedAt: string;
}

/**
 * The credential behind a link. Which fields are set depends on how the account
 * was authorized: an OAuth link carries a refresh token (and, where the provider
 * issues expiring ones, the access token it last minted), a pasted token carries
 * only itself.
 */
export interface ConnectionCredential {
    readonly refreshToken?: string;
    readonly accessToken?: string;
    /** Epoch milliseconds the access token stops being accepted at. */
    readonly expiresAt?: number;
    /** A personal access token, for the "token" method. */
    readonly token?: string;
}

/** Raised when somebody has as many accounts of a provider as they are allowed. */
export class ConnectionLimitError extends Error {
    constructor(provider: string, limit: number) {
        super(
            limit === 0
                ? `Linking ${provider} accounts is turned off on this Polaris.`
                : `You can link ${limit} ${provider} account${limit === 1 ? "" : "s"}. Unlink one to add another.`
        );
        this.name = "ConnectionLimitError";
    }
}

/** Raised when the account authorized is already somebody else's here. */
export class ConnectionClaimedError extends Error {
    constructor(label: string) {
        super(`${label} is already linked to another Polaris account.`);
        this.name = "ConnectionClaimedError";
    }
}

type ConnectionRow = {
    id: string;
    provider: string;
    accountId: string;
    label: string;
    avatarUrl: string | null;
    method: string;
    scope: string;
    signInEnabled: boolean;
    linkedAt: Date;
};

function view(row: ConnectionRow): ConnectionView {
    return {
        id: row.id,
        provider: row.provider,
        accountId: row.accountId,
        label: row.label,
        avatarUrl: row.avatarUrl,
        method: row.method === "token" ? "token" : "oauth",
        scope: row.scope,
        signInEnabled: row.signInEnabled,
        linkedAt: row.linkedAt.toISOString()
    };
}

const VIEW_COLUMNS = {
    id: true,
    provider: true,
    accountId: true,
    label: true,
    avatarUrl: true,
    method: true,
    scope: true,
    signInEnabled: true,
    linkedAt: true
} as const;

/**
 * How many accounts of one provider a person may link. The operator sets it per
 * provider; absent, the provider's own default applies, which is one - enough for
 * everybody who has a single GitHub account and no surprise for anybody else.
 */
export async function connectionLimit(provider: string): Promise<number> {
    const fallback = findConnectionProvider(provider)?.defaultLimit ?? 1;
    const stored = await getSetting(connectionLimitKey(provider));
    if (stored === null) return fallback;
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Whether this service may sign anybody in on this deployment at all.
 *
 * The operator's half of the decision, kept apart from each person's own: a
 * service turned off here refuses everybody whatever they chose for themselves,
 * which is what an operator reaching for it wants. Absent, the provider's own
 * default applies - off for anything Polaris does not recommend as a way in, so
 * a provider added later never arrives already open.
 */
export async function connectionSignInAllowed(provider: string): Promise<boolean> {
    const fallback = findConnectionProvider(provider)?.signInDefault ?? false;
    const stored = await getSetting(connectionSignInKey(provider));
    if (stored === null) return fallback;
    return stored === "true";
}

/** Somebody's linked accounts, newest first, optionally for one provider. */
export async function listConnections(userId: string, provider?: string): Promise<ConnectionView[]> {
    const rows = await prisma.userConnection.findMany({
        where: { userId, ...(provider ? { provider } : {}) },
        select: VIEW_COLUMNS,
        orderBy: { linkedAt: "asc" }
    });
    return rows.map(view);
}

/** One linked account of this person's, or null - id alone is never enough. */
export async function getConnection(userId: string, id: string): Promise<ConnectionView | null> {
    const row = await prisma.userConnection.findFirst({ where: { id, userId }, select: VIEW_COLUMNS });
    return row ? view(row) : null;
}

export interface SaveConnectionInput {
    provider: string;
    /** The provider's own id for the account. */
    accountId: string;
    label: string;
    avatarUrl?: string | null;
    method: "oauth" | "token";
    scope?: string;
    /** The address on that account, when the provider vouches for one. Recorded
     *  as one of this person's own, which is what reserves it. */
    email?: string | null;
    /** Null keeps whatever is stored; a value replaces it. */
    credential?: ConnectionCredential | null;
}

/**
 * Record that this Polaris account is that outside account.
 *
 * Re-authorizing an account somebody already linked refreshes it in place rather
 * than spending one of their slots. An account already claimed by somebody else
 * is refused rather than moved: silently reassigning it would change which
 * repositories a pool serves on the word of whoever authorized second.
 */
export async function saveConnection(userId: string, input: SaveConnectionInput): Promise<ConnectionView> {
    const claimed = await prisma.userConnection.findUnique({
        where: { provider_accountId: { provider: input.provider, accountId: input.accountId } },
        select: { id: true, userId: true }
    });
    if (claimed && claimed.userId !== userId) throw new ConnectionClaimedError(input.label);

    if (!claimed) {
        const limit = await connectionLimit(input.provider);
        const held = await prisma.userConnection.count({ where: { userId, provider: input.provider } });
        if (held >= limit) throw new ConnectionLimitError(input.provider, limit);
    }

    const secret = input.credential ? encryptCredential(input.credential) : undefined;
    const stored = {
        label: input.label,
        avatarUrl: input.avatarUrl ?? null,
        method: input.method,
        scope: input.scope ?? "",
        ...(secret ?? {})
    };
    const row = await prisma.userConnection.upsert({
        where: { provider_accountId: { provider: input.provider, accountId: input.accountId } },
        create: {
            userId,
            provider: input.provider,
            accountId: input.accountId,
            // Only ever set here, on the row's first write. Re-authorizing an
            // account must not put back a way in its owner turned off.
            signInEnabled: findConnectionProvider(input.provider)?.signInDefault ?? false,
            ...stored
        },
        update: stored,
        select: VIEW_COLUMNS
    });

    await reserveEmail(userId, input.email);
    await audit({
        actorId: userId,
        action: claimed ? "connection.refresh" : "connection.link",
        targetType: "user",
        targetId: userId,
        metadata: { provider: input.provider, account: input.label, method: input.method }
    });
    return view(row);
}

/**
 * Hold the address on a linked account for the person who linked it.
 *
 * The provider has just vouched for it, which is the same proof a confirmation
 * link gives, so it is kept as one of their addresses - and an address one
 * account holds is one no other account can be created with. Every way this can
 * fail is a reason to leave things as they are rather than to fail the link: an
 * address somebody else already holds simply stays theirs.
 *
 * Imported where it is used for the reason the audit service is: this module
 * sits on the read path of every deploy, and the auth package is a large thing
 * to pull into that build plan for something only a link ever does.
 */
async function reserveEmail(userId: string, email: string | null | undefined): Promise<void> {
    if (!email) return;
    const { adoptVerifiedEmail } = await import("@polaris/auth");
    const result = await adoptVerifiedEmail(userId, email).catch((error: unknown) => ({ error: String(error) }));
    if (result.error) console.warn("linked address not held:", result.error);
}

/**
 * The credential behind one link, or null when there is none or the stored blob
 * can no longer be decrypted (a rotated master key). An undecryptable row reads
 * as no credential at all, so the person is asked to link again instead of being
 * shown an error about key ids.
 */
export async function readCredential(connectionId: string): Promise<ConnectionCredential | null> {
    const row = await prisma.userConnection.findUnique({
        where: { id: connectionId },
        select: { encryptedToken: true, tokenNonce: true, tokenKeyId: true }
    });
    if (!row?.encryptedToken || !row.tokenNonce) return null;
    let plain: string;
    try {
        plain = decryptSecret(
            {
                ciphertext: Buffer.from(row.encryptedToken),
                nonce: Buffer.from(row.tokenNonce),
                keyId: row.tokenKeyId ?? ""
            },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch (caught) {
        if (caught instanceof CredentialDecryptError) return null;
        throw caught;
    }
    return parseCredential(plain);
}

/** Replace the credential on a link that was just refreshed against the provider. */
export async function updateCredential(connectionId: string, credential: ConnectionCredential): Promise<void> {
    await prisma.userConnection.update({ where: { id: connectionId }, data: encryptCredential(credential) });
}

/**
 * Let this account sign its owner in, or stop it doing so.
 *
 * Scoped to one link rather than to the provider, because a person with a work
 * GitHub and a personal one has every reason to let one of them in and not the
 * other. Turning it off never unlinks anything: whatever the account was linked
 * for goes on working.
 */
export async function setConnectionSignIn(
    userId: string,
    id: string,
    enabled: boolean
): Promise<ConnectionView | null> {
    const existing = await getConnection(userId, id);
    if (!existing) return null;
    if (existing.signInEnabled === enabled) return existing;

    const row = await prisma.userConnection.update({
        where: { id },
        data: { signInEnabled: enabled },
        select: VIEW_COLUMNS
    });
    await audit({
        actorId: userId,
        action: enabled ? "connection.signin.allowed" : "connection.signin.refused",
        targetType: "user",
        targetId: userId,
        metadata: { provider: existing.provider, account: existing.label }
    });
    return view(row);
}

/**
 * Whose Polaris account an outside account belongs to, for a sign-in.
 *
 * Answers with the owner only when the link itself allows a sign-in; a link the
 * owner has closed is reported as no link at all, so the callback has one thing
 * to decide rather than two. Never says whether the account exists here at all -
 * that answer belongs to nobody but its owner.
 */
export async function signInConnection(
    provider: string,
    accountId: string
): Promise<{ userId: string; connectionId: string; label: string; banned: boolean } | null> {
    const row = await prisma.userConnection.findUnique({
        where: { provider_accountId: { provider, accountId } },
        select: { id: true, userId: true, label: true, signInEnabled: true, user: { select: { bannedAt: true } } }
    });
    if (!row?.signInEnabled) return null;
    // A suspended account is reported rather than hidden, so the caller can say
    // what a password sign-in would have said. Nothing is issued either way, and
    // whoever is holding the linked account is its owner.
    return { userId: row.userId, connectionId: row.id, label: row.label, banned: row.user.bannedAt !== null };
}

/**
 * Forget a link. Whatever it reached stops being reachable on the next pass,
 * which is the point: unlinking is how somebody takes their repositories off
 * somebody else's machine, or their calendar off this screen.
 */
export async function deleteConnection(userId: string, id: string): Promise<ConnectionView | null> {
    const existing = await getConnection(userId, id);
    if (!existing) return null;
    await prisma.userConnection.delete({ where: { id } });
    await audit({
        actorId: userId,
        action: "connection.unlink",
        targetType: "user",
        targetId: userId,
        metadata: { provider: existing.provider, account: existing.label }
    });
    return existing;
}

/** The linked accounts of whichever of these people have any. Absent people are
 *  simply not there - a pool serving them serves nothing of theirs until they
 *  link, and the pool card says so. */
export async function connectionsForUsers(
    provider: string,
    userIds: readonly string[]
): Promise<Array<ConnectionView & { userId: string }>> {
    if (userIds.length === 0) return [];
    const rows = await prisma.userConnection.findMany({
        where: { provider, userId: { in: [...userIds] } },
        select: { ...VIEW_COLUMNS, userId: true }
    });
    return rows.map((row) => ({ ...view(row), userId: row.userId }));
}

/** The same, for whoever is in a group right now. Membership is read at
 *  resolution time rather than frozen into the pool, so somebody removed from the
 *  group stops being served without the pool being edited. */
export async function connectionsForGroup(
    provider: string,
    groupId: string
): Promise<Array<ConnectionView & { userId: string }>> {
    const rows = await prisma.userConnection.findMany({
        where: { provider, user: { groups: { some: { groupId } } } },
        select: { ...VIEW_COLUMNS, userId: true }
    });
    return rows.map((row) => ({ ...view(row), userId: row.userId }));
}

/** Everybody who has linked an account of this provider, for a people picker. */
export async function listConnectedAccounts(
    provider: string
): Promise<Array<ConnectionView & { userId: string; name: string; email: string }>> {
    const rows = await prisma.userConnection.findMany({
        where: { provider },
        select: { ...VIEW_COLUMNS, userId: true, user: { select: { name: true, email: true } } },
        orderBy: { label: "asc" }
    });
    return rows.map((row) => ({ ...view(row), userId: row.userId, name: row.user.name, email: row.user.email }));
}

function encryptCredential(credential: ConnectionCredential): {
    encryptedToken: Buffer;
    tokenNonce: Buffer;
    tokenKeyId: string;
} {
    const blob = encryptSecret(JSON.stringify(credential), loadEnv().POLARIS_MASTER_KEY);
    return { encryptedToken: blob.ciphertext, tokenNonce: blob.nonce, tokenKeyId: blob.keyId };
}

/**
 * Read a stored credential. Links carried over from the calendar table hold a
 * bare refresh token rather than a payload, so anything that is not an object is
 * read as one - the alternative would be asking those people to authorize again
 * for no reason they could see.
 */
function parseCredential(plain: string): ConnectionCredential {
    try {
        const parsed = JSON.parse(plain) as unknown;
        if (parsed && typeof parsed === "object") return parsed as ConnectionCredential;
    } catch {
        // not a payload; fall through
    }
    return { refreshToken: plain };
}
