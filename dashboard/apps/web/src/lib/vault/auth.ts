/**
 * Who is calling a vault endpoint.
 *
 * Every request from a Bitwarden client carries a bearer token this server
 * issued, and nothing else - no cookie, no Polaris session. So this is the one
 * place that turns a token into a person, and it re-checks on every request the
 * three things a token cannot carry safely: that the account still exists and is
 * not banned, that its credentials have not moved since the token was minted,
 * and that it is still allowed to use a vault at all.
 *
 * The stamp check is what makes a password change take effect everywhere at
 * once. A token is good for an hour, so without it, changing a master password
 * would leave every already-issued token working for the rest of that hour - on
 * a device somebody was changing the password because of.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { userHasPermission } from "@polaris/auth";
import { readAccessToken } from "@/lib/vault/tokens";

/** The account behind a vault request. */
export interface VaultPrincipal {
    userId: string;
    email: string;
    /** The device identifier the token was issued to, when it named one. */
    device: string | null;
}

/** The bearer token on a request, or null. */
function bearer(request: Request): string | null {
    const header = request.headers.get("authorization");
    if (!header) return null;
    const [scheme, value] = header.split(" ");
    if (!scheme || scheme.toLowerCase() !== "bearer" || !value) return null;
    return value.trim() || null;
}

/**
 * Resolve a vault request to the account behind it, or null when it may not
 * proceed. Callers answer a null with 401 and nothing else: which of the checks
 * refused is not something a caller should be able to tell apart.
 */
export async function authenticateVault(request: Request): Promise<VaultPrincipal | null> {
    const token = bearer(request);
    if (!token) return null;

    const claims = readAccessToken(token, loadEnv().POLARIS_AUTH_SECRET);
    if (!claims) return null;

    const account = await prisma.vaultAccount.findUnique({
        where: { userId: claims.sub },
        select: {
            securityStamp: true,
            user: { select: { email: true, bannedAt: true } }
        }
    });
    if (!account || account.user.bannedAt) return null;
    if (account.securityStamp !== claims.stamp) return null;
    // The instance can take the vault away from a role at any time, and a client
    // holding an hour-old token must not outlive that decision either.
    if (!(await userHasPermission(claims.sub, "vault.use"))) return null;

    return { userId: claims.sub, email: account.user.email, device: claims.device ?? null };
}

/** The shape every vault endpoint answers a refusal with. */
export function vaultUnauthorized(): Response {
    return Response.json({ message: "Unauthorized" }, { status: 401 });
}

/**
 * The error body Bitwarden clients read.
 *
 * They look for `message` and for `validationErrors`, and a client given a bare
 * status shows "an unknown error has occurred" instead of the reason - so every
 * refusal that a person could act on goes through here.
 */
export function vaultError(message: string, status = 400, field = ""): Response {
    return Response.json(
        {
            message,
            validationErrors: field ? { [field]: [message] } : {},
            errorModel: { message, object: "error" },
            object: "error"
        },
        { status }
    );
}
