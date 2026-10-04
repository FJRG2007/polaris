/**
 * The apps that may ask a person for access: how they come to be known, and how
 * one proves it is itself at the token endpoint.
 *
 * Two ways in, because the clients this is for do not agree on one:
 *
 *   - Dynamic Client Registration (RFC 7591). VS Code, Cursor and Gemini CLI
 *     register themselves and document nothing else. Anybody can call it, so
 *     what it accepts is capped, and a registration nobody ever approved is
 *     removed after a day.
 *   - Client ID Metadata Documents. Claude, ChatGPT and Codex name themselves by
 *     an https address that serves their metadata, which is read here (through
 *     the same vetted fetch every server-side request to a typed address uses)
 *     and kept for a day.
 *
 * Neither is trusted for anything but the redirect addresses: a name is the
 * app's own claim, and the consent screen shows it beside the address the code
 * will be sent to, which is the part that is checked.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as fetcher from "@/lib/safe-fetch";
import { parseStringList, stringifyList } from "@polaris/core";
import { generateToken, hashToken, tokenMatchesHash } from "@polaris/core/tokens";
import { MAX_URI_LENGTH, TOKEN_AUTH_METHODS, acceptableRedirectUri, type TokenAuthMethod } from "./urls";

/** A client as the rest of the flow reads it. */
export interface OAuthClientRecord {
    readonly id: string;
    readonly clientId: string;
    readonly name: string;
    readonly clientUri: string | null;
    readonly redirectUris: string[];
    readonly tokenAuthMethod: TokenAuthMethod;
    readonly secretHash: string | null;
    readonly source: "registered" | "metadata";
}

/** Public half of a registered client's id. */
const CLIENT_ID_PREFIX = "pmc_";
/** A client secret, for the rare app that asks for one. */
const CLIENT_SECRET_PREFIX = "pms_";

/** How many redirect addresses one app may register. Every client this is for
 *  needs one or two. */
export const MAX_REDIRECT_URIS = 10;
/** How long a name is kept. Shown on a consent screen, so it has to fit one. */
export const MAX_CLIENT_NAME = 100;
/** A registration that was never used for an approval is removed after this. */
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
/** A metadata document is read again once it is older than this. */
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
/** The most of a metadata document that is read. */
const METADATA_MAX_BYTES = 16 * 1024;

type Row = {
    id: string;
    clientId: string;
    name: string;
    clientUri: string | null;
    redirectUris: string;
    tokenAuthMethod: string;
    secretHash: string | null;
    source: string;
    fetchedAt?: Date | null;
};

function record(row: Row): OAuthClientRecord {
    return {
        id: row.id,
        clientId: row.clientId,
        name: row.name,
        clientUri: row.clientUri,
        redirectUris: parseStringList(row.redirectUris),
        tokenAuthMethod: (TOKEN_AUTH_METHODS as readonly string[]).includes(row.tokenAuthMethod)
            ? (row.tokenAuthMethod as TokenAuthMethod)
            : "none",
        secretHash: row.secretHash,
        source: row.source === "metadata" ? "metadata" : "registered"
    };
}

/**
 * A name as it may be shown: trimmed, control and formatting characters gone,
 * whitespace collapsed, cut to length. What an app calls itself is written by
 * whoever registered it, so it is text to be displayed and nothing more.
 */
export function cleanClientName(value: unknown): string {
    if (typeof value !== "string") return "";
    return value
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_CLIENT_NAME);
}

/** An app's home page, kept only when it is https. */
function cleanClientUri(value: unknown): string | null {
    if (typeof value !== "string" || value.length > MAX_URI_LENGTH) return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
    } catch {
        return null;
    }
}

/** What a registration request may carry (RFC 7591 section 2). Unknown fields
 *  are ignored, as the RFC says they must be. */
export const registrationSchema = z.object({
    redirect_uris: z.array(z.string().max(MAX_URI_LENGTH)).min(1).max(MAX_REDIRECT_URIS),
    client_name: z.string().max(1000).optional(),
    client_uri: z.string().max(MAX_URI_LENGTH).optional(),
    token_endpoint_auth_method: z.string().max(64).optional(),
    grant_types: z.array(z.string().max(64)).max(10).optional(),
    response_types: z.array(z.string().max(64)).max(10).optional(),
    scope: z.string().max(4096).optional()
});

/** A registration refused, in the RFC's words. */
export interface RegistrationRefusal {
    readonly error: "invalid_redirect_uri" | "invalid_client_metadata";
    readonly description: string;
}

/** What a successful registration answers with (RFC 7591 section 3.2.1). */
export interface RegistrationResult {
    readonly client_id: string;
    readonly client_id_issued_at: number;
    readonly client_name: string;
    readonly redirect_uris: string[];
    readonly grant_types: string[];
    readonly response_types: string[];
    readonly token_endpoint_auth_method: TokenAuthMethod;
    readonly client_secret?: string;
    readonly client_secret_expires_at?: number;
}

const GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);

/**
 * Check a registration request. Pure: what is stored is decided here, and the
 * caller only writes it.
 */
export function checkRegistration(
    body: unknown
):
    | { ok: true; name: string; clientUri: string | null; redirectUris: string[]; method: TokenAuthMethod }
    | { ok: false; refusal: RegistrationRefusal } {
    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const onRedirects = issue?.path[0] === "redirect_uris";
        return {
            ok: false,
            refusal: {
                error: onRedirects ? "invalid_redirect_uri" : "invalid_client_metadata",
                description: onRedirects
                    ? `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} addresses`
                    : `${issue?.path.join(".") || "body"}: ${issue?.message ?? "not valid"}`
            }
        };
    }
    const input = parsed.data;
    const redirectUris = [...new Set(input.redirect_uris)];
    for (const uri of redirectUris) {
        if (!acceptableRedirectUri(uri)) {
            return {
                ok: false,
                refusal: {
                    error: "invalid_redirect_uri",
                    description: "Every redirect URI must be https, or http to localhost, 127.0.0.1 or [::1], with no fragment"
                }
            };
        }
    }
    const method = input.token_endpoint_auth_method ?? "none";
    if (!(TOKEN_AUTH_METHODS as readonly string[]).includes(method)) {
        return {
            ok: false,
            refusal: {
                error: "invalid_client_metadata",
                description: `token_endpoint_auth_method must be one of ${TOKEN_AUTH_METHODS.join(", ")}`
            }
        };
    }
    if (input.grant_types?.some((grant) => !GRANT_TYPES.has(grant))) {
        return {
            ok: false,
            refusal: {
                error: "invalid_client_metadata",
                description: "grant_types may only be authorization_code and refresh_token"
            }
        };
    }
    if (input.response_types?.some((type) => type !== "code")) {
        return {
            ok: false,
            refusal: { error: "invalid_client_metadata", description: "response_types may only be code" }
        };
    }
    return {
        ok: true,
        name: cleanClientName(input.client_name),
        clientUri: cleanClientUri(input.client_uri),
        redirectUris,
        method: method as TokenAuthMethod
    };
}

/** Register an app that has already passed `checkRegistration`. */
export async function registerClient(input: {
    name: string;
    clientUri: string | null;
    redirectUris: string[];
    method: TokenAuthMethod;
}): Promise<RegistrationResult> {
    // The cleanup rides on the next registration rather than a job of its own:
    // registrations are what makes rows, so they are also what bounds them.
    await prisma.oAuthClient
        .deleteMany({
            where: {
                source: "registered",
                createdAt: { lt: new Date(Date.now() - UNUSED_CLIENT_TTL_MS) },
                grants: { none: {} }
            }
        })
        .catch(() => undefined);

    const clientId = `${CLIENT_ID_PREFIX}${generateToken().slice(0, 32)}`;
    const secret = input.method === "none" ? null : `${CLIENT_SECRET_PREFIX}${generateToken()}`;
    const created = await prisma.oAuthClient.create({
        data: {
            clientId,
            name: input.name,
            clientUri: input.clientUri,
            redirectUris: stringifyList(input.redirectUris),
            tokenAuthMethod: input.method,
            secretHash: secret ? hashToken(secret) : null,
            source: "registered"
        },
        select: { createdAt: true }
    });
    return {
        client_id: clientId,
        client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
        client_name: input.name,
        redirect_uris: input.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: input.method,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {})
    };
}

/**
 * Whether a client_id is a metadata document's address: https, with a path,
 * and nothing that would make two spellings of it the same document.
 */
export function metadataDocumentUrl(clientId: string): URL | null {
    if (clientId.length > MAX_URI_LENGTH || !clientId.startsWith("https://")) return null;
    const url = fetcher.safeUrl(clientId, MAX_URI_LENGTH);
    if (!url || url.protocol !== "https:" || url.hash || url.pathname === "/") return null;
    return url;
}

/** What a metadata document has to say. */
const metadataSchema = z.object({
    client_id: z.string().max(MAX_URI_LENGTH),
    client_name: z.string().max(1000).optional(),
    client_uri: z.string().max(MAX_URI_LENGTH).optional(),
    redirect_uris: z.array(z.string().max(MAX_URI_LENGTH)).min(1).max(MAX_REDIRECT_URIS),
    token_endpoint_auth_method: z.string().max(64).optional()
});

/**
 * Check a fetched metadata document against the address it came from. Pure.
 *
 * The document's client_id has to be that address exactly - otherwise any page
 * could claim to be any app - and every redirect address has to be one this
 * server would accept from a registration. Only public clients: a document that
 * says it authenticates with a key pair is one this server cannot verify, so it
 * is refused rather than treated as if it said `none`.
 */
export function checkMetadataDocument(
    address: string,
    body: unknown
): { name: string; clientUri: string | null; redirectUris: string[] } | null {
    const parsed = metadataSchema.safeParse(body);
    if (!parsed.success || parsed.data.client_id !== address) return null;
    const method = parsed.data.token_endpoint_auth_method ?? "none";
    if (method !== "none") return null;
    const redirectUris = [...new Set(parsed.data.redirect_uris)];
    if (!redirectUris.every((uri) => acceptableRedirectUri(uri))) return null;
    return {
        name: cleanClientName(parsed.data.client_name),
        clientUri: cleanClientUri(parsed.data.client_uri),
        redirectUris
    };
}

/** Read a metadata document from its address, or null when it cannot be had. */
async function fetchMetadataDocument(url: URL): Promise<unknown> {
    try {
        const response = await fetcher.configuredRequest(
            url.toString(),
            { method: "GET", headers: { accept: "application/json" }, timeoutMs: fetcher.FETCH_TIMEOUT_MS },
            { allowPrivate: false }
        );
        // No redirects: the document is the one at the address the app named.
        if (response.status !== 200) return null;
        const bytes = await fetcher.readCapped(
            response as unknown as Parameters<typeof fetcher.readCapped>[0],
            METADATA_MAX_BYTES
        );
        if (!bytes) return null;
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
        return null;
    }
}

const SELECT = {
    id: true,
    clientId: true,
    name: true,
    clientUri: true,
    redirectUris: true,
    tokenAuthMethod: true,
    secretHash: true,
    source: true,
    fetchedAt: true
} as const;

/** A client this server already knows, without reading anything remote. */
export async function storedClient(clientId: string): Promise<OAuthClientRecord | null> {
    if (!clientId || clientId.length > MAX_URI_LENGTH) return null;
    const row = await prisma.oAuthClient.findUnique({ where: { clientId }, select: SELECT });
    return row ? record(row) : null;
}

/**
 * The client an authorization request names. A metadata document is read when
 * it has not been, or not for a day; a copy that cannot be refreshed is kept
 * rather than locking its app out because its host was briefly down.
 */
export async function resolveClient(clientId: string): Promise<OAuthClientRecord | null> {
    if (!clientId || clientId.length > MAX_URI_LENGTH) return null;
    const row = await prisma.oAuthClient.findUnique({ where: { clientId }, select: SELECT });
    const address = metadataDocumentUrl(clientId);
    if (!address) return row && row.source === "registered" ? record(row) : null;

    const fresh = row?.fetchedAt && Date.now() - row.fetchedAt.getTime() < METADATA_TTL_MS;
    if (row && fresh) return record(row);

    const document = checkMetadataDocument(clientId, await fetchMetadataDocument(address));
    if (!document) return row ? record(row) : null;
    const saved = await prisma.oAuthClient.upsert({
        where: { clientId },
        create: {
            clientId,
            name: document.name,
            clientUri: document.clientUri,
            redirectUris: stringifyList(document.redirectUris),
            tokenAuthMethod: "none",
            source: "metadata",
            fetchedAt: new Date()
        },
        update: {
            name: document.name,
            clientUri: document.clientUri,
            redirectUris: stringifyList(document.redirectUris),
            fetchedAt: new Date()
        },
        select: SELECT
    });
    return record(saved);
}

/**
 * The client presenting itself at the token or revocation endpoint, or null
 * when it is unknown or its secret is wrong. A public client proves nothing
 * here - PKCE and the refresh token's binding to it are what protect it.
 */
export async function authenticateClient(credentials: {
    clientId: string | null;
    secret: string | null;
}): Promise<OAuthClientRecord | null> {
    if (!credentials.clientId) return null;
    const client = await storedClient(credentials.clientId);
    if (!client) return null;
    if (client.tokenAuthMethod === "none") return client;
    if (!credentials.secret || !client.secretHash) return null;
    return tokenMatchesHash(credentials.secret, client.secretHash) ? client : null;
}
