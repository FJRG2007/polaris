/**
 * Reading the published image out of a registry.
 *
 * This is what an update check now rests on, so the parts worth pinning down are
 * the ones that decide whether a deployment is told the truth: that an anonymous
 * pull token is acquired from the challenge the registry actually sent, that a
 * multi-platform tag is followed to a real config rather than given up on, and
 * that an image with no build stamp reports none instead of something invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPublishedImage, resetRegistryCache } from "../../src/lib/registry";

const INDEX = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
        { digest: "sha256:arm", platform: { architecture: "arm64", os: "linux" } },
        { digest: "sha256:amd", platform: { architecture: "amd64", os: "linux" } }
    ]
};

const PLATFORM = { schemaVersion: 2, config: { digest: "sha256:config" } };

const CONFIG = {
    created: "2026-07-30T13:35:18.114714418Z",
    config: { Env: ["PATH=/usr/bin", "POLARIS_BUILD_SHA=2e2b0b4c24145cc43bcb224a6071d8f5d0a7815b"] }
};

/** A registry that challenges once, then serves the documents by URL. */
function registry(documents: Record<string, unknown>, options?: { digest?: string }) {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push(url);
        if (url.startsWith("https://ghcr.io/token")) {
            return new Response(JSON.stringify({ token: "anon-token" }), { status: 200 });
        }
        if (!init?.headers?.authorization) {
            return new Response("", {
                status: 401,
                headers: {
                    "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/p:pull"'
                }
            });
        }
        const body = documents[url];
        if (body === undefined) return new Response("", { status: 404 });
        return new Response(JSON.stringify(body), {
            status: 200,
            headers: options?.digest ? { "docker-content-digest": options.digest } : {}
        });
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
}

// The client remembers tokens and configs between calls on purpose, so each test
// starts from a process that has never reached a registry.
beforeEach(() => {
    resetRegistryCache();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("reading a published image", () => {
    it("follows a multi-platform tag to the amd64 config and reports its commit", async () => {
        const calls = registry(
            {
                "https://ghcr.io/v2/o/p/manifests/latest": INDEX,
                "https://ghcr.io/v2/o/p/manifests/sha256:amd": PLATFORM,
                "https://ghcr.io/v2/o/p/blobs/sha256:config": CONFIG
            },
            { digest: "sha256:index" }
        );

        const published = await readPublishedImage("ghcr.io/o/p", "latest");

        expect(published.buildSha).toBe("2e2b0b4c24145cc43bcb224a6071d8f5d0a7815b");
        expect(published.createdAt).toBe("2026-07-30T13:35:18.114714418Z");
        expect(published.digest).toBe("sha256:index");
        // The arm64 entry is never fetched: the dashboard image is amd64.
        expect(calls).not.toContain("https://ghcr.io/v2/o/p/manifests/sha256:arm");
    });

    it("acquires the anonymous token from the challenge it was sent", async () => {
        const calls = registry({
            "https://ghcr.io/v2/o/p/manifests/latest": INDEX,
            "https://ghcr.io/v2/o/p/manifests/sha256:amd": PLATFORM,
            "https://ghcr.io/v2/o/p/blobs/sha256:config": CONFIG
        });

        await readPublishedImage("ghcr.io/o/p", "latest");

        expect(calls[0]).toBe("https://ghcr.io/v2/o/p/manifests/latest");
        expect(calls[1]).toContain("https://ghcr.io/token?");
        expect(calls[1]).toContain("scope=repository%3Ao%2Fp%3Apull");
    });

    it("reports no commit for an image that carries no build stamp", async () => {
        registry({
            "https://ghcr.io/v2/o/p/manifests/latest": { schemaVersion: 2, config: { digest: "sha256:config" } },
            "https://ghcr.io/v2/o/p/blobs/sha256:config": { created: "2026-01-01T00:00:00Z", config: { Env: ["PATH=/bin"] } }
        });

        const published = await readPublishedImage("ghcr.io/o/p", "latest");

        expect(published.buildSha).toBeNull();
    });

    it("fails rather than guessing when the tag does not exist", async () => {
        registry({});
        await expect(readPublishedImage("ghcr.io/o/p", "missing")).rejects.toThrow(/404/);
    });
});

/**
 * A check the operator asked for goes to the registry every time - that is what
 * "check now" means - so what it costs is decided here. Five round trips over a
 * home connection is the difference between a button that answers and one that
 * looks broken, and four of the five are asking again for bytes that cannot have
 * changed since the last answer.
 */
describe("what a repeated check costs", () => {
    const DOCUMENTS = {
        "https://ghcr.io/v2/o/p/manifests/latest": INDEX,
        "https://ghcr.io/v2/o/p/manifests/sha256:amd": PLATFORM,
        "https://ghcr.io/v2/o/p/blobs/sha256:config": CONFIG
    };

    it("asks only whether the tag moved when it has not", async () => {
        const first = registry(DOCUMENTS, { digest: "sha256:index" });
        await readPublishedImage("ghcr.io/o/p", "latest");
        expect(first).toHaveLength(5);

        const second = registry(DOCUMENTS, { digest: "sha256:index" });
        const published = await readPublishedImage("ghcr.io/o/p", "latest");

        // One call: the manifest, whose digest is the whole question.
        expect(second).toEqual(["https://ghcr.io/v2/o/p/manifests/latest"]);
        expect(published.buildSha).toBe("2e2b0b4c24145cc43bcb224a6071d8f5d0a7815b");
    });

    it("reads the new image through when the tag does move", async () => {
        registry(DOCUMENTS, { digest: "sha256:index" });
        await readPublishedImage("ghcr.io/o/p", "latest");

        const moved = registry(
            {
                "https://ghcr.io/v2/o/p/manifests/latest": INDEX,
                "https://ghcr.io/v2/o/p/manifests/sha256:amd": PLATFORM,
                "https://ghcr.io/v2/o/p/blobs/sha256:config": {
                    created: "2026-08-01T00:00:00Z",
                    config: { Env: ["POLARIS_BUILD_SHA=9999999999999999999999999999999999999999"] }
                }
            },
            { digest: "sha256:next" }
        );
        const published = await readPublishedImage("ghcr.io/o/p", "latest");

        expect(published.buildSha).toBe("9999999999999999999999999999999999999999");
        expect(moved).toContain("https://ghcr.io/v2/o/p/blobs/sha256:config");
    });

    it("does not offer one repository's pull token for another", async () => {
        registry(DOCUMENTS, { digest: "sha256:index" });
        await readPublishedImage("ghcr.io/o/p", "latest");

        const other = registry(
            {
                "https://ghcr.io/v2/o/other/manifests/latest": INDEX,
                "https://ghcr.io/v2/o/other/manifests/sha256:amd": PLATFORM,
                "https://ghcr.io/v2/o/other/blobs/sha256:config": CONFIG
            },
            { digest: "sha256:other" }
        );
        await readPublishedImage("ghcr.io/o/other", "latest");

        // Challenged, because the token in hand is scoped to the other repository.
        expect(other[1]).toContain("https://ghcr.io/token?");
    });

    it("mints a fresh token when the registry refuses the one it held", async () => {
        registry(DOCUMENTS, { digest: "sha256:index" });
        await readPublishedImage("ghcr.io/o/p", "latest");

        // A registry that rejects the cached token once, then behaves.
        let refused = false;
        const calls: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
                calls.push(url);
                if (url.startsWith("https://ghcr.io/token")) {
                    return new Response(JSON.stringify({ token: "fresh-token" }), { status: 200 });
                }
                if (init?.headers?.authorization === "Bearer anon-token" && !refused) {
                    refused = true;
                    return new Response("", {
                        status: 401,
                        headers: {
                            "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/p:pull"'
                        }
                    });
                }
                const body = (DOCUMENTS as Record<string, unknown>)[url];
                if (body === undefined) return new Response("", { status: 404 });
                return new Response(JSON.stringify(body), {
                    status: 200,
                    headers: { "docker-content-digest": "sha256:later" }
                });
            })
        );

        const published = await readPublishedImage("ghcr.io/o/p", "latest");

        expect(published.buildSha).toBe("2e2b0b4c24145cc43bcb224a6071d8f5d0a7815b");
        expect(calls[1]).toContain("https://ghcr.io/token?");
    });
});
