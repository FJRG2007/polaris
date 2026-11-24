import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { WebContents } from "electron";
import { checkPageFiles, pageChanged } from "@/main/integrity";

const ORIGIN = "https://polaris.example";
const STAMP = createHash("sha256").update("0123456789abcdef0123456789abcdef01234567").digest("hex").slice(0, 16);
const digest = (text: string) => `sha256-${createHash("sha256").update(text).digest("base64")}`;
const MANIFEST = { schema: 1, build: STAMP, prefixes: ["/_next/static/"], files: { "/_next/static/a.js": digest("a") } };

/** A window whose session answers the server, GitHub and plain-http refetches. */
function contents(answers: Record<string, string>) {
    const fetch = vi.fn(async (url: string) => {
        const hit = Object.entries(answers).find(([key]) => url.endsWith(key));
        return hit ? new Response(hit[1]) : new Response("", { status: 404 });
    });
    return { contents: { session: { fetch } } as unknown as WebContents, fetch };
}

const server = { "/api/version": JSON.stringify({ build: STAMP }), [`${STAMP}.json`]: JSON.stringify(MANIFEST) };

describe("desktop page code check", () => {
    it("verifies a page that matches, and leaves the key lock open", async () => {
        const { contents: page, fetch } = contents(server);
        expect(await checkPageFiles(page, ORIGIN, [{ path: "/_next/static/a.js", digest: digest("a") }])).toMatchObject({ kind: "verified" });
        expect(pageChanged(page)).toBe(false);
        // The manifest comes from GitHub, through the window's own session.
        expect(fetch.mock.calls.some(([url]) => url.startsWith("https://raw.githubusercontent.com/"))).toBe(true);
    });

    it("marks a changed page so the key lock refuses it", async () => {
        const { contents: page } = contents(server);
        expect(await checkPageFiles(page, ORIGIN, [{ path: "/_next/static/a.js", digest: digest("b") }])).toMatchObject({ kind: "changed" });
        expect(pageChanged(page)).toBe(true);
    });

    it("hashes here what the page could not, as on plain http", async () => {
        const { contents: page } = contents({ ...server, "/_next/static/a.js": "b" });
        expect(await checkPageFiles(page, ORIGIN, [{ path: "/_next/static/a.js", digest: "" }])).toMatchObject({ kind: "changed" });
    });

    it("cannot verify an old server, and refuses a malformed list", async () => {
        const { contents: page } = contents({ "/api/version": JSON.stringify({ build: null }) });
        expect(await checkPageFiles(page, ORIGIN, [])).toEqual({ kind: "unverifiable", reason: "no-stamp" });
        expect(pageChanged(page)).toBe(false);
        expect(await checkPageFiles(page, ORIGIN, "nope")).toBeNull();
    });
});
