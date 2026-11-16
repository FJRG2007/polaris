/**
 * Cloud accounts as AI providers: Amazon Bedrock, Azure OpenAI, Google Vertex
 * AI, Snowflake Cortex and DigitalOcean.
 *
 * Each needs more than one value (a key and its secret, an endpoint, a project
 * and a location), so none of them is a pasted key. They are kept in the same
 * encrypted model-key row a key is, on the provider's own slug, with this JSON
 * as the secret - the way a subscription login is (`provider-oauth.ts`). Only
 * this module and the chat clients (`polar/cloud-models.ts`) read it.
 *
 * Every address a credential names is held to the vendor's own domains here,
 * so a stored credential can never point a server-side request elsewhere.
 *
 * The methods and endpoints follow OpenCode's provider plugins
 * (`packages/core/src/plugin/provider/{amazon-bedrock,azure,google-vertex,
 * snowflake-cortex,digitalocean}.ts`, github.com/sst/opencode, MIT).
 *
 * Pure.
 */

import { z } from "zod";

export const CLOUD_PROVIDERS = ["amazon-bedrock", "azure", "google-vertex", "snowflake-cortex", "digitalocean"] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

export function isCloudProvider(slug: string): slug is CloudProvider {
    return (CLOUD_PROVIDERS as readonly string[]).includes(slug);
}

const text = (most: number) => z.string().trim().min(1).max(most);

/** `us-east-1`, `eu-central-2`, `us-gov-west-1`. */
export const awsRegionSchema = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}$/);

const bedrockSchema = z.discriminatedUnion("method", [
    z.object({
        provider: z.literal("amazon-bedrock"),
        method: z.literal("keys"),
        accessKeyId: z.string().trim().regex(/^(AKIA|ASIA)[A-Z0-9]{12,124}$/),
        secretAccessKey: text(256),
        sessionToken: z
            .string()
            .trim()
            .max(4096)
            .optional()
            .transform((value) => value || undefined),
        region: awsRegionSchema
    }),
    z.object({
        provider: z.literal("amazon-bedrock"),
        method: z.literal("api-key"),
        apiKey: text(4096),
        region: awsRegionSchema
    })
]);

/** The data-plane hosts Azure gives an OpenAI or AI Foundry resource. */
const AZURE_HOST = /^[a-z0-9][a-z0-9-]{1,62}\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/;
/** A resource name alone, as OpenCode's form takes it. */
const AZURE_RESOURCE = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}$/;

/** A resource name or its endpoint, as `https://<host>`; null when it is not
 *  one of Azure's own hosts. */
export function azureEndpoint(value: string): string | null {
    const trimmed = value.trim();
    if (AZURE_RESOURCE.test(trimmed)) return `https://${trimmed.toLowerCase()}.openai.azure.com`;
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    return AZURE_HOST.test(host) ? `https://${host}` : null;
}

const azureEndpointSchema = z.string().transform((value, ctx) => {
    const endpoint = azureEndpoint(value);
    if (!endpoint) ctx.addIssue({ code: "custom", message: "endpoint" });
    return endpoint ?? "";
});

/** Deployment names: letters, digits, `-`, `_` and `.`, as Azure allows. */
const deploymentsSchema = z
    .array(z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
    .max(100)
    .default([]);

const azureSchema = z.discriminatedUnion("method", [
    z.object({
        provider: z.literal("azure"),
        method: z.literal("key"),
        endpoint: azureEndpointSchema,
        apiKey: text(256),
        deployments: deploymentsSchema
    }),
    z.object({
        provider: z.literal("azure"),
        method: z.literal("entra"),
        endpoint: azureEndpointSchema,
        tenantId: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/),
        clientId: z.string().trim().uuid(),
        clientSecret: text(512),
        deployments: deploymentsSchema
    })
]);

/** The fields of a Google service-account key file that signing needs. Its
 *  `token_uri` is not taken: the token is always asked of Google's own. */
export const serviceAccountSchema = z.object({
    type: z.literal("service_account"),
    project_id: z.string().trim().min(1).max(128),
    private_key_id: z.string().trim().max(128).optional(),
    private_key: z.string().includes("PRIVATE KEY").max(8192),
    client_email: z.string().trim().email().max(320)
});

/** `global`, the multi-regions `us` and `eu`, or one region (`us-central1`). */
export const vertexLocationSchema = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(global|us|eu|[a-z]+-[a-z]+\d{1,2})$/);

const vertexSchema = z.object({
    provider: z.literal("google-vertex"),
    method: z.literal("service-account"),
    serviceAccount: serviceAccountSchema,
    project: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
    location: vertexLocationSchema
});

/** An account identifier as its host label takes it: the address pasted whole
 *  is cut back to the identifier, and `_` (an org-account name) is written as
 *  `-`, which is how Snowflake's own hostnames spell it. */
export function snowflakeAccount(value: string): string {
    return value
        .trim()
        .replace(/^https?:\/\//i, "")
        .replace(/\/.*$/, "")
        .replace(/\.snowflakecomputing\.com$/i, "")
        .replace(/_/g, "-")
        .toLowerCase();
}

const snowflakeSchema = z.object({
    provider: z.literal("snowflake-cortex"),
    method: z.literal("pat"),
    account: z
        .string()
        .transform(snowflakeAccount)
        .pipe(
            z
                .string()
                .max(255)
                .regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/)
        ),
    token: text(8192)
});

const digitaloceanSchema = z.discriminatedUnion("method", [
    z.object({ provider: z.literal("digitalocean"), method: z.literal("key"), token: text(4096) }),
    z.object({
        provider: z.literal("digitalocean"),
        method: z.literal("oauth"),
        token: text(4096),
        /** Epoch milliseconds. DigitalOcean's implicit grant hands back no refresh token. */
        expires: z.number().int().nonnegative()
    })
]);

/** What somebody types into a cloud account's form, normalised and checked. */
export const cloudCredentialSchema = z.union([
    bedrockSchema,
    azureSchema,
    vertexSchema,
    snowflakeSchema,
    digitaloceanSchema
]);
export type CloudCredential = z.infer<typeof cloudCredentialSchema>;

const storedSchema = z.object({ kind: z.literal("cloud"), credential: cloudCredentialSchema });

export function writeCloudSecret(credential: CloudCredential): string {
    return JSON.stringify({ kind: "cloud", credential });
}

/** The cloud credential a secret holds, or null for anything else. */
export function readCloudSecret(secret: string): CloudCredential | null {
    if (!secret.startsWith("{")) return null;
    try {
        const parsed = storedSchema.safeParse(JSON.parse(secret));
        return parsed.success ? parsed.data.credential : null;
    } catch {
        return null;
    }
}

/**
 * The one value an agent CLI could spend from its own variable
 * (`AWS_BEARER_TOKEN_BEDROCK`, `AZURE_API_KEY`, `SNOWFLAKE_CORTEX_PAT`,
 * `DIGITALOCEAN_ACCESS_TOKEN`), or null when the credential has none: AWS keys,
 * Entra client credentials and a Google service account are not a key.
 */
export function cloudBearer(credential: CloudCredential): string | null {
    switch (credential.provider) {
        case "amazon-bedrock":
            return credential.method === "api-key" ? credential.apiKey : null;
        case "azure":
            return credential.method === "key" ? credential.apiKey : null;
        case "google-vertex":
            return null;
        case "snowflake-cortex":
        case "digitalocean":
            return credential.token;
    }
}

/** What the key hint is made from: the bearer where there is one, otherwise
 *  the value that names the account (an access key id, a client id, the
 *  service account's key id). */
export function cloudHintSource(credential: CloudCredential): string {
    const bearer = cloudBearer(credential);
    if (bearer) return bearer;
    if (credential.provider === "amazon-bedrock" && credential.method === "keys") return credential.accessKeyId;
    if (credential.provider === "azure" && credential.method === "entra") return credential.clientId;
    if (credential.provider === "google-vertex") {
        return credential.serviceAccount.private_key_id || credential.serviceAccount.client_email;
    }
    return "";
}

/** The Vertex AI host for a location (OpenCode `google-vertex.ts` `vertexEndpoint`). */
export function vertexHost(location: string): string {
    if (location === "global") return "aiplatform.googleapis.com";
    if (location === "eu" || location === "us") return `aiplatform.${location}.rep.googleapis.com`;
    return `${location}-aiplatform.googleapis.com`;
}

/** Where a Snowflake account's Cortex chat API answers (OpenCode `snowflake-cortex.ts` `endpoint`). */
export function snowflakeBase(account: string): string {
    return `https://${account}.snowflakecomputing.com/api/v2/cortex/v1`;
}

/** DigitalOcean's serverless inference, as models.dev lists it. */
export const DIGITALOCEAN_BASE = "https://inference.do-ai.run/v1";

/** The Bedrock runtime host of a region. */
export function bedrockRuntimeHost(region: string): string {
    return `bedrock-runtime.${region}.amazonaws.com`;
}

// ---------------------------------------------------------------------------
// DigitalOcean sign-in
// ---------------------------------------------------------------------------

/** OpenCode's public DigitalOcean application (`digitalocean.ts`): an implicit
 *  grant that returns to a loopback address, so a self-hosted server can use
 *  it too - the browser lands on an address that does not open, and that
 *  address, carrying the token, is pasted back. */
export const DIGITALOCEAN_CLIENT_ID = "b1a6c5158156caac821fd1b30253ca8acb52454a48fa744420e41889cb589f82";
export const DIGITALOCEAN_AUTHORIZE = "https://cloud.digitalocean.com/v1/oauth/authorize";
export const DIGITALOCEAN_RETURN = "http://localhost:1456/auth/callback";
const DIGITALOCEAN_SCOPE = "genai:read inference:query";
/** OpenCode's fallback when DigitalOcean names no lifetime: thirty days. */
const DIGITALOCEAN_DEFAULT_LIFETIME_S = 60 * 60 * 24 * 30;

export function digitaloceanAuthorizeUrl(state: string): string {
    return `${DIGITALOCEAN_AUTHORIZE}?${new URLSearchParams({
        response_type: "token",
        client_id: DIGITALOCEAN_CLIENT_ID,
        redirect_uri: DIGITALOCEAN_RETURN,
        scope: DIGITALOCEAN_SCOPE,
        state
    })}`;
}

export type DigitaloceanReturn =
    | { ok: true; token: string; expires: number }
    | { ok: false; reason: "bad-paste" | "denied" };

/** The token in the address DigitalOcean returned to, checked against the
 *  state the sign-in started with. The grant puts it after `#`; a query is
 *  read too, for a browser that moved it. */
export function readDigitaloceanReturn(pasted: string, state: string, now: number): DigitaloceanReturn {
    let url: URL;
    try {
        url = new URL(pasted.trim());
    } catch {
        return { ok: false, reason: "bad-paste" };
    }
    const params = new URLSearchParams(url.hash.replace(/^#/, "") || url.search.replace(/^\?/, ""));
    if (params.get("error")) return { ok: false, reason: "denied" };
    const token = params.get("access_token");
    if (!token || params.get("state") !== state || token.length > 4096) return { ok: false, reason: "bad-paste" };
    const lifetime = Number.parseInt(params.get("expires_in") ?? "0", 10);
    const seconds = Number.isFinite(lifetime) && lifetime > 0 ? lifetime : DIGITALOCEAN_DEFAULT_LIFETIME_S;
    return { ok: true, token, expires: now + seconds * 1000 };
}
