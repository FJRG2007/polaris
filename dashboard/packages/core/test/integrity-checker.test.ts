import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createIntegrityChecker, readFiles } from "../src/integrity";

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

describe("shared integrity checker", () => {

    it("verifies a page that matches its build's manifest", async () => {
        const fetch = fetcher({ "/api/version": json({ build: STAMP }), [`${STAMP}.json`]: json(MANIFEST) });
        const verdict = await createIntegrityChecker(fetch).check(ORIGIN, [{ path: "/_next/static/chunks/a.js", digest: A }]);
        expect(verdict).toEqual({ kind: "verified", build: STAMP, checked: 1 });
        // Taken from GitHub, never from the server it is checking.
        const manifestCall = fetch.mock.calls.find(([url]) => url.endsWith(`${STAMP}.json`));
        expect(manifestCall?.[0]).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
    });

    it("reports a changed file", async () => {
        const fetch = fetcher({ "/api/version": json({ build: STAMP }), [`${STAMP}.json`]: json(MANIFEST) });
        const verdict = await createIntegrityChecker(fetch).check(ORIGIN, [{ path: "/_next/static/chunks/a.js", digest: B }]);
        expect(verdict.kind).toBe("changed");
    });

    it("cannot verify an old server without a stamp, nor a build with no manifest", async () => {
        expect(await createIntegrityChecker(fetcher({ "/api/version": json({ build: null }) })).check(ORIGIN, [])).toEqual({
            kind: "unverifiable",
            reason: "no-stamp"
        });
        expect(await createIntegrityChecker(fetcher({ "/api/version": new Response("", { status: 404 }) })).check(ORIGIN, [])).toMatchObject({
            reason: "no-stamp"
        });
        const files = [{ path: "/_next/static/chunks/a.js", digest: A }];
        expect(await createIntegrityChecker(fetcher({ "/api/version": json({ build: STAMP }) })).check(ORIGIN, files)).toEqual({
            kind: "unverifiable",
            reason: "no-manifest"
        });
    });

    it("treats a network failure as cannot verify, not as changed", async () => {
        const files = [{ path: "/_next/static/chunks/a.js", digest: B }];
        const fetch = fetcher({ "/api/version": json({ build: STAMP }), [`${STAMP}.json`]: new Error("offline") });
        expect((await createIntegrityChecker(fetch).check(ORIGIN, files)).kind).toBe("unverifiable");
    });

    it("asks GitHub once per build", async () => {
        const fetch = fetcher({ "/api/version": json({ build: STAMP }), [`${STAMP}.json`]: json(MANIFEST) });
        const files = [{ path: "/_next/static/chunks/a.js", digest: A }];
        const checker = createIntegrityChecker(fetch);
        await checker.check(ORIGIN, files);
        await checker.check(ORIGIN, files);
        expect(fetch.mock.calls.filter(([url]) => url.endsWith(`${STAMP}.json`))).toHaveLength(1);
    });

    it("takes only well-formed files from a page", () => {
        expect(readFiles([{ path: "/a.js", digest: A }])).toEqual([{ path: "/a.js", digest: A }]);
        expect(readFiles([{ path: "a.js", digest: A }])).toBeNull();
        expect(readFiles("x")).toBeNull();
        expect(readFiles(Array.from({ length: 5_000 }, () => ({ path: "/a.js", digest: A })))).toBeNull();
    });
});

describe("a page judged against its own build (BUG-0039)", () => {
    const OLD = createHash("sha256").update("previous build").digest("hex").slice(0, 16);
    const UNKNOWN = createHash("sha256").update("no such build").digest("hex").slice(0, 16);
    const C = `sha256-${createHash("sha256").update("c").digest("base64")}`;
    // The previous build had a chunk the current one no longer serves.
    const OLD_MANIFEST = {
        schema: 1,
        build: OLD,
        prefixes: ["/_next/static/"],
        files: { "/_next/static/chunks/a.js": A, "/_next/static/chunks/97829.old.js": C }
    };
    const updated = () =>
        fetcher({
            "/api/version": json({ build: STAMP }),
            [`${STAMP}.json`]: json(MANIFEST),
            [`${OLD}.json`]: json(OLD_MANIFEST)
        });
    const oldChunk = { path: "/_next/static/chunks/97829.old.js", digest: C };

    it("calls a genuine page of the previous build outdated, not changed", async () => {
        const checker = createIntegrityChecker(updated());
        // Without the page's build this is the false alarm the owner saw.
        expect(await checker.check(ORIGIN, [oldChunk])).toMatchObject({ kind: "changed", build: STAMP });
        expect(await checker.check(ORIGIN, [oldChunk], OLD)).toEqual({ kind: "outdated", build: OLD, current: STAMP, checked: 1 });
    });

    it("still warns about a changed file in the current build", async () => {
        const verdict = await createIntegrityChecker(updated()).check(ORIGIN, [{ path: "/_next/static/chunks/a.js", digest: B }], STAMP);
        expect(verdict).toEqual({ kind: "changed", build: STAMP, paths: ["/_next/static/chunks/a.js"] });
    });

    it("still warns about a changed file on a page that claims an older build", async () => {
        const checker = createIntegrityChecker(updated());
        expect(await checker.check(ORIGIN, [{ ...oldChunk, digest: B }], OLD)).toEqual({
            kind: "changed",
            build: OLD,
            paths: ["/_next/static/chunks/97829.old.js"]
        });
        // A file the old build never had, under a prefix it owns whole.
        expect(await checker.check(ORIGIN, [oldChunk, { path: "/_next/static/chunks/extra.js", digest: A }], OLD)).toMatchObject({
            kind: "changed",
            paths: ["/_next/static/chunks/extra.js"]
        });
    });

    it("judges a page naming a build with no manifest against the server's build", async () => {
        const checker = createIntegrityChecker(updated());
        expect(await checker.check(ORIGIN, [oldChunk], UNKNOWN)).toMatchObject({ kind: "changed", build: STAMP });
        expect(await checker.check(ORIGIN, [{ path: "/_next/static/chunks/a.js", digest: A }], UNKNOWN)).toEqual({
            kind: "verified",
            build: STAMP,
            checked: 1
        });
        // Not a stamp at all: as a page that names none.
        expect(await checker.check(ORIGIN, [oldChunk], "../../etc")).toMatchObject({ kind: "changed", build: STAMP });
    });

    it("cannot verify when its own build's manifest cannot be fetched", async () => {
        const fetch = fetcher({ "/api/version": json({ build: STAMP }), [`${STAMP}.json`]: json(MANIFEST), [`${OLD}.json`]: new Error("offline") });
        expect(await createIntegrityChecker(fetch).check(ORIGIN, [oldChunk], OLD)).toEqual({ kind: "unverifiable", reason: "no-manifest" });
    });

    it("verifies the offline copy against its own build when the server answers no build", async () => {
        const fetch = fetcher({ "/api/version": new Error("down"), [`${OLD}.json`]: json(OLD_MANIFEST) });
        expect(await createIntegrityChecker(fetch).check(ORIGIN, [oldChunk], OLD)).toEqual({ kind: "verified", build: OLD, checked: 1 });
    });
});
