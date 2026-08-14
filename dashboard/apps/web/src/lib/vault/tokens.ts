/**
 * The tokens the vault's identity endpoint issues.
 *
 * Bitwarden clients expect an OAuth2-shaped answer: a JWT access token and an
 * opaque refresh token. The JWT is not a Polaris session and must never become
 * one - it is read by clients for the claims inside it (who they are, which
 * organizations they are in, whether their credentials have moved), and it is
 * checked here on every vault request.
 *
 * Signed with HMAC-SHA256 using the app secret, by hand, rather than by adding a
 * JWT library: signing one fixed claim set is a dozen lines of node:crypto, and
 * the alternative is a dependency in the path of every vault request. Clients do
 * not verify the signature - they cannot, they have no key - so the signature
 * exists for this server to trust its own tokens.
 *
 * Refresh tokens are random and stored hashed, like every other token Polaris
 * hands out: a database dump yields no working session.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { generateToken, hashToken } from "@polaris/core/tokens";

/** How long an access token is good for. Clients refresh well before this. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** How long a client can go without signing in again. */
export const REFRESH_TOKEN_TTL_DAYS = 30;

/** The claims a Bitwarden client reads out of its access token. */
export interface VaultTokenClaims {
    /** The Polaris user id. */
    sub: string;
    email: string;
    emailVerified: boolean;
    name: string;
    /** The account's security stamp when the token was issued. */
    stamp: string;
    /** The device this was issued to, as the client identified it. */
    device?: string;
    /** Organization ids by the role held in each, which is how clients decide
     *  what to offer without a second request. */
    orgOwner?: string[];
    orgAdmin?: string[];
    orgManager?: string[];
    orgUser?: string[];
}

/** What was found inside a valid token. */
export interface VaultTokenPayload extends VaultTokenClaims {
    exp: number;
}

function encodeSegment(value: object): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(data: string, secret: string): string {
    return createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * Mint an access token.
 *
 * The claim names are Bitwarden's, not Polaris's: `sstamp`, `premium`, `amr` and
 * the four `org*` claims are what a client looks for, and renaming any of them
 * would leave the client working from defaults it invented.
 */
export function issueAccessToken(claims: VaultTokenClaims, secret: string, issuer: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = encodeSegment({ alg: "HS256", typ: "JWT" });
    const body = encodeSegment({
        nbf: now,
        exp: now + ACCESS_TOKEN_TTL_SECONDS,
        iss: issuer,
        sub: claims.sub,
        email: claims.email,
        email_verified: claims.emailVerified,
        name: claims.name,
        // Self-hosted Polaris has no paid tier, and a client told otherwise hides
        // features (attachments, TOTP) that work here.
        premium: true,
        sstamp: claims.stamp,
        ...(claims.device ? { device: claims.device } : {}),
        ...(claims.orgOwner?.length ? { orgowner: claims.orgOwner } : {}),
        ...(claims.orgAdmin?.length ? { orgadmin: claims.orgAdmin } : {}),
        ...(claims.orgManager?.length ? { orgmanager: claims.orgManager } : {}),
        ...(claims.orgUser?.length ? { orguser: claims.orgUser } : {}),
        scope: ["api", "offline_access"],
        amr: ["Application"]
    });
    const data = `${header}.${body}`;
    return `${data}.${sign(data, secret)}`;
}

/**
 * Read an access token, or null when it is not one this server issued, has been
 * tampered with, or has expired. Nothing is trusted out of it before the
 * signature is checked.
 */
export function readAccessToken(token: string, secret: string): VaultTokenPayload | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts as [string, string, string];

    const expected = Buffer.from(sign(`${header}.${body}`, secret));
    const presented = Buffer.from(signature);
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;

    try {
        const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
            string,
            unknown
        >;
        const exp = typeof claims.exp === "number" ? claims.exp : 0;
        if (exp <= Math.floor(Date.now() / 1000)) return null;
        if (typeof claims.sub !== "string" || typeof claims.sstamp !== "string") return null;
        return {
            sub: claims.sub,
            email: typeof claims.email === "string" ? claims.email : "",
            emailVerified: claims.email_verified === true,
            name: typeof claims.name === "string" ? claims.name : "",
            stamp: claims.sstamp,
            device: typeof claims.device === "string" ? claims.device : undefined,
            exp
        };
    } catch {
        return null;
    }
}

/**
 * A refresh token, and the hash to store against it.
 *
 * Hashed with the same helper every other Polaris link token uses: 256 bits of
 * entropy needs a fast digest, not a KDF, and a shared implementation is one
 * fewer place for "we hash tokens before storing them" to be forgotten.
 */
export function issueRefreshToken(): { token: string; hash: string } {
    const token = generateToken();
    return { token, hash: hashToken(token) };
}

/** When a refresh token issued now stops working. */
export function refreshTokenExpiry(): Date {
    return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
