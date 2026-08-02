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

/**
 * Anonymous pull tokens, keyed by the repository they are good for.
 *
 * Every request to a registry that has not been given one is answered with a 401
 * carrying the challenge, so a client with no token pays two round trips for the
 * first call and one for the rest. Holding the token turns that into one round
 * trip for all of them. They are short-lived by design (the registry states the
 * lifetime; five minutes is the usual default), and they carry no privilege
 * beyond pulling a public image, which is what an anonymous client already has.
 *
 * Keyed by `host/repository` - the thing a pull token is scoped to - so a token
 * minted for one image is never offered for another.
 */
const tokens = new Map<string, { value: string; expiresAt: number }>();

function cachedToken(scope: string): string | null {
    const entry = tokens.get(scope);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        tokens.delete(scope);
        return null;
    }
    return entry.value;
}

/** Immutable-by-identity registry reads, keyed by content digest.
 *
 *  An image config is addressed BY the hash of its own bytes, so a digest that
 *  has been read once can never mean anything else and re-fetching it is pure
 *  latency. The whole update check is "did this tag move", and on the common
 *  answer - no - this turns the two calls behind the tag into zero. */
const configs = new Map<string, PublishedImage>();

/** A digest cache with no eviction grows with every release; a deployment sees
 *  few, and this keeps the map from being unbounded on a long-lived process. */
const MAX_CACHED_CONFIGS = 32;

/** Forget every cached token and config. Nothing in the product needs this - a
 *  token expires and a digest cannot go stale - but a test that asserts on the
 *  calls a check makes has to start from a client that has never talked to a
 *  registry, which is the state a fresh process is in. */
export function resetRegistryCache(): void {
    tokens.clear();
    configs.clear();
}

function rememberConfig(digest: string, image: PublishedImage): void {
    if (configs.size >= MAX_CACHED_CONFIGS) {
        const oldest = configs.keys().next().value;
        if (oldest) configs.delete(oldest);
    }
    configs.set(digest, image);
}

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

const tokenSchema = z.object({
    token: z.string().optional(),
    access_token: z.string().optional(),
    expires_in: z.number().optional()
});

async function anonymousToken(
    challenge: { realm: string; params: URLSearchParams },
    scope: string
): Promise<string | null> {
    const response = await fetch(`${challenge.realm}?${challenge.params.toString()}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const parsed = tokenSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    const value = parsed.data.token ?? parsed.data.access_token ?? null;
    if (!value) return null;
    // Retire it early: a token that expires mid-check costs a retry, and the
    // registry's stated lifetime is a ceiling, not a promise about clock skew.
    const lifetime = Math.max(0, (parsed.data.expires_in ?? 300) - 30) * 1000;
    tokens.set(scope, { value, expiresAt: Date.now() + lifetime });
    return value;
}

/**
 * GET a registry path, acquiring an anonymous pull token when challenged.
 *
 * The token is offered up front when one has already been minted for this
 * repository, because the alternative is a guaranteed 401 on the first call of
 * every check. A challenge that arrives anyway is still honoured, and a token
 * the registry rejects is dropped so the retry mints a fresh one - an expired
 * token costs a round trip, never the check.
 */
async function registryGet(
    host: string,
    path: string,
    accept: string,
    token: { value: string | null },
    scope: string
): Promise<Response> {
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
    // A token that was sent and refused is stale; one that was never sent leaves
    // whatever is cached alone, since this 401 says nothing about it.
    if (token.value) tokens.delete(scope);
    token.value = await anonymousToken(challenge, scope);
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
    const scope = `${host}/${repository}`;
    const token = { value: cachedToken(scope) };

    const head = await registryGet(host, `/v2/${repository}/manifests/${encodeURIComponent(tag)}`, ACCEPT, token, scope);
    if (!head.ok) throw new Error(`the registry answered ${head.status} for ${image}:${tag}`);
    const digest = head.headers.get("docker-content-digest");

    // The tag's digest IS the answer to "has this moved". A digest already read
    // describes bytes that cannot have changed, so the platform manifest and the
    // config blob behind it are not fetched again - which is every call but the
    // one after a release.
    if (digest) {
        const seen = configs.get(digest);
        if (seen) return seen;
    }

    const index = manifestSchema.parse(await head.json());

    // A multi-platform tag points at one manifest per architecture; the dashboard
    // image is amd64, and any single entry with a config is better than failing.
    let config = index.config?.digest ?? null;
    if (!config && index.manifests?.length) {
        const entry =
            index.manifests.find((item) => item.platform?.architecture === "amd64" && item.platform?.os === "linux") ??
            index.manifests[0];
        if (!entry) throw new Error("the registry returned an empty manifest list");
        const platform = await registryGet(host, `/v2/${repository}/manifests/${entry.digest}`, ACCEPT, token, scope);
        if (!platform.ok) throw new Error(`the registry answered ${platform.status} for a platform manifest`);
        config = manifestSchema.parse(await platform.json()).config?.digest ?? null;
    }
    if (!config) throw new Error("the published image carries no config to read");

    // Blob reads redirect to the registry's storage backend; fetch follows that.
    const blob = await registryGet(host, `/v2/${repository}/blobs/${config}`, "application/json", token, scope);
    if (!blob.ok) throw new Error(`the registry answered ${blob.status} for the image config`);
    const parsed = configSchema.parse(await blob.json());
    const stamped = (parsed.config?.Env ?? []).find((entry) => entry.startsWith("POLARIS_BUILD_SHA="));

    const published: PublishedImage = {
        digest,
        buildSha: stamped ? stamped.slice("POLARIS_BUILD_SHA=".length).trim() || null : null,
        createdAt: parsed.created ?? null
    };
    if (digest) rememberConfig(digest, published);
    return published;
}
