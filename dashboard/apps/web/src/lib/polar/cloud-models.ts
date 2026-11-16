/**
 * The chat clients for cloud accounts (`agents/cloud-credentials.ts`), and the
 * checks a new one is put through before it is stored.
 *
 *   - Amazon Bedrock: the Converse API (`@ai-sdk/amazon-bedrock`), with a
 *     Bedrock API key as a bearer or every request SigV4-signed here by
 *     `integrations/aws-sign.ts` from the access key.
 *   - Azure OpenAI / AI Foundry: the resource's v1 API, OpenAI's own shape,
 *     with an `api-key` header or an Entra token; the model is a deployment.
 *   - Google Vertex AI: Gemini on the `publishers/google` path, the same API
 *     Google AI speaks, with a service account's token as a bearer.
 *   - Snowflake Cortex and DigitalOcean: OpenAI-compatible endpoints, bearer.
 *
 * Server-only.
 */

import { z } from "zod";
import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogle } from "@ai-sdk/google";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { awsEncode, signAwsRequest } from "@/lib/integrations/aws-sign";
import { CloudTokenError, entraToken, googleServiceToken, type TokenFetch } from "@/lib/agents/cloud-tokens";
import {
    DIGITALOCEAN_BASE,
    bedrockRuntimeHost,
    readCloudSecret,
    snowflakeBase,
    vertexHost,
    type CloudCredential
} from "@/lib/agents/cloud-credentials";

type Bedrock = Extract<CloudCredential, { provider: "amazon-bedrock" }>;
type Azure = Extract<CloudCredential, { provider: "azure" }>;
type Vertex = Extract<CloudCredential, { provider: "google-vertex" }>;

/** Every model id a request path carries, as SigV4 signs it outside S3: each
 *  segment encoded once more than it is sent (`%3A` -> `%253A`). */
export function bedrockCanonicalPath(pathname: string): string {
    return pathname
        .split("/")
        .map((segment) => awsEncode(segment))
        .join("/");
}

function bodyText(body: RequestInit["body"]): string {
    if (body === undefined || body === null) return "";
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
    throw new Error("polar: Bedrock request body is not text");
}

/** A fetch that signs each Bedrock request with the account's access key, in
 *  place of the bearer the client was configured with. */
export function bedrockSigningFetch(
    credential: Extract<Bedrock, { method: "keys" }>,
    request: TokenFetch = (url, init) => fetch(url, init),
    clock: () => Date = () => new Date()
): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const body = bodyText(init?.body);
        const headers = new Headers(init?.headers);
        headers.delete("authorization");
        const signed = signAwsRequest({
            credentials: {
                accessKeyId: credential.accessKeyId,
                secretAccessKey: credential.secretAccessKey,
                region: credential.region,
                ...(credential.sessionToken ? { sessionToken: credential.sessionToken } : {})
            },
            service: "bedrock",
            host: url.host,
            method: init?.method ?? "GET",
            path: url.pathname,
            canonicalPath: bedrockCanonicalPath(url.pathname),
            query: url.search.replace(/^\?/, ""),
            body,
            contentType: headers.get("content-type") ?? "application/json",
            now: clock()
        });
        for (const [name, value] of Object.entries(signed.headers)) {
            if (name !== "host") headers.set(name, value);
        }
        return request(url.href, { ...init, headers, body: body || undefined });
    }) as typeof fetch;
}

function bedrockModel(credential: Bedrock, model: string): LanguageModel {
    if (credential.method === "api-key") {
        return createAmazonBedrock({ region: credential.region, apiKey: credential.apiKey })(model);
    }
    // The bearer is a placeholder the signing fetch replaces, so the client's
    // own signer never runs.
    return createAmazonBedrock({
        region: credential.region,
        apiKey: "sigv4",
        baseURL: `https://${bedrockRuntimeHost(credential.region)}`,
        fetch: bedrockSigningFetch(credential)
    })(model);
}

/** The header an Azure request authenticates with: the resource key, or an
 *  Entra token for the Cognitive Services scope. */
async function azureAuth(credential: Azure, request?: TokenFetch): Promise<[string, string]> {
    if (credential.method === "key") return ["api-key", credential.apiKey];
    return ["authorization", `Bearer ${await entraToken(credential, request)}`];
}

function azureFetch(credential: Azure): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.delete("authorization");
        const [name, value] = await azureAuth(credential);
        headers.set(name, value);
        return fetch(input, { ...init, headers });
    }) as typeof fetch;
}

function azureModel(credential: Azure, deployment: string): LanguageModel {
    return createOpenAI({
        name: "azure",
        baseURL: `${credential.endpoint}/openai/v1`,
        apiKey: "azure",
        fetch: azureFetch(credential)
    }).chat(deployment);
}

export function vertexBase(credential: Vertex): string {
    return `https://${vertexHost(credential.location)}/v1beta1/projects/${credential.project}/locations/${credential.location}/publishers/google`;
}

function vertexModel(credential: Vertex, model: string): LanguageModel {
    const fetchWithToken = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.delete("x-goog-api-key");
        headers.set("authorization", `Bearer ${await googleServiceToken(credential.serviceAccount)}`);
        return fetch(input, { ...init, headers });
    }) as typeof fetch;
    return createGoogle({ apiKey: "vertex", baseURL: vertexBase(credential), fetch: fetchWithToken })(model);
}

/**
 * Cortex's Chat Completions refuses `max_tokens` ("Error (deprecated)" in its
 * compatibility table, docs.snowflake.com/en/user-guide/snowflake-cortex/open_ai_sdk)
 * and takes `max_completion_tokens`, as OpenCode's plugin sets. Pure.
 */
export function snowflakeBody(body: Record<string, unknown>): Record<string, unknown> {
    if (!("max_tokens" in body)) return body;
    const { max_tokens: most, ...rest } = body;
    return most === undefined ? rest : { ...rest, max_completion_tokens: most };
}

/** The AI SDK model for a stored cloud credential's secret. */
export function cloudLanguageModel(secret: string, model: string): LanguageModel {
    const credential = readCloudSecret(secret);
    if (!credential) throw new Error("polar: unreadable cloud credential");
    switch (credential.provider) {
        case "amazon-bedrock":
            return bedrockModel(credential, model);
        case "azure":
            return azureModel(credential, model);
        case "google-vertex":
            return vertexModel(credential, model);
        case "snowflake-cortex":
            return createOpenAICompatible({
                name: "snowflake-cortex",
                baseURL: snowflakeBase(credential.account),
                apiKey: credential.token,
                transformRequestBody: snowflakeBody
            })(model);
        case "digitalocean":
            return createOpenAICompatible({ name: "digitalocean", baseURL: DIGITALOCEAN_BASE, apiKey: credential.token })(
                model
            );
    }
}

/**
 * Whether a catalogue model can be asked through this cloud account's client.
 * Vertex is reached on Google's own publisher path, so the partner models the
 * catalogue files under Vertex (Claude, Llama: `name@version`) are left out;
 * Azure lists its deployments instead of the catalogue. Pure.
 */
export function cloudListsModel(provider: string, model: string): boolean {
    if (provider === "google-vertex") return /^(gemini|gemma)/.test(model) && !model.includes("@");
    if (provider === "azure") return false;
    return true;
}

const deploymentsSchema = z.object({
    data: z.array(z.object({ id: z.string().min(1).max(128) })).max(1000)
});

export type CloudCheck =
    | { ok: true; credential: CloudCredential }
    | { ok: false; reason: "refused" | "unreachable" | "no-deployments" };

const CHECK_TIMEOUT_MS = 15_000;

async function asked(request: TokenFetch, url: string, headers: Record<string, string>): Promise<Response | null> {
    try {
        return await request(url, { headers, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    } catch {
        return null;
    }
}

/**
 * Put a new cloud credential to its vendor before it is stored, where a
 * request that cannot change anything exists: Entra and Google sign-ins are
 * exchanged for a token, Azure's deployments are listed (and kept, since they
 * are the models), and a DigitalOcean token lists the models it may call.
 * Bedrock and Snowflake have no such request that a key without extra
 * permissions may make, so they are stored as typed.
 */
export async function checkCloudCredential(
    credential: CloudCredential,
    request: TokenFetch = (url, init) => fetch(url, init)
): Promise<CloudCheck> {
    try {
        if (credential.provider === "google-vertex") {
            await googleServiceToken(credential.serviceAccount, request);
            return { ok: true, credential };
        }
        if (credential.provider === "digitalocean") {
            const response = await asked(request, `${DIGITALOCEAN_BASE}/models`, {
                authorization: `Bearer ${credential.token}`
            });
            if (!response) return { ok: false, reason: "unreachable" };
            if (response.status === 401 || response.status === 403) return { ok: false, reason: "refused" };
            return { ok: true, credential };
        }
        if (credential.provider === "azure") {
            const [name, value] = await azureAuth(credential, request);
            const response = await asked(request, `${credential.endpoint}/openai/deployments?api-version=2022-12-01`, {
                [name]: value
            });
            if (!response) return { ok: false, reason: "unreachable" };
            if (response.status === 401) return { ok: false, reason: "refused" };
            // An Entra application may be allowed to chat and not to list; the
            // deployments typed into the form are what it serves then.
            const listed = response.ok ? deploymentsSchema.safeParse(await response.json().catch(() => null)) : null;
            const names = listed?.success ? listed.data.data.map((entry) => entry.id) : [];
            const deployments = [...new Set([...credential.deployments, ...names])].slice(0, 100);
            if (deployments.length === 0) return { ok: false, reason: "no-deployments" };
            return { ok: true, credential: { ...credential, deployments } };
        }
        return { ok: true, credential };
    } catch (caught) {
        if (caught instanceof CloudTokenError) return { ok: false, reason: caught.reason };
        throw caught;
    }
}
