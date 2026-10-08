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
    target: string | null;
    ok: boolean;
    title: string;
    siteName: string;
    author: string;
    accent: string | null;
    imageUrl: string | null;
    details?: string | null;
}

const stored: Stored[] = [];

/** A row already there, for the cases about what is looked at again. */
const rows = vi.hoisted(() => ({
    existing: null as null | {
        ok?: boolean;
        url?: string;
        target?: string | null;
        fetchedAt?: Date;
        imageUrl?: string | null;
    },
    updates: [] as Array<{ where: unknown; data: { fetchedAt: Date } }>
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        linkPreview: {
            findUnique: async () => rows.existing,
            updateMany: async (args: {
                where: { fetchedAt?: { lt: Date } };
                data: { fetchedAt: Date };
            }) => {
                rows.updates.push(args);
                const before = args.where.fetchedAt?.lt;
                const at = rows.existing?.fetchedAt;
                if (before && at && at >= before) return { count: 0 };
                if (rows.existing) rows.existing = { ...rows.existing, ...args.data };
                return { count: 1 };
            },
            findMany: async () => [],
            upsert: async ({
                where,
                create
            }: {
                where: { url: string };
                create: Omit<Stored, "url">;
            }) => {
                stored.push({ url: where.url, ...create });
                // The row read back afterwards is the one just written.
                if (rows.existing) rows.existing = { ...rows.existing, ...create, url: where.url };
                return create;
            }
        }
    }
}));

const { previewImage, unfurl } = await import("@/lib/chat/link-preview");
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
    rows.existing = null;
    rows.updates.length = 0;
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
        responses.set("https://www.youtube.com/watch?v=abc", {
            status: 200,
            headers: { "content-type": "text/html" },
            body: '<html><head><meta property="og:title" content="The page said it"></head></html>'
        });
        responses.set(
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc&format=json",
            oembed({ title: "The site said it", author_name: "A channel" })
        );
        await unfurl("https://www.youtube.com/watch?v=abc");
        expect(stored[0]?.title).toBe("The page said it");
        expect(stored[0]?.author).toBe("A channel");
    });

    it("prefers what the site says over a page that only has a title tag", async () => {
        // TikTok's video pages, to anything but a browser: "TikTok - Make Your
        // Day" and no og: tags, for every video there is.
        responses.set("https://www.youtube.com/watch?v=abc", page("Generic site title"));
        responses.set(
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc&format=json",
            oembed({ title: "The video", author_name: "A channel", provider_name: "YouTube" })
        );
        await unfurl("https://www.youtube.com/watch?v=abc");
        expect(stored[0]?.title).toBe("The video");
        expect(stored[0]?.siteName).toBe("YouTube");
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

describe("a share-button short link", () => {
    // What the TikTok app's Share > Copy link hands out, and what it answers -
    // measured against vt.tiktok.com: a redirect to the video's page with the
    // account left out and the sharer's identifiers in the query.
    const share = "https://vt.tiktok.com/ZSmhQWGRu/";
    const landed =
        "https://www.tiktok.com/@/video/7574301384833617172?_r=1&_d=secCgY&u_code=eck6a4k288d7c4&share_item_id=7574301384833617172";
    const video = "https://www.tiktok.com/@/video/7574301384833617172";
    const askTikTok = `https://www.tiktok.com/oembed?url=${encodeURIComponent(video)}&format=json`;
    const oembed = (body: unknown) => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });

    beforeEach(() => {
        dns.set("vt.tiktok.com", ["23.0.0.10"]);
        dns.set("vm.tiktok.com", ["23.0.0.10"]);
        dns.set("www.tiktok.com", ["23.0.0.11"]);
        responses.set(share, { status: 302, headers: { location: landed }, body: "" });
        responses.set(video, {
            status: 200,
            headers: { "content-type": "text/html" },
            body: "<html><head><title>TikTok - Make Your Day</title></head></html>"
        });
        responses.set(
            askTikTok,
            oembed({
                title: "A caption",
                author_name: "Somebody",
                provider_name: "TikTok",
                thumbnail_url: "https://p16-sign.tiktokcdn-eu.com/cover.image"
            })
        );
    });

    it("is followed to the video, and that address is kept without the query", async () => {
        await unfurl(share);
        expect(stored[0]?.url).toBe(share);
        expect(stored[0]?.target).toBe(video);
        expect(stored[0]?.ok).toBe(true);
        expect(stored[0]?.title).toBe("A caption");
        expect(stored[0]?.siteName).toBe("TikTok");
        expect(stored[0]?.author).toBe("Somebody");
    });

    it("asks TikTok about the video rather than the short link", async () => {
        await unfurl(share);
        // The hop that named the video is fetched once; the address it named is
        // never fetched with the sharer's query on it.
        expect(fetched[0]).toBe(share);
        expect(fetched).toContain(askTikTok);
        expect(fetched).not.toContain(landed);
        expect(fetched.filter((address) => address === share)).toHaveLength(1);
    });

    it("refuses a short link that leads somewhere private", async () => {
        responses.set(share, {
            status: 302,
            headers: { location: "http://evil.test/admin" },
            body: ""
        });
        await unfurl(share);
        expect(fetched).not.toContain("http://evil.test/admin");
        expect(stored[0]?.target).toBeNull();
    });

    it("gives up on one that only leads to more short links", async () => {
        // Bounded: a chain of redirects is not walked for ever.
        responses.set(share, {
            status: 302,
            headers: { location: "https://vm.tiktok.com/ZMaaaa1/" },
            body: ""
        });
        for (let hop = 1; hop <= 5; hop += 1) {
            responses.set(`https://vm.tiktok.com/ZMaaaa${hop}/`, {
                status: 302,
                headers: { location: `https://vm.tiktok.com/ZMaaaa${hop + 1}/` },
                body: ""
            });
        }
        await unfurl(share);
        expect(stored[0]?.target).toBeNull();
        expect(fetched.filter((address) => address.includes("tiktok.com/ZM")).length).toBeLessThan(
            5
        );
    });

    it("draws a video with no caption, from who posted it", async () => {
        responses.set(video, {
            status: 200,
            headers: { "content-type": "text/html" },
            body: "<html></html>"
        });
        responses.set(askTikTok, oembed({ title: "", author_name: "Somebody" }));
        await unfurl(share);
        expect(stored[0]?.ok).toBe(true);
        expect(stored[0]?.author).toBe("Somebody");
    });

    it("is followed again within the hour when an older look never followed it", async () => {
        rows.existing = {
            ok: true,
            url: share,
            target: null,
            fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000)
        };
        await unfurl(share);
        expect(stored[0]?.target).toBe(video);
    });

    it("is not followed again once it has been", async () => {
        rows.existing = {
            ok: true,
            url: share,
            target: video,
            fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000)
        };
        await unfurl(share);
        expect(fetched).toEqual([]);
    });

    it("keeps a card that was drawn when a later look fails", async () => {
        rows.existing = {
            ok: true,
            url: share,
            target: video,
            fetchedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
        };
        responses.set(share, { status: 500, headers: {}, body: "" });
        await unfurl(share);
        expect(stored).toEqual([]);
        expect(rows.updates).toHaveLength(1);
        const update = rows.updates[0]!;
        expect(update.where).toEqual({ url: share });
        expect(Date.now() - update.data.fetchedAt.getTime()).toBeLessThan(60 * 1000);
    });

    it("replaces a card that was drawn when a later look succeeds", async () => {
        rows.existing = {
            ok: true,
            url: share,
            target: video,
            fetchedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
        };
        await unfurl(share);
        expect(stored[0]?.title).toBe("A caption");
        expect(rows.updates).toEqual([]);
    });

    it("records a failure over a card that was never drawn", async () => {
        rows.existing = {
            ok: false,
            url: share,
            target: null,
            fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000)
        };
        responses.set(share, { status: 500, headers: {}, body: "" });
        await unfurl(share);
        expect(stored[0]?.ok).toBe(false);
    });

    it("is not how an ordinary link is treated", async () => {
        responses.set("http://example.com/", page("A page"));
        await unfurl("http://example.com/");
        expect(stored[0]?.target).toBeNull();
    });
});

describe("a card's picture", () => {
    beforeEach(() => {
        dns.set("p16-sign.tiktokcdn-eu.com", ["23.0.0.12"]);
    });

    it("is handed back while it answers, and nothing is marked", async () => {
        rows.existing = { imageUrl: "https://p16-sign.tiktokcdn-eu.com/cover.image?x-expires=1" };
        responses.set("https://p16-sign.tiktokcdn-eu.com/cover.image?x-expires=1", {
            status: 200,
            headers: { "content-type": "image/jpeg" },
            body: "jpeg"
        });
        expect((await previewImage("p1"))?.contentType).toBe("image/jpeg");
        expect(rows.updates).toEqual([]);
    });

    it("that stopped answering marks the card to be looked at again, at most hourly", async () => {
        // TikTok signs its covers with an expiry two days out; the card is
        // trusted for a week.
        rows.existing = { imageUrl: "https://p16-sign.tiktokcdn-eu.com/cover.image?x-expires=1" };
        responses.set("https://p16-sign.tiktokcdn-eu.com/cover.image?x-expires=1", {
            status: 403,
            headers: { "content-type": "text/plain" },
            body: "expired"
        });
        expect(await previewImage("p1")).toBeNull();
        expect(rows.updates).toHaveLength(1);
        const update = rows.updates[0]!;
        // Only a row not already looked at within the hour.
        const where = update.where as { id: string; fetchedAt: { lt: Date } };
        expect(where.id).toBe("p1");
        expect(Date.now() - where.fetchedAt.lt.getTime()).toBeGreaterThanOrEqual(
            60 * 60 * 1000 - 1000
        );
        // Old enough that the next read asks again.
        expect(Date.now() - update.data.fetchedAt.getTime()).toBeGreaterThan(
            7 * 24 * 60 * 60 * 1000
        );
    });
});

describe("a card's picture that expired", () => {
    it("is fetched afresh in the same request: the page read again, its new picture handed back", async () => {
        // The report: of several TikToks in a chat only the newest showed its
        // picture. The others' covers - signed, good for two days - had
        // expired; the card was marked to be read again, but the picture had
        // already failed on screen at an address that never changes.
        dns.set("p16-sign.tiktokcdn-eu.com", ["23.0.0.12"]);
        rows.existing = {
            ok: true,
            url: "https://example.com/post",
            target: null,
            fetchedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
            imageUrl: "https://p16-sign.tiktokcdn-eu.com/old.image?x-expires=1"
        };
        responses.set("https://p16-sign.tiktokcdn-eu.com/old.image?x-expires=1", {
            status: 403,
            headers: { "content-type": "text/plain" },
            body: "expired"
        });
        responses.set("https://example.com/post", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
            body: '<html><head><title>A post</title><meta property="og:image" content="https://p16-sign.tiktokcdn-eu.com/new.image?x-expires=9"></head></html>'
        });
        responses.set("https://p16-sign.tiktokcdn-eu.com/new.image?x-expires=9", {
            status: 200,
            headers: { "content-type": "image/jpeg" },
            body: "jpeg"
        });
        const image = await previewImage("p1");
        expect(image?.contentType).toBe("image/jpeg");
        expect(fetched).toContain("https://example.com/post");
    });

    it("is not looked up again more than once an hour", async () => {
        dns.set("p16-sign.tiktokcdn-eu.com", ["23.0.0.12"]);
        rows.existing = {
            ok: true,
            url: "https://example.com/post",
            target: null,
            fetchedAt: new Date(Date.now() - 10 * 60 * 1000),
            imageUrl: "https://p16-sign.tiktokcdn-eu.com/old.image?x-expires=1"
        };
        responses.set("https://p16-sign.tiktokcdn-eu.com/old.image?x-expires=1", {
            status: 403,
            headers: { "content-type": "text/plain" },
            body: "expired"
        });
        expect(await previewImage("p1")).toBeNull();
        expect(fetched).not.toContain("https://example.com/post");
    });

    it("is looked up once when several requests for it arrive together", async () => {
        dns.set("p16-sign.tiktokcdn-eu.com", ["23.0.0.12"]);
        rows.existing = {
            ok: true,
            url: "https://example.com/post",
            target: null,
            fetchedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
            imageUrl: "https://p16-sign.tiktokcdn-eu.com/old.image?x-expires=1"
        };
        responses.set("https://p16-sign.tiktokcdn-eu.com/old.image?x-expires=1", {
            status: 403,
            headers: { "content-type": "text/plain" },
            body: "expired"
        });
        responses.set("https://example.com/post", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
            body: '<html><head><title>A post</title><meta property="og:image" content="https://p16-sign.tiktokcdn-eu.com/new.image?x-expires=9"></head></html>'
        });
        await Promise.all([previewImage("p1"), previewImage("p1"), previewImage("p1")]);
        expect(fetched.filter((address) => address === "https://example.com/post")).toHaveLength(1);
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

describe("a Steam store link", () => {
    const API = "https://store.steampowered.com/api/appdetails?appids=1145360&cc=de&l=english";

    it("asks Steam's storefront rather than the page, and keeps the price", async () => {
        dns.set("store.steampowered.com", ["23.62.99.1"]);
        responses.set(API, {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({
                "1145360": {
                    success: true,
                    data: {
                        name: "Hades",
                        is_free: false,
                        short_description: "Defy the god of the dead.",
                        header_image:
                            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1145360/header.jpg",
                        developers: ["Supergiant Games"],
                        price_overview: {
                            discount_percent: 75,
                            initial_formatted: "24,50€",
                            final_formatted: "6,12€"
                        },
                        platforms: { windows: true, mac: true, linux: false },
                        release_date: { coming_soon: false, date: "17 Sep, 2020" }
                    }
                }
            })
        });
        await unfurl("https://store.steampowered.com/app/1145360/Hades/");
        // The page itself is never fetched: it is an age gate for half the
        // catalogue and carries no price.
        expect(fetched).toEqual([API]);
        const row = stored[0]!;
        expect(row.ok).toBe(true);
        expect(row.title).toBe("Hades");
        expect(row.siteName).toBe("Steam");
        expect(row.author).toBe("Supergiant Games");
        expect(JSON.parse(row.details ?? "null")).toMatchObject({
            kind: "steam",
            appId: "1145360",
            price: { final: "6,12€", initial: "24,50€", discount: 75 }
        });
    });

    it("stores a failure when Steam does not know the game", async () => {
        dns.set("store.steampowered.com", ["23.62.99.1"]);
        responses.set("https://store.steampowered.com/api/appdetails?appids=1&cc=de&l=english", {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ "1": { success: false } })
        });
        await unfurl("https://store.steampowered.com/app/1/");
        expect(stored[0]?.ok).toBe(false);
        expect(stored[0]?.details ?? null).toBeNull();
    });
});
