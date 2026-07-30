/**
 * Read-only OCI registry client, used for one question: which commit is the
 * image that a deployment would pull right now built from?
 *
 * That question is the whole update check. A commit landing on the release branch
 * is not an update - CI still has to build and publish the image, which takes
 * minutes - so the registry, not git, is what can say an update exists. Reading it
 * needs no credentials: the anonymous pull token flow is handled here.
 *
 * Everything read here is untrusted third-party JSON, so each response is parsed
 * against a schema and anything unexpected fails as "unknown" rather than being
 * trusted.
 */

import { z } from "zod";

/** The published image behind a tag. */
export interface PublishedImage {
    /** Manifest digest of the tag - the identity of what a pull would fetch. */
    readonly digest: string | null;
    /** Commit the image was built from (POLARIS_BUILD_SHA), when it carries one. */
    readonly buildSha: string | null;
    /** When the image was built (ISO 8601), when the config records it. */
    readonly createdAt: string | null;
}

/** Registry calls sit in a page render, so none of them may hang. */
const TIMEOUT_MS = 6000;

/** Manifest media types we can read, most preferred first. */
const ACCEPT = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json"
].join(", ");

/** A manifest list entry, or the single-platform manifest's config reference. */
const manifestSchema = z.object({
    manifests: z
        .array(
            z.object({
                digest: z.string(),
                platform: z
                    .object({ architecture: z.string().optional(), os: z.string().optional() })
                    .optional()
            })
        )
        .optional(),
    config: z.object({ digest: z.string() }).optional()
});

const configSchema = z.object({
    created: z.string().optional(),
    config: z.object({ Env: z.array(z.string()).optional() }).optional()
});

/** Split "ghcr.io/owner/name" into its registry host and repository path. */
function splitImage(image: string): { host: string; repository: string } {
    const [first, ...rest] = image.split("/");
    // A first segment carrying a dot or a port is a registry host; without one the
    // reference is a Docker Hub short name, which lives under library/.
    if (first && rest.length > 0 && /[.:]/.test(first)) return { host: first, repository: rest.join("/") };
    return { host: "registry-1.docker.io", repository: rest.length > 0 ? image : `library/${image}` };
}

/**
 * Parameters of a `Bearer` challenge, so the anonymous pull token is requested
 * for exactly the scope the registry asked for instead of one we guessed.
 */
function parseChallenge(header: string): { realm: string; params: URLSearchParams } | null {
    if (!/^bearer /i.test(header)) return null;
    const params = new URLSearchParams();
    let realm = "";
    for (const part of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) {
        const [, key, value] = part;
        if (!key) continue;
        if (key === "realm") realm = value ?? "";
        else params.set(key, value ?? "");
    }
    return realm ? { realm, params } : null;
}

const tokenSchema = z.object({ token: z.string().optional(), access_token: z.string().optional() });

async function anonymousToken(challenge: { realm: string; params: URLSearchParams }): Promise<string | null> {
    const response = await fetch(`${challenge.realm}?${challenge.params.toString()}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const parsed = tokenSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    return parsed.data.token ?? parsed.data.access_token ?? null;
}

/**
 * GET a registry path, acquiring an anonymous pull token when challenged. The
 * token is minted per client (they are short-lived and free), so nothing here
 * holds registry state.
 */
async function registryGet(host: string, path: string, accept: string, token: { value: string | null }): Promise<Response> {
    const url = `https://${host}${path}`;
    const send = (): Promise<Response> =>
        fetch(url, {
            headers: {
                accept,
                "user-agent": "polaris-dashboard",
                ...(token.value ? { authorization: `Bearer ${token.value}` } : {})
            },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });

    let response = await send();
    if (response.status !== 401) return response;
    const challenge = parseChallenge(response.headers.get("www-authenticate") ?? "");
    if (!challenge) return response;
    token.value = await anonymousToken(challenge);
    if (!token.value) return response;
    response = await send();
    return response;
}

/**
 * What the registry currently serves for `image:tag`. Throws when the registry
 * cannot be read or answers something unrecognizable - the caller reports the
 * check as failed rather than guessing that a deployment is current.
 */
export async function readPublishedImage(image: string, tag: string): Promise<PublishedImage> {
    const { host, repository } = splitImage(image);
    const token = { value: null as string | null };

    const head = await registryGet(host, `/v2/${repository}/manifests/${encodeURIComponent(tag)}`, ACCEPT, token);
    if (!head.ok) throw new Error(`the registry answered ${head.status} for ${image}:${tag}`);
    const digest = head.headers.get("docker-content-digest");
    const index = manifestSchema.parse(await head.json());

    // A multi-platform tag points at one manifest per architecture; the dashboard
    // image is amd64, and any single entry with a config is better than failing.
    let config = index.config?.digest ?? null;
    if (!config && index.manifests?.length) {
        const entry =
            index.manifests.find((item) => item.platform?.architecture === "amd64" && item.platform?.os === "linux") ??
            index.manifests[0];
        if (!entry) throw new Error("the registry returned an empty manifest list");
        const platform = await registryGet(host, `/v2/${repository}/manifests/${entry.digest}`, ACCEPT, token);
        if (!platform.ok) throw new Error(`the registry answered ${platform.status} for a platform manifest`);
        config = manifestSchema.parse(await platform.json()).config?.digest ?? null;
    }
    if (!config) throw new Error("the published image carries no config to read");

    // Blob reads redirect to the registry's storage backend; fetch follows that.
    const blob = await registryGet(host, `/v2/${repository}/blobs/${config}`, "application/json", token);
    if (!blob.ok) throw new Error(`the registry answered ${blob.status} for the image config`);
    const parsed = configSchema.parse(await blob.json());
    const stamped = (parsed.config?.Env ?? []).find((entry) => entry.startsWith("POLARIS_BUILD_SHA="));

    return {
        digest,
        buildSha: stamped ? stamped.slice("POLARIS_BUILD_SHA=".length).trim() || null : null,
        createdAt: parsed.created ?? null
    };
}
