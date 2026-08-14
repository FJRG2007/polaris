/**
 * Signing a vault client in.
 *
 * This is the one endpoint a Bitwarden client hits before it has anything, and
 * the only credential it can present is a hash derived from the master password.
 * That makes it the account's soft underbelly: it is unauthenticated, it is
 * reachable from anywhere the deployment is, and a wrong answer is cheap to try
 * again. So the counting matters as much as the checking - failures are capped
 * per address AND per account, because either limit alone leaves the other
 * attack open.
 *
 * It is deliberately NOT a Polaris session. Signing into a vault client gives a
 * token that reaches the vault and nothing else; the dashboard has its own way
 * in, with its own rules.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import * as tokens from "@/lib/vault/tokens";
import { hashToken } from "@polaris/core/tokens";
import { recordAudit } from "@/lib/audit-service";
import { verifyVaultPassword } from "@/lib/vault/password";
import { userHasPermission, verifyTotpForUser } from "@polaris/auth";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";

/** Failures allowed from one address before it is turned away, and the window. */
const IP_LIMIT = 20;
const IP_WINDOW_MS = 15 * 60 * 1000;

/** Failures allowed against one account, wherever they come from. */
const ACCOUNT_LIMIT = 10;
const ACCOUNT_WINDOW_MS = 15 * 60 * 1000;

/** Second-factor codes allowed per sign-in attempt before it starts again. */
const SECOND_FACTOR_LIMIT = 6;

/** What a client sends to sign in. */
export interface SignInInput {
    email: string;
    masterPasswordHash: string;
    device?: { identifier: string; name: string; type: number };
    twoFactorToken?: string;
    twoFactorProvider?: number;
    /** Client-supplied, used only for the rate-limit key. */
    ipHash: string;
}

export type SignInResult =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; kind: "invalid" }
    | { ok: false; kind: "rate_limited" }
    | { ok: false; kind: "two_factor"; providers: number[] };

/** The organization claims a client reads off its token. */
async function orgClaims(userId: string) {
    const memberships = await prisma.vaultOrgUser.findMany({
        where: { userId, status: core.ORG_USER_CONFIRMED },
        select: { orgId: true, type: true }
    });
    const byRole = (type: number) =>
        memberships.filter((row) => row.type === type).map((row) => row.orgId);
    return {
        orgOwner: byRole(core.ORG_ROLE_OWNER),
        orgAdmin: byRole(core.ORG_ROLE_ADMIN),
        orgManager: byRole(core.ORG_ROLE_MANAGER),
        orgUser: byRole(core.ORG_ROLE_USER)
    };
}

/** Remember the client that just signed in, so its owner can recognize it. */
async function rememberDevice(
    userId: string,
    device: SignInInput["device"]
): Promise<string | null> {
    if (!device) return null;
    const row = await prisma.vaultDevice.upsert({
        where: { userId_identifier: { userId, identifier: device.identifier } },
        create: {
            userId,
            identifier: device.identifier,
            name: device.name,
            type: device.type
        },
        update: { name: device.name, type: device.type, revisionDate: new Date() },
        select: { id: true }
    });
    return row.id;
}

/** Everything a client needs to unlock, in the field names it reads. */
async function tokenBody(
    userId: string,
    deviceId: string | null,
    deviceIdentifier: string | null
): Promise<Record<string, unknown>> {
    const account = await prisma.vaultAccount.findUniqueOrThrow({
        where: { userId },
        select: {
            kdf: true,
            kdfIterations: true,
            kdfMemory: true,
            kdfParallelism: true,
            protectedKey: true,
            privateKey: true,
            securityStamp: true,
            user: { select: { name: true, email: true, emailVerified: true } }
        }
    });
    const env = loadEnv();
    const claims = await orgClaims(userId);
    const access = tokens.issueAccessToken(
        {
            sub: userId,
            email: account.user.email,
            emailVerified: account.user.emailVerified,
            name: account.user.name,
            stamp: account.securityStamp,
            device: deviceIdentifier ?? undefined,
            ...claims
        },
        env.POLARIS_AUTH_SECRET,
        env.POLARIS_APP_URL
    );
    const refresh = tokens.issueRefreshToken();
    await prisma.vaultRefreshToken.create({
        data: {
            userId,
            deviceId,
            tokenHash: refresh.hash,
            stamp: account.securityStamp,
            expiresAt: tokens.refreshTokenExpiry()
        }
    });

    return {
        access_token: access,
        expires_in: tokens.ACCESS_TOKEN_TTL_SECONDS,
        token_type: "Bearer",
        refresh_token: refresh.token,
        scope: "api offline_access",
        // The wrapped keys ride along so a client can unlock without a second
        // request, which is what makes the first screen after sign-in instant.
        Key: account.protectedKey,
        PrivateKey: account.privateKey,
        Kdf: account.kdf,
        KdfIterations: account.kdfIterations,
        KdfMemory: account.kdfMemory,
        KdfParallelism: account.kdfParallelism,
        ResetMasterPassword: false,
        ForcePasswordReset: false,
        MasterPasswordPolicy: null,
        UserDecryptionOptions: { HasMasterPassword: true, Object: "userDecryptionOptions" }
    };
}

/**
 * Sign in with a master password hash.
 *
 * Every refusal below returns the same `invalid` to the caller. An unknown
 * address, an account with no vault and a wrong password are three different
 * facts, and answering them differently would let anybody with the endpoint work
 * out which addresses have vaults here.
 */
export async function vaultSignIn(input: SignInInput): Promise<SignInResult> {
    const email = input.email.trim().toLowerCase();
    const addressKey = `vault-signin-ip:${input.ipHash}`;
    const accountKey = `vault-signin-account:${email}`;
    if (
        !(await rateLimit(addressKey, IP_LIMIT, IP_WINDOW_MS)).ok ||
        !(await rateLimit(accountKey, ACCOUNT_LIMIT, ACCOUNT_WINDOW_MS)).ok
    ) {
        return { ok: false, kind: "rate_limited" };
    }

    const account = await prisma.vaultAccount.findFirst({
        where: { user: { email } },
        select: {
            userId: true,
            masterPasswordHash: true,
            user: { select: { bannedAt: true, twoFactorEnabled: true } }
        }
    });
    if (!account || account.user.bannedAt) return { ok: false, kind: "invalid" };
    if (!(await verifyVaultPassword(account.masterPasswordHash, input.masterPasswordHash))) {
        return { ok: false, kind: "invalid" };
    }
    // The vault can be taken away from a role without the account being touched.
    if (!(await userHasPermission(account.userId, "vault.use"))) {
        return { ok: false, kind: "invalid" };
    }

    if (account.user.twoFactorEnabled) {
        if (!input.twoFactorToken) {
            return { ok: false, kind: "two_factor", providers: [core.TWO_FACTOR_AUTHENTICATOR] };
        }
        const codeKey = `vault-signin-2fa:${account.userId}:${input.ipHash}`;
        if (!(await rateLimit(codeKey, SECOND_FACTOR_LIMIT, ACCOUNT_WINDOW_MS)).ok) {
            return { ok: false, kind: "rate_limited" };
        }
        if (!(await verifyTotpForUser(account.userId, input.twoFactorToken))) {
            return { ok: false, kind: "two_factor", providers: [core.TWO_FACTOR_AUTHENTICATOR] };
        }
        await resetRateLimit(codeKey);
    }

    // Only a sign-in that got all the way through clears the counters: a correct
    // password with a wrong code must not reset the budget for guessing codes.
    await Promise.all([resetRateLimit(addressKey), resetRateLimit(accountKey)]);

    const deviceId = await rememberDevice(account.userId, input.device);
    await recordAudit({
        actorId: account.userId,
        action: "vault.signin",
        targetType: "vault",
        targetId: account.userId,
        metadata: { device: input.device?.name ?? null, type: input.device?.type ?? null }
    });
    return {
        ok: true,
        body: await tokenBody(account.userId, deviceId, input.device?.identifier ?? null)
    };
}

/**
 * Exchange a refresh token for a new access token.
 *
 * The token is rotated: the one presented is revoked and a new one issued, so a
 * refresh token copied off a machine stops working the moment the real client
 * uses its own. The stamp is re-checked too, which is what makes a password
 * change end a session that was only ever going to refresh.
 *
 * So are the two things sign-in checks that are not properties of the token: the
 * account can be banned, and the role behind it can lose `vault.use`. Either one
 * has to end the credential here as well, or a session already open keeps
 * rotating - and each rotation hands back the wrapped keys - for a month.
 */
export async function vaultRefresh(refreshToken: string): Promise<SignInResult> {
    const row = await prisma.vaultRefreshToken.findUnique({
        where: { tokenHash: hashToken(refreshToken) },
        select: {
            id: true,
            userId: true,
            deviceId: true,
            stamp: true,
            expiresAt: true,
            revokedAt: true,
            device: { select: { identifier: true } },
            vault: { select: { securityStamp: true, user: { select: { bannedAt: true } } } }
        }
    });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) {
        return { ok: false, kind: "invalid" };
    }
    if (row.stamp !== row.vault.securityStamp) return { ok: false, kind: "invalid" };
    if (row.vault.user.bannedAt) return { ok: false, kind: "invalid" };
    if (!(await userHasPermission(row.userId, "vault.use"))) {
        return { ok: false, kind: "invalid" };
    }

    await prisma.vaultRefreshToken.update({
        where: { id: row.id },
        data: { revokedAt: new Date() }
    });
    return {
        ok: true,
        body: await tokenBody(row.userId, row.deviceId, row.device?.identifier ?? null)
    };
}

/** The body a client reads when it needs a second factor. */
export function twoFactorChallengeBody(providers: number[]): Record<string, unknown> {
    return {
        error: "invalid_grant",
        error_description: "Two factor required.",
        // Both shapes: clients moved from a list of provider numbers to a map,
        // and which one they read depends on their age.
        TwoFactorProviders: providers.map(String),
        TwoFactorProviders2: Object.fromEntries(providers.map((provider) => [provider, null])),
        MasterPasswordPolicy: null
    };
}
