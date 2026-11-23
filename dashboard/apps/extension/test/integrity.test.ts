import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { checkPage, forgetManifests, originPattern, readFiles } from "@/lib/integrity";

const ORIGIN = "https://polaris.example";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const STAMP = createHash("sha256").update(SHA).digest("hex").slice(0, 16);
const A = `sha256-${createHash("sha256").update("a").digest("base64")}`;
const B = `sha256-${createHash("sha256").update("b").digest("base64")}`;
const MANIFEST = {
    schema: 1,
    build: STAMP,
    prefixes: ["/_next/static/"],
    files: { "/_next/static/chunks/a.js": A }
};

function fetcher(answers: Record<string, Response | Error>) {
    return vi.fn(async (url: string) => {
        const answer = Object.entries(answers).find(([key]) => url.endsWith(key))?.[1];
        if (!answer) return new Response("", { status: 404 });
        if (answer instanceof Error) throw answer;
        return answer.clone();
    });
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe("page code check", () => {
    beforeEach(() => forgetManifests());

    it("verifies a page that matches its build's manifest", async () => {
        const fetch = fetcher({ "/api/version": json({ build: STAMP }), [`${STAMP}.json`]: json(MANIFEST) });
        const verdict = await checkPage(ORIGIN, [{ path: "/_next/static/chunks/a.js", digest: A }], fetch);
        expect(verdict).toEqual({ kind: "verified", build: STAMP, checked: 1 });
        // Taken from GitHub, never from the server it is checking.
        const manifestCall = fetch.mock.calls.find(([url]) => url.endsWith(`${STAMP}.json`));
        expect(manifestCall?.[0]).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
    });

    it("reports a changed file", async () => {
        const fetch = fetcher({ "/api/version": json({ build: STAMP }), [`${STAMP}.json`]: json(MANIFEST) });
        const verdict = await checkPage(ORIGIN, [{ path: "/_next/static/chunks/a.js", digest: B }], fetch);
        expect(verdict.kind).toBe("changed");
    });

    it("cannot verify an old server without a stamp, nor a build with no manifest", async () => {
        expect(await checkPage(ORIGIN, [], fetcher({ "/api/version": json({ build: null }) }))).toEqual({
            kind: "unverifiable",
            reason: "no-stamp"
        });
        expect(await checkPage(ORIGIN, [], fetcher({ "/api/version": new Response("", { status: 404 }) }))).toMatchObject({
            reason: "no-stamp"
        });
        const files = [{ path: "/_next/static/chunks/a.js", digest: A }];
        expect(await checkPage(ORIGIN, files, fetcher({ "/api/version": json({ build: STAMP }) }))).toEqual({
            kind: "unverifiable",
            reason: "no-manifest"
        });
    });

    it("treats a network failure as cannot verify, not as changed", async () => {
        const files = [{ path: "/_next/static/chunks/a.js", digest: B }];
        const fetch = fetcher({ "/api/version": json({ build: STAMP }), [`${STAMP}.json`]: new Error("offline") });
        expect((await checkPage(ORIGIN, files, fetch)).kind).toBe("unverifiable");
    });

    it("asks GitHub once per build", async () => {
        const fetch = fetcher({ "/api/version": json({ build: STAMP }), [`${STAMP}.json`]: json(MANIFEST) });
        const files = [{ path: "/_next/static/chunks/a.js", digest: A }];
        await checkPage(ORIGIN, files, fetch);
        await checkPage(ORIGIN, files, fetch);
        expect(fetch.mock.calls.filter(([url]) => url.endsWith(`${STAMP}.json`))).toHaveLength(1);
    });

    it("takes only well-formed files from a page", () => {
        expect(readFiles([{ path: "/a.js", digest: A }])).toEqual([{ path: "/a.js", digest: A }]);
        expect(readFiles([{ path: "a.js", digest: A }])).toBeNull();
        expect(readFiles("x")).toBeNull();
        expect(readFiles(Array.from({ length: 5_000 }, () => ({ path: "/a.js", digest: A })))).toBeNull();
    });

    it("registers on the server's host, any port", () => {
        expect(originPattern("https://polaris.example:8443")).toBe("https://polaris.example/*");
        expect(originPattern("ftp://x")).toBeNull();
    });
});
