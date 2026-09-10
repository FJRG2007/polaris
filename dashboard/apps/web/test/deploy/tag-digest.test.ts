/**
 * Asking a registry whether a tag moved, without spending a pull on it.
 *
 * Docker Hub counts every manifest GET against the anonymous pull limit of the
 * machine asking, and a HEAD not at all. The updates scan asks for every image
 * service every half hour, so which of the two it sends decides whether a real
 * deploy is later refused with "toomanyrequests".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imageKey, readTagDigest, resetRegistryCache } from "@/lib/registry";

interface Call {
    url: string;
    method: string;
    accept: string;
}

/** A registry that challenges once, then answers the manifest with or without its digest. */
function registry(options: { digestOnHead: boolean }): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
            const method = init?.method ?? "GET";
            calls.push({ url, method, accept: init?.headers?.accept ?? "" });
            if (url.startsWith("https://auth.docker.io/token")) {
                return new Response(JSON.stringify({ token: "anon" }), { status: 200 });
            }
            if (!init?.headers?.authorization) {
                return new Response(null, {
                    status: 401,
                    headers: {
                        "www-authenticate":
                            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"'
                    }
                });
            }
            const withDigest = method === "GET" || options.digestOnHead;
            return new Response(method === "HEAD" ? null : "{}", {
                status: 200,
                headers: withDigest ? { "docker-content-digest": "sha256:index" } : {}
            });
        })
    );
    return calls;
}

beforeEach(() => {
    resetRegistryCache();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("reading a tag's digest", () => {
    it("asks with HEAD only, for the index a pull would fetch", async () => {
        const calls = registry({ digestOnHead: true });
        await expect(readTagDigest("nginx", "1.27")).resolves.toBe("sha256:index");

        const manifests = calls.filter((call) => call.url.includes("/manifests/"));
        expect(manifests.map((call) => call.method)).toEqual(["HEAD", "HEAD"]);
        expect(manifests[0]?.url).toBe("https://registry-1.docker.io/v2/library/nginx/manifests/1.27");
        expect(manifests.every((call) => call.accept.includes("application/vnd.oci.image.index.v1+json"))).toBe(true);
    });

    it("asks in full only when the registry leaves the digest off a HEAD", async () => {
        const calls = registry({ digestOnHead: false });
        await expect(readTagDigest("nginx", "1.27")).resolves.toBe("sha256:index");
        const manifests = calls.filter((call) => call.url.includes("/manifests/"));
        expect(manifests.map((call) => call.method)).toEqual(["HEAD", "HEAD", "GET"]);
    });
});

describe("naming an image", () => {
    it("gives every way of writing a Docker Hub image one name", () => {
        const key = imageKey("nginx", "1.27");
        expect(imageKey("library/nginx", "1.27")).toBe(key);
        expect(imageKey("docker.io/library/nginx", "1.27")).toBe(key);
        expect(imageKey("docker.io/nginx", "1.27")).toBe(key);
        expect(imageKey("index.docker.io/library/nginx", "1.27")).toBe(key);
    });

    it("keeps other registries, repositories and tags apart", () => {
        expect(imageKey("ghcr.io/acme/nginx", "1.27")).not.toBe(imageKey("nginx", "1.27"));
        expect(imageKey("nginx", "1.28")).not.toBe(imageKey("nginx", "1.27"));
        expect(imageKey("GHCR.io/acme/api", "1")).toBe(imageKey("ghcr.io/acme/api", "1"));
        expect(imageKey("localhost:5000/api", "1")).toBe("localhost:5000/api:1");
    });
});
