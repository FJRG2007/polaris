/**
 * Talking to Polaris, in the protocol it already answers.
 *
 * Polaris serves the Bitwarden client surface at `<origin>/vault` - that is how
 * the official clients work against it - so this extension adds no server code at
 * all. It signs in at `identity/connect/token`, reads everything from `api/sync`,
 * and asks `api/accounts/revision-date` whether there is anything new. Every
 * shape below was read off the server's own route table and handlers rather than
 * guessed from Bitwarden's documentation, because where the two differ it is this
 * server that has to be satisfied.
 *
 * Three of those differences matter here and are handled rather than discovered:
 * a second factor comes back as an HTTP 400 carrying a challenge, not as a 401;
 * too many attempts come back as 429 with `retry-after`, and a client that
 * treats that as a wrong password will lock the account out of its own budget;
 * and there is no `client_credentials` grant, so the only credential is the
 * master password - which is exactly why nothing here ever sees it in the clear.
 *
 * What travels is the hash the crypto module derives, never the password: see
 * `@polaris/vault-crypto`. This module does no cryptography of its own.
 *
 * Background worker only. Nothing on a page may hold a token, and nothing on a
 * page can reach these origins anyway: the vault surface answers no preflight,
 * so a call has to come from the extension's own context with the host permission
 * behind it.
 */

import { KDF_PBKDF2, type KdfSettings } from "@polaris/core";

/** How long a call may hang before it is somebody's problem rather than a wait. */
const TIMEOUT_MS = 20_000;

/** What the sign-in endpoint answers with, in the fields a client reads. */
export interface VaultToken {
    readonly accessToken: string;
    readonly refreshToken: string;
    /** When the access token stops being accepted, as a moment rather than a span. */
    readonly expiresAt: number;
    /** The account's own key, wrapped under the key derived from the master password. */
    readonly key: string;
    /** The private half of the pair other people's vault keys are wrapped to. */
    readonly privateKey: string | null;
    readonly kdf: KdfSettings;
}

/** Signing in either worked, needs a code, or is refused - each acted on differently. */
export type SignInResult =
    | { readonly ok: true; readonly token: VaultToken }
    | { readonly ok: false; readonly kind: "two_factor"; readonly providers: readonly number[] }
    | { readonly ok: false; readonly kind: "invalid" }
    | { readonly ok: false; readonly kind: "rate_limited"; readonly retryAfterMs: number }
    | { readonly ok: false; readonly kind: "unreachable" };

/** Everything one sync pass brought back, still encrypted. */
export interface SyncResponse {
    readonly profile: Record<string, unknown>;
    readonly folders: readonly Record<string, unknown>[];
    readonly collections: readonly Record<string, unknown>[];
    readonly ciphers: readonly Record<string, unknown>[];
    readonly sends: readonly Record<string, unknown>[];
}

/** The device number this browser reports itself as, from Polaris's own list. */
export function deviceType(): number {
    switch (import.meta.env.BROWSER) {
        case "firefox":
            return 3;
        case "opera":
            return 4;
        case "edge":
            return 5;
        default:
            return 2;
    }
}

function vaultUrl(base: string, path: string): string {
    return `${base}/${path}`;
}

/** A fetch that cannot hang forever, and that never throws at its caller. */
async function ask(url: string, init: RequestInit): Promise<Response | null> {
    const stop = AbortSignal.timeout(TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: stop, credentials: "omit" });
    } catch {
        return null;
    }
}

/**
 * How this address derives its key.
 *
 * Asked before the password is turned into anything, because the parameters are
 * the account's rather than the client's: an account moved to Argon2id, or one
 * whose iteration count was raised, derives a different key from the same
 * password, and a client that assumed the defaults would simply be wrong.
 */
export async function prelogin(base: string, email: string): Promise<KdfSettings | null> {
    const reply = await ask(vaultUrl(base, "identity/accounts/prelogin"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email })
    });
    if (!reply || !reply.ok) return null;
    const body = (await reply.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return null;
    const number = (value: unknown, fallback: number): number =>
        typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return {
        kdf: number(body["kdf"], KDF_PBKDF2),
        kdfIterations: number(body["kdfIterations"], 600_000),
        kdfMemory: typeof body["kdfMemory"] === "number" ? body["kdfMemory"] : undefined,
        kdfParallelism:
            typeof body["kdfParallelism"] === "number" ? body["kdfParallelism"] : undefined
    } as KdfSettings;
}

/** The fields the token endpoint reads, as it reads them. */
function tokenForm(fields: Record<string, string | undefined>): URLSearchParams {
    const form = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
        if (value !== undefined && value !== "") form.set(name, value);
    }
    return form;
}

function readToken(body: Record<string, unknown>): VaultToken | null {
    const access = body["access_token"];
    const refresh = body["refresh_token"];
    const key = body["Key"];
    if (typeof access !== "string" || typeof refresh !== "string" || typeof key !== "string") {
        return null;
    }
    const seconds = typeof body["expires_in"] === "number" ? body["expires_in"] : 3600;
    return {
        accessToken: access,
        refreshToken: refresh,
        // A minute short on purpose: a token that expires while a request is in
        // flight reads as a wrong password to anything that is not looking for it.
        expiresAt: Date.now() + Math.max(0, seconds - 60) * 1000,
        key,
        privateKey: typeof body["PrivateKey"] === "string" ? body["PrivateKey"] : null,
        kdf: {
            kdf: typeof body["Kdf"] === "number" ? body["Kdf"] : KDF_PBKDF2,
            kdfIterations:
                typeof body["KdfIterations"] === "number" ? body["KdfIterations"] : 600_000,
            kdfMemory: typeof body["KdfMemory"] === "number" ? body["KdfMemory"] : undefined,
            kdfParallelism:
                typeof body["KdfParallelism"] === "number" ? body["KdfParallelism"] : undefined
        } as KdfSettings
    };
}

/**
 * Sign in with the hash the crypto module derived, and say what happened.
 *
 * The password parameter is already `masterPasswordHash` - one PBKDF2 round over
 * the master key with the password as salt. The master password itself never
 * reaches this module, let alone the network.
 */
export async function signIn(
    base: string,
    input: {
        readonly email: string;
        readonly masterPasswordHash: string;
        readonly device: { readonly identifier: string; readonly name: string };
        readonly twoFactorToken?: string;
    }
): Promise<SignInResult> {
    const reply = await ask(vaultUrl(base, "identity/connect/token"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenForm({
            grant_type: "password",
            username: input.email,
            password: input.masterPasswordHash,
            scope: "api offline_access",
            client_id: "browser",
            deviceIdentifier: input.device.identifier,
            deviceName: input.device.name,
            deviceType: String(deviceType()),
            twoFactorToken: input.twoFactorToken,
            // The authenticator, the one provider this server answers with.
            twoFactorProvider: input.twoFactorToken ? "0" : undefined
        }).toString()
    });
    if (!reply) return { ok: false, kind: "unreachable" };

    if (reply.status === 429) {
        const header = Number(reply.headers.get("retry-after"));
        return {
            ok: false,
            kind: "rate_limited",
            retryAfterMs: (Number.isFinite(header) && header > 0 ? header : 900) * 1000
        };
    }

    const body = (await reply.json().catch(() => null)) as Record<string, unknown> | null;
    if (reply.ok && body) {
        const token = readToken(body);
        return token ? { ok: true, token } : { ok: false, kind: "invalid" };
    }

    // A second factor is a 400 carrying a challenge rather than a status of its
    // own, so the body is what tells the two apart - and getting this wrong means
    // telling somebody their password is wrong when it was right.
    const providers = body?.["TwoFactorProviders"] ?? body?.["TwoFactorProviders2"];
    if (providers) {
        const list = Array.isArray(providers)
            ? providers.map((value) => Number(value)).filter((value) => Number.isFinite(value))
            : Object.keys(providers as Record<string, unknown>).map((key) => Number(key));
        return { ok: false, kind: "two_factor", providers: list.length > 0 ? list : [0] };
    }
    return { ok: false, kind: "invalid" };
}

/**
 * Trade the refresh token for a new access token.
 *
 * The server rotates it - the one presented is revoked as the new one is issued -
 * so whatever comes back has to be stored in place of what was sent, and a
 * failure means this session is over rather than that it should be retried.
 */
export async function refresh(base: string, refreshToken: string): Promise<VaultToken | null> {
    const reply = await ask(vaultUrl(base, "identity/connect/token"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenForm({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: "browser"
        }).toString()
    });
    if (!reply || !reply.ok) return null;
    const body = (await reply.json().catch(() => null)) as Record<string, unknown> | null;
    return body ? readToken(body) : null;
}

/** Everything the account can see, still encrypted. */
export async function sync(base: string, accessToken: string): Promise<SyncResponse | null> {
    const reply = await ask(vaultUrl(base, "api/sync?excludeDomains=true"), {
        headers: { authorization: `Bearer ${accessToken}` }
    });
    if (!reply || !reply.ok) return null;
    const body = (await reply.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return null;
    const list = (value: unknown): Record<string, unknown>[] =>
        Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
    return {
        profile: (body["profile"] as Record<string, unknown>) ?? {},
        folders: list(body["folders"]),
        collections: list(body["collections"]),
        ciphers: list(body["ciphers"]),
        sends: list(body["sends"])
    };
}

/**
 * When the vault last changed, as a number of milliseconds.
 *
 * The cheap half of syncing: this is one row of the account rather than every
 * item it owns, so it is what a poll asks, and a full sync happens only when the
 * answer moved. The endpoint answers with a bare number rather than an object.
 */
export async function revisionDate(base: string, accessToken: string): Promise<number | null> {
    const reply = await ask(vaultUrl(base, "api/accounts/revision-date"), {
        headers: { authorization: `Bearer ${accessToken}` }
    });
    if (!reply || !reply.ok) return null;
    const text = await reply.text().catch(() => "");
    const moment = Number(text.trim());
    return Number.isFinite(moment) ? moment : null;
}
