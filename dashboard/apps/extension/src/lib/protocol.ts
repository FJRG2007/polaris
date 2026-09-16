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

/** A request waiting for somebody to approve it in the dashboard. */
export interface AuthorizationOpened {
    readonly userCode: string;
    /** This extension's own secret, sent on every poll. Never shown to anybody. */
    readonly deviceCode: string;
    readonly expiresAt: string;
    readonly pollMs: number;
}

/**
 * The shortest and longest wait this client will take from a server.
 *
 * The period arrives in the response body and is used as a timer, so it is a
 * number a server picks and this browser obeys: zero, a negative value or NaN
 * turns the wait into a loop that asks as fast as it can, which spends the claim
 * budget in seconds and reads as a request that ran out. The ceiling is the other
 * direction - a period longer than the request lives would collect nothing.
 */
const POLL_MIN_MS = 1000;
const POLL_MAX_MS = 30_000;

/** What to wait when the server did not say, or said something that is not a wait. */
export const DEFAULT_POLL_MS = 2000;

/** A period this client will actually wait, whatever the server said. */
function readPollMs(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_POLL_MS;
    return Math.min(Math.max(value, POLL_MIN_MS), POLL_MAX_MS);
}

/** Where that request stands, and what it carried if it was approved. */
export type AuthorizationClaim =
    | { readonly status: "pending" | "denied" | "expired" }
    | {
          readonly status: "approved";
          readonly token: VaultToken;
          /** The account's vault key, sealed to the public half this extension
           *  sent. Only this extension can open it. */
          readonly wrappedKey: string;
          /**
           * A credential for the account itself, so one approval is the whole of
           * it and nothing has to be signed in a second time.
           *
           * Optional because a Polaris older than the version that mints it says
           * nothing here, and because minting is best effort on that side: an
           * approval without it is still an approval, and the vault half works
           * either way. What is lost is only the extension knowing whose account
           * this is.
           */
          readonly accountKey?: string;
      };

/**
 * Ask to be let in by a browser that is already inside the vault.
 *
 * The alternative to asking for a master password in a popup, and strictly better
 * than one: what approves this is a Polaris session AND an unlocked vault, which
 * is more than the password alone proves. The public half goes out; the private
 * half never leaves this worker, so the key that comes back is sealed to something
 * only this extension holds.
 */
export async function openAuthorization(
    base: string,
    input: {
        readonly publicKey: string;
        readonly device: { readonly identifier: string; readonly name: string };
    }
): Promise<AuthorizationOpened | null> {
    const reply = await ask(vaultUrl(base, "identity/connect/authorize"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenForm({
            publicKey: input.publicKey,
            deviceIdentifier: input.device.identifier,
            deviceName: input.device.name,
            deviceType: String(deviceType())
        }).toString()
    });
    if (!reply || !reply.ok) return null;
    const body = (await reply.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return null;
    const userCode = body["userCode"];
    const deviceCode = body["deviceCode"];
    if (typeof userCode !== "string" || typeof deviceCode !== "string") return null;
    return {
        userCode,
        deviceCode,
        expiresAt: typeof body["expiresAt"] === "string" ? body["expiresAt"] : "",
        pollMs: readPollMs(body["pollMs"])
    };
}

/**
 * Ask whether it has been approved, and collect the credential when it has.
 *
 * A request still waiting answers 200 with a status rather than an error, because
 * "not yet" is the ordinary case and treating it as a failure would make the popup
 * give up on the first poll. Nothing at all means keep waiting, and that covers
 * every answer that is not the server's own verdict: an unreachable server, a
 * proxy's 502, and the 429 this endpoint returns when the polling budget is spent.
 * A request that is still alive server-side must not be ended by the road to it -
 * `expired` is reserved for a refusal the server actually gave.
 */
export async function claimAuthorization(
    base: string,
    deviceCode: string
): Promise<AuthorizationClaim | null> {
    const reply = await ask(vaultUrl(base, "identity/connect/authorize/claim"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenForm({ deviceCode }).toString()
    });
    if (!reply) return null;
    if (reply.status === 429 || reply.status >= 500) return null;
    const body = (await reply.json().catch(() => null)) as Record<string, unknown> | null;
    if (!reply.ok || !body) return { status: "expired" };

    const status = body["status"];
    if (status !== "approved") {
        return {
            status: status === "denied" ? "denied" : status === "pending" ? "pending" : "expired"
        };
    }
    const token = readToken(body);
    const wrappedKey = body["wrappedKey"];
    // An approval that arrived without either piece is not an approval this can
    // act on, and pretending otherwise would leave a signed-in extension that can
    // read nothing.
    if (!token || typeof wrappedKey !== "string") return { status: "expired" };
    // Taken when it is there and ignored when it is not: it is the one part of
    // an approval that a server may legitimately not send.
    const accountKey = body["accountKey"];
    return {
        status: "approved",
        token,
        wrappedKey,
        ...(typeof accountKey === "string" && accountKey !== "" ? { accountKey } : {})
    };
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
 * One new item, with every valuable leaf already encrypted.
 *
 * The shape is `cipherSchema` in `packages/core/src/schemas/vault.ts`, which is
 * what the server validates this against - read off that file rather than taken
 * from Bitwarden's documentation. `name` is required and has to look encrypted;
 * `organizationId` and `folderId` are omitted entirely rather than sent as null,
 * because the schema wants a uuid where they are present.
 */
export interface NewLogin {
    readonly type: number;
    readonly name: string;
    readonly login: {
        readonly username: string | null;
        readonly password: string | null;
        readonly uris?: readonly { readonly uri: string; readonly match: number | null }[];
    };
}

/**
 * Save a new item, and say what the server made of it.
 *
 * The status comes back rather than a bare failure because the three that happen
 * mean different things to whoever is looking at the popup: 401 is a session that
 * has ended, 400 is an item this client built wrong, and nothing at all is a
 * server that could not be reached.
 */
export async function createLogin(
    base: string,
    accessToken: string,
    item: NewLogin
): Promise<{ readonly ok: boolean; readonly status: number | null }> {
    const reply = await ask(vaultUrl(base, "api/ciphers"), {
        method: "POST",
        headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json"
        },
        body: JSON.stringify(item)
    });
    if (!reply) return { ok: false, status: null };
    return { ok: reply.ok, status: reply.status };
}

/**
 * Rewrite an item, which the vault only accepts whole.
 *
 * There is no endpoint for one field: `api/ciphers/:id/partial` takes the folder
 * and the star and nothing else, on purpose, because those are the only writes
 * that touch nothing encrypted. So a password change sends the entire item back.
 *
 * Which is why this takes the item as a loose record rather than a modelled shape.
 * What goes out is what `api/sync` sent, with the fields being changed replaced -
 * so notes, custom fields, a card's number, anything this extension does not read,
 * travel back untouched. Typing it here would mean listing every field, and any
 * field left off that list would be silently deleted from somebody's item the
 * first time they changed a password. The server's own schema drops what it does
 * not accept.
 *
 * `lastKnownRevisionDate` is what makes a stale write a refusal rather than an
 * overwrite: the server answers 409 when somebody else has saved since.
 */
export async function updateLogin(
    base: string,
    accessToken: string,
    id: string,
    item: Record<string, unknown>
): Promise<{ readonly ok: boolean; readonly status: number | null }> {
    const reply = await ask(vaultUrl(base, `api/ciphers/${encodeURIComponent(id)}`), {
        method: "PUT",
        headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json"
        },
        body: JSON.stringify(item)
    });
    if (!reply) return { ok: false, status: null };
    return { ok: reply.ok, status: reply.status };
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
