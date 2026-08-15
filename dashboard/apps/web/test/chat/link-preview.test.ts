/**
 * Unfurling a link, which means the server fetching an address somebody typed.
 *
 * That is the most dangerous thing this app does, so most of what is asserted
 * here is what it refuses. Polaris runs on a machine with a LAN around it and,
 * on a hosted box, a metadata service one address away: an unfurl that followed
 * whatever it was given would be a request forgery with a login page in front of
 * it.
 *
 * The refusals that matter, in order of how often they are the way in:
 *
 * - a hostname that resolves to a private address;
 * - a hostname that resolves to several, one of which is private - checking only
 *   the first is the mistake that looks like a working check;
 * - a redirect from somewhere public to somewhere private, which is how a check
 *   on the first address alone is walked around.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** What DNS says, per hostname. */
let dns = new Map<string, string[]>();

/** Every address actually fetched, in order. */
let fetched: string[] = [];

/** Canned responses, by URL. */
let responses = new Map<string, { status: number; headers: Record<string, string>; body: string }>();

vi.mock("node:dns/promises", () => ({
    lookup: async (hostname: string) => {
        const addresses = dns.get(hostname);
        if (!addresses) throw new Error("not found");
        return addresses.map((address) => ({ address, family: 4 }));
    }
}));

const stored: { url: string; ok: boolean; title: string; imageUrl: string | null }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        linkPreview: {
            findUnique: async () => null,
            findMany: async () => [],
            upsert: async ({
                where,
                create
            }: {
                where: { url: string };
                create: { ok: boolean; title: string; imageUrl: string | null };
            }) => {
                stored.push({ url: where.url, ...create });
                return create;
            }
        }
    }
}));

const { unfurl } = await import("@/lib/chat/link-preview");
const { firstLink } = await import("@polaris/core");

function page(title: string): { status: number; headers: Record<string, string>; body: string } {
    return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<html><head><title>${title}</title><meta property="og:description" content="A page."></head></html>`
    };
}

beforeEach(() => {
    dns = new Map([
        ["example.com", ["93.184.216.34"]],
        ["evil.test", ["127.0.0.1"]],
        ["split.test", ["93.184.216.34", "10.0.0.5"]],
        ["redirector.test", ["93.184.216.34"]]
    ]);
    fetched = [];
    responses = new Map();
    stored.length = 0;

    vi.stubGlobal("fetch", async (input: URL | string) => {
        const address = String(input);
        fetched.push(address);
        const canned = responses.get(address);
        if (!canned) throw new Error("nothing there");
        return new Response(canned.body, { status: canned.status, headers: canned.headers });
    });
});

describe("where it will not go", () => {
    it("refuses a name that resolves to a private address", async () => {
        responses.set("http://evil.test/", page("Should never be read"));
        await unfurl("http://evil.test/");
        expect(fetched).toEqual([]);
        expect(stored[0]?.ok).toBe(false);
    });

    it("refuses a name that resolves to a public address and a private one", async () => {
        // The check that looks like it works: take the first address, decide,
        // then connect to whichever the stack picks.
        responses.set("http://split.test/", page("Should never be read"));
        await unfurl("http://split.test/");
        expect(fetched).toEqual([]);
    });

    it("refuses a private address written out as one", async () => {
        await unfurl("http://169.254.169.254/latest/meta-data/");
        expect(fetched).toEqual([]);
    });

    it("refuses a name that does not resolve at all", async () => {
        await unfurl("http://nowhere.test/");
        expect(fetched).toEqual([]);
    });

    it("refuses anything that is not http", async () => {
        await unfurl("file:///etc/passwd");
        await unfurl("ftp://example.com/x");
        expect(fetched).toEqual([]);
        expect(stored).toEqual([]);
    });

    it("refuses a link carrying credentials", async () => {
        // Fetching it would hand somebody's password to whatever answers.
        await unfurl("http://user:secret@example.com/");
        expect(fetched).toEqual([]);
    });
});

describe("redirects", () => {
    it("checks every hop, not just the first", async () => {
        responses.set("http://redirector.test/", {
            status: 302,
            headers: { location: "http://evil.test/admin" },
            body: ""
        });
        await unfurl("http://redirector.test/");
        // The first hop was fetched because it was allowed to be; the second was
        // not, which is the whole point.
        expect(fetched).toEqual(["http://redirector.test/"]);
        expect(stored[0]?.ok).toBe(false);
    });

    it("follows one to somewhere else public", async () => {
        responses.set("http://redirector.test/", {
            status: 301,
            headers: { location: "http://example.com/real" },
            body: ""
        });
        responses.set("http://example.com/real", page("The real page"));
        await unfurl("http://redirector.test/");
        expect(fetched).toEqual(["http://redirector.test/", "http://example.com/real"]);
        expect(stored[0]?.title).toBe("The real page");
    });
});

describe("what it reads back", () => {
    it("takes the title and the description", async () => {
        responses.set("http://example.com/", page("Hello &amp; welcome"));
        await unfurl("http://example.com/");
        expect(stored[0]?.ok).toBe(true);
        // Entities decoded, because this is going into a text node.
        expect(stored[0]?.title).toBe("Hello & welcome");
    });

    it("ignores something that is not a page", async () => {
        responses.set("http://example.com/file.zip", {
            status: 200,
            headers: { "content-type": "application/zip" },
            body: "PK"
        });
        await unfurl("http://example.com/file.zip");
        expect(stored[0]?.ok).toBe(false);
    });

    it("records a failure rather than leaving it to be retried forever", async () => {
        responses.set("http://example.com/gone", {
            status: 404,
            headers: { "content-type": "text/html" },
            body: ""
        });
        await unfurl("http://example.com/gone");
        expect(stored).toHaveLength(1);
        expect(stored[0]?.ok).toBe(false);
    });
});

describe("finding the link in the first place", () => {
    it("takes the first one", () => {
        expect(firstLink("see https://example.com and https://other.com")).toBe(
            "https://example.com"
        );
    });

    it("leaves the sentence's punctuation out of it", () => {
        expect(firstLink("look at https://example.com/a.")).toBe("https://example.com/a");
        expect(firstLink("(https://example.com)")).toBe("https://example.com");
    });

    it("ignores one inside code, which is quoted rather than linked", () => {
        expect(firstLink("```\ncurl https://example.com\n```")).toBeNull();
        expect(firstLink("run `curl https://example.com`")).toBeNull();
    });

    it("finds one after a code block", () => {
        expect(firstLink("```\ncode\n```\nand https://example.com")).toBe("https://example.com");
    });

    it("says nothing when there is nothing", () => {
        expect(firstLink("no links here")).toBeNull();
        expect(firstLink("ftp://example.com")).toBeNull();
    });
});
