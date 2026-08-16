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

/**
 * Every address actually fetched, in order, and what the network answers with.
 *
 * Mocked at `undici` rather than at the global `fetch`, because that is what
 * `safe-fetch` calls: the runtime's own fetch refuses a dispatcher built by the
 * installed undici, so the module uses undici's fetch with undici's Agent. A
 * stub on the global would leave this suite green while every real request
 * failed.
 */
const network = vi.hoisted(() => ({
    fetched: [] as string[],
    responses: new Map<string, { status: number; headers: Record<string, string>; body: string }>()
}));

const fetched = network.fetched;
const responses = network.responses;

vi.mock("undici", () => ({
    Agent: class {},
    fetch: async (input: URL | string) => {
        const address = String(input);
        fetched.push(address);
        const canned = responses.get(address);
        if (!canned) throw new Error("nothing there");
        return new Response(canned.body, { status: canned.status, headers: canned.headers });
    }
}));

vi.mock("node:dns/promises", () => ({
    lookup: async (hostname: string) => {
        const addresses = dns.get(hostname);
        if (!addresses) throw new Error("not found");
        return addresses.map((address) => ({ address, family: 4 }));
    }
}));

interface Stored {
    url: string;
    ok: boolean;
    title: string;
    author: string;
    accent: string | null;
    imageUrl: string | null;
}

const stored: Stored[] = [];

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
                create: Omit<Stored, "url">;
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
    fetched.length = 0;
    responses.clear();
    stored.length = 0;
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

describe("a site that will not describe its own page", () => {
    // The case that mattered and was missing: youtube.com hands a plain fetch a
    // consent wall with no metadata in it, so the most posted link there is got
    // no card at all. oEmbed answers the same question, with no key.
    beforeEach(() => {
        dns.set("www.youtube.com", ["142.250.185.14"]);
    });

    const oembed = (body: unknown) => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });

    it("asks the site instead, and takes what it says", async () => {
        responses.set("https://www.youtube.com/watch?v=abc", {
            status: 200,
            headers: { "content-type": "text/html" },
            body: "<html><head></head></html>"
        });
        responses.set(
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc&format=json",
            oembed({
                title: "A video",
                author_name: "Somebody",
                provider_name: "YouTube",
                thumbnail_url: "https://i.ytimg.com/vi/abc/hqdefault.jpg"
            })
        );

        await unfurl("https://www.youtube.com/watch?v=abc");
        expect(stored[0]?.ok).toBe(true);
        expect(stored[0]?.title).toBe("A video");
        expect(stored[0]?.imageUrl).toBe("https://i.ytimg.com/vi/abc/hqdefault.jpg");
    });

    it("is asked as well as the page, for the one thing a page does not say", async () => {
        // Who made it. YouTube's own markup describes the video and not the
        // channel, and the channel is the second line of the card - so both are
        // asked and the page wins wherever they overlap.
        responses.set("https://www.youtube.com/watch?v=abc", page("The page said it"));
        responses.set(
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc&format=json",
            oembed({ title: "The site said it", author_name: "A channel" })
        );
        await unfurl("https://www.youtube.com/watch?v=abc");
        expect(stored[0]?.title).toBe("The page said it");
        expect(stored[0]?.author).toBe("A channel");
    });

    it("is not asked for a page whose site has no such endpoint", async () => {
        responses.set("http://example.com/", page("A page"));
        await unfurl("http://example.com/");
        expect(fetched).toEqual(["http://example.com/"]);
    });

    it("is not asked for a site that has no such endpoint", async () => {
        responses.set("http://example.com/", {
            status: 200,
            headers: { "content-type": "text/html" },
            body: "<html><head></head></html>"
        });
        await unfurl("http://example.com/");
        expect(fetched).toEqual(["http://example.com/"]);
        expect(stored[0]?.ok).toBe(false);
    });

    it("takes nothing from an answer with no title in it", async () => {
        responses.set("https://www.youtube.com/watch?v=abc", {
            status: 200,
            headers: { "content-type": "text/html" },
            body: "<html></html>"
        });
        responses.set(
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc&format=json",
            oembed({ author_name: "Somebody" })
        );
        await unfurl("https://www.youtube.com/watch?v=abc");
        expect(stored[0]?.ok).toBe(false);
    });
});

describe("the colour a site says it is", () => {
    const html = (head: string) => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<html><head><title>A page</title>${head}</head></html>`
    });

    it("takes the one in the site's own manifest", async () => {
        // The one that matters: YouTube's page says its theme colour is white,
        // because the page is white, and its manifest says red.
        const white = '<meta name="theme-color" content="rgba(255, 255, 255, 0.98)">';
        responses.set(
            "http://example.com/",
            html(`${white}<link rel="manifest" href="/app.webmanifest">`)
        );
        responses.set("http://example.com/app.webmanifest", {
            status: 200,
            headers: { "content-type": "application/manifest+json" },
            body: JSON.stringify({ theme_color: "#FF0033" })
        });
        await unfurl("http://example.com/");
        expect(stored[0]?.accent).toBe("#ff0033");
    });

    it("falls back to the tag when there is no manifest", async () => {
        responses.set("http://example.com/", html('<meta name="theme-color" content="#1E2327">'));
        await unfurl("http://example.com/");
        expect(stored[0]?.accent).toBe("#1e2327");
    });

    it("takes nothing it could not put in a style attribute", async () => {
        responses.set(
            "http://example.com/",
            html('<meta name="theme-color" content="red; background: url(x)">')
        );
        await unfurl("http://example.com/");
        expect(stored[0]?.accent).toBeNull();
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
