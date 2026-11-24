/**
 * A game with no store id this server asks, found by its name.
 *
 * What is pinned:
 * - two spellings of one title meet (trademark signs, case, punctuation) and
 *   nothing looser does: only an exact title is a match;
 * - two games with that title at one source is ambiguous, and draws the glyph;
 * - a source that did not answer leaves the name unsettled rather than missing;
 * - the top PC games, against the answers the sources gave on the day the
 *   fixture was recorded, each resolve to the store id expected or to the glyph
 *   for the reason written beside it;
 * - a found name and a missed one are both kept, a lookup is shared by readers
 *   asking at once, and one the server's own limit stopped is not kept.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    names: new Map<string, { ref: string | null; source: string | null; checkedAt: Date }>(),
    answers: new Map<string, unknown>(),
    fetched: [] as string[],
    limited: false
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        gameArtName: {
            findUnique: async ({ where }: { where: { name: string } }) => fake.names.get(where.name) ?? null,
            upsert: async ({ where, create }: { where: { name: string }; create: { ref: string | null; source: string | null; checkedAt: Date } }) => {
                fake.names.set(where.name, { ref: create.ref, source: create.source, checkedAt: create.checkedAt });
                return create;
            },
            deleteMany: async () => ({ count: 0 })
        },
        gameArt: { findUnique: async () => null, upsert: async () => null }
    }
}));

vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => (fake.limited ? { ok: false, retryAfterMs: 1000 } : { ok: true, retryAfterMs: 0 })
}));

vi.mock("@/lib/safe-fetch", () => ({
    follow: async (url: URL) => {
        fake.fetched.push(url.href);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const body = fake.answers.get(url.href);
        return { ok: body !== undefined, text: JSON.stringify(body ?? null) };
    },
    readCapped: async (response: { text: string }) => new TextEncoder().encode(response.text),
    fetchImage: async () => null
}));

const lookup = await import("@/lib/presence-activity/game-art-lookup");
const { refForName } = await import("@/lib/presence-activity/game-art");
const sources = await import("@/lib/presence-activity/game-art-sources");

interface Recorded {
    name: string;
    expected: string | null;
    source: string | null;
    glyph?: string;
    answers: Partial<Record<"steam" | "msstore" | "wikidata", unknown>>;
}

const TOP_GAMES = (
    JSON.parse(readFileSync(new URL("./fixtures/top-pc-games.json", import.meta.url), "utf8")) as { games: Recorded[] }
).games;

beforeEach(() => {
    fake.names.clear();
    fake.answers.clear();
    fake.fetched = [];
    fake.limited = false;
});

describe("a game's name, normalized", () => {
    it("meets the store's spelling of the same title", () => {
        expect(lookup.normalizeGameName("HELLDIVERS™ 2")).toBe("helldivers 2");
        expect(lookup.normalizeGameName("Tom Clancy's Rainbow Six® Siege")).toBe("tom clancys rainbow six siege");
        expect(lookup.normalizeGameName("Counter-Strike 2")).toBe("counter strike 2");
        expect(lookup.normalizeGameName("  Pokémon  &  Friends ")).toBe("pokemon and friends");
        expect(lookup.normalizeGameName("The Witcher 3: Wild Hunt")).toBe("the witcher 3 wild hunt");
    });

    it("is nothing for a title with no Latin letters or digits, or one too long to be a title", () => {
        expect(lookup.normalizeGameName("原神")).toBeNull();
        expect(lookup.normalizeGameName("!!!")).toBeNull();
        expect(lookup.normalizeGameName("a".repeat(lookup.MAX_NAME_LENGTH + 1))).toBeNull();
    });

    it("round-trips through the picture reference, and nothing else is one", () => {
        expect(lookup.nameRefOf("Fall Guys")).toBe("name:fall guys");
        expect(lookup.nameOfRef("name:fall guys")).toBe("fall guys");
        for (const ref of ["name:", "name:Fall Guys", "name:fall  guys", "name: fall", "name:a\"b", "steam:730", `name:${"a".repeat(101)}`]) {
            expect(lookup.nameOfRef(ref)).toBeNull();
        }
    });
});

describe("one source's answer", () => {
    it("takes only an exact title, and only a game", () => {
        const steam = { items: [{ id: 1, name: "Minecraft Dungeons", type: "app" }, { id: 2, name: "Minecraft Legends", type: "app" }] };
        expect(lookup.steamStep(steam, "minecraft")).toEqual({ kind: "none" });
        const ms = { Results: [{ Products: [{ ProductId: "9N16XHX3MB1R", Title: "Fortnite - 800 V-Bucks", Type: "Consumable" }, { ProductId: "BT5P2X999VH2", Title: "Fortnite", Type: "Game" }] }] };
        expect(lookup.msStoreStep(ms, "fortnite")).toEqual({ kind: "match", ref: "msstore:BT5P2X999VH2" });
    });

    it("calls two games with the title ambiguous, and one game's editions one game", () => {
        const two = { items: [{ id: 10, name: "DOOM", type: "app" }, { id: 11, name: "Doom", type: "app" }] };
        expect(lookup.steamStep(two, "doom")).toEqual({ kind: "ambiguous" });
        const item = (q: string, label: string, extra: Record<string, string>) => ({
            item: { value: `http://www.wikidata.org/entity/${q}` },
            label: { value: label },
            ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { value: v }]))
        });
        const editions = { results: { bindings: [item("Q1", "Minecraft", { ms: "9nxp44l49shj" }), item("Q1", "Minecraft", { ms: "9mvxmvt8zkwc" })] } };
        expect(lookup.wikidataStep(editions, "minecraft")).toEqual({ kind: "match", ref: "msstore:9MVXMVT8ZKWC" });
        const preferSteam = { results: { bindings: [item("Q2", "Fall Guys", { steam: "1097150", ms: "9pmxh5249dg5", gog: "5" })] } };
        expect(lookup.wikidataStep(preferSteam, "fall guys")).toEqual({ kind: "match", ref: "steam:1097150" });
        const twoItems = { results: { bindings: [item("Q3", "Doom", { steam: "2280" }), item("Q4", "Doom", { steam: "379720" })] } };
        expect(lookup.wikidataStep(twoItems, "doom")).toEqual({ kind: "ambiguous" });
    });

    it("reads nonsense as nothing", () => {
        for (const body of [null, "x", 42, { items: "x" }, { Results: [null] }, { results: { bindings: [null, { item: { value: "javascript:1" } }] } }]) {
            expect(lookup.steamStep(body, "a")).toEqual({ kind: "none" });
            expect(lookup.msStoreStep(body, "a")).toEqual({ kind: "none" });
            expect(lookup.wikidataStep(body, "a")).toEqual({ kind: "none" });
        }
    });

    it("keeps the name inside the Wikidata query it is placed in", () => {
        const name = lookup.normalizeGameName('x" } ; DROP ?item { "')!;
        expect(decodeURIComponent(lookup.wikidataUrl(name).split("query=")[1]!)).toContain('mwapi:search "x drop item"');
    });
});

describe("the chain", () => {
    it("leaves a name unsettled when a source did not answer", async () => {
        expect(await lookup.lookupByName("fortnite", async () => undefined)).toBeUndefined();
    });

    it.each(TOP_GAMES.map((game) => [game.name, game] as const))("%s", async (_name, game) => {
        const name = lookup.normalizeGameName(game.name)!;
        const found = await lookup.lookupByName(name, async (_url, source) => game.answers[source] ?? { });
        expect(found?.ref ?? null).toBe(game.expected);
        expect(found?.source ?? null).toBe(game.source);
        if (game.expected === null) expect(game.glyph, "a glyph needs its reason").toBeTruthy();
        else expect(sources.resolvable(game.expected)).toBe(true);
    });

    it("covers the popular games outside Steam", () => {
        const byName = new Map(TOP_GAMES.map((game) => [game.name, game.expected]));
        for (const name of ["Fortnite", "VALORANT", "League of Legends", "Minecraft", "Genshin Impact", "Roblox", "Fall Guys", "Apex Legends", "Grand Theft Auto V"]) {
            expect(byName.get(name), name).not.toBeNull();
        }
        expect(TOP_GAMES.length).toBeGreaterThanOrEqual(50);
    });
});

describe("a name this server has looked up", () => {
    const answer = (name: string, steam: unknown, ms: unknown, wikidata: unknown): void => {
        fake.answers.set(lookup.steamSearchUrl(name), steam);
        fake.answers.set(lookup.msStoreSearchUrl(name), ms);
        fake.answers.set(lookup.wikidataUrl(name), wikidata);
    };

    it("is looked up once for readers asking at once, and kept", async () => {
        answer("fortnite", { items: [] }, { Results: [{ Products: [{ ProductId: "BT5P2X999VH2", Title: "Fortnite", Type: "Game" }] }] }, null);
        const [first, second] = await Promise.all([refForName("fortnite"), refForName("fortnite")]);
        expect([first, second]).toEqual(["msstore:BT5P2X999VH2", "msstore:BT5P2X999VH2"]);
        expect(fake.fetched).toHaveLength(2);
        expect(await refForName("fortnite")).toBe("msstore:BT5P2X999VH2");
        expect(fake.fetched).toHaveLength(2);
    });

    it("keeps a miss, and asks again only after a week", async () => {
        answer("hearthstone", { items: [] }, { Results: [] }, { results: { bindings: [] } });
        const now = new Date("2026-11-24T12:00:00Z");
        expect(await refForName("hearthstone", now)).toBeNull();
        expect(fake.names.get("hearthstone")?.ref).toBeNull();
        await refForName("hearthstone", new Date(now.getTime() + 24 * 60 * 60_000));
        expect(fake.fetched).toHaveLength(3);
        await refForName("hearthstone", new Date(now.getTime() + 8 * 24 * 60 * 60_000));
        expect(fake.fetched).toHaveLength(6);
    });

    it("keeps nothing when a source was down or the server's limit was reached", async () => {
        answer("roblox", { items: [] }, undefined, undefined);
        expect(await refForName("roblox")).toBeNull();
        expect(fake.names.has("roblox")).toBe(false);
        fake.limited = true;
        fake.fetched = [];
        expect(await refForName("valorant")).toBeNull();
        expect(fake.fetched).toHaveLength(0);
        expect(fake.names.has("valorant")).toBe(false);
    });
});
