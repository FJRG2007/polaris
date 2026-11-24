/**
 * A game's picture beside "Playing <game>".
 *
 * What is pinned:
 * - a computer names a game's store id at most; a report with anything else
 *   still shows the game, without the id;
 * - only Steam, GOG and the Microsoft Store are asked, at their own public
 *   addresses, and a picture is only ever taken from their own image hosts;
 * - the curated id wins over a reported one, and a reported one is learned for
 *   older desktop apps that send none;
 * - a picture is redrawn as a 128px WebP, fetched once and shared by readers
 *   asking at once, and a store that had none is not asked again at once.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    art: new Map<string, { image: Buffer | null; fetchedAt: Date }>(),
    keys: new Map<string, string>(),
    metadataCalls: 0,
    imageCalls: 0,
    metadata: null as unknown,
    image: null as Uint8Array | null
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        gameArt: {
            findUnique: async ({ where }: { where: { ref: string } }) => fake.art.get(where.ref) ?? null,
            upsert: async ({ where, create }: { where: { ref: string }; create: { image: Buffer | null; fetchedAt: Date } }) => {
                fake.art.set(where.ref, { image: create.image, fetchedAt: create.fetchedAt });
                return create;
            }
        },
        gameArtKey: {
            findUnique: async ({ where }: { where: { key: string } }) =>
                fake.keys.has(where.key) ? { ref: fake.keys.get(where.key) } : null,
            createMany: async ({ data }: { data: { key: string; ref: string }[] }) => {
                for (const row of data) if (!fake.keys.has(row.key)) fake.keys.set(row.key, row.ref);
                return { count: data.length };
            }
        }
    }
}));

vi.mock("@/lib/safe-fetch", () => ({
    follow: async () => {
        fake.metadataCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        const text = JSON.stringify(fake.metadata);
        return { ok: fake.metadata !== null, text };
    },
    readCapped: async (response: { text: string }) => new TextEncoder().encode(response.text),
    fetchImage: async () => {
        fake.imageCalls += 1;
        return fake.image ? { name: "art", contentType: "image/png", bytes: fake.image } : null;
    }
}));

const sources = await import("@/lib/presence-activity/game-art-sources");
const { gameArt, artRefOfReport, ART_SIDE } = await import("@/lib/presence-activity/game-art");

const STEAM_ANSWER = {
    response: {
        store_items: [
            {
                appid: 100,
                assets: {
                    asset_url_format: "steam/apps/100/${FILENAME}?t=1",
                    library_capsule: "abc123/library_capsule.jpg",
                    header: "def456/header.jpg"
                }
            }
        ]
    }
};

async function picture(width: number, height: number): Promise<Uint8Array> {
    const { default: sharp } = await import("sharp");
    return new Uint8Array(
        await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer()
    );
}

beforeEach(() => {
    fake.art.clear();
    fake.keys.clear();
    fake.metadataCalls = 0;
    fake.imageCalls = 0;
    fake.metadata = null;
    fake.image = null;
});

describe("what a computer may say about a game's picture", () => {
    it("takes a store id, and drops anything else without refusing the report", () => {
        const base = { key: "game.exe", name: "A game", startedAt: "2026-11-24T00:00:00.000Z" };
        for (const store of ["steam:252950", "gog:1207658924", "ubisoft:635", "epic:fixture-namespace:fixture-item", "packaged:Fixture.App_1abc!App"]) {
            expect(core.gameReportSchema.parse({ game: { ...base, store } }).game?.store).toBe(store);
        }
        for (const store of ["https://evil.example/a.png", "steam:abc", "data:image/png;base64,AAAA", "steam:1/../x", 42]) {
            const parsed = core.gameReportSchema.parse({ game: { ...base, store } });
            expect(parsed.game?.name).toBe("A game");
            expect(parsed.game?.store).toBeUndefined();
        }
        // An older desktop app says nothing about a store at all.
        expect(core.gameReportSchema.parse({ game: base }).game?.store).toBeUndefined();
    });
});

describe("where a picture is looked for", () => {
    it("asks Steam and GOG at their public addresses and no other store", () => {
        expect(sources.metadataUrl("steam:252950")).toMatch(/^https:\/\/api\.steampowered\.com\/IStoreBrowseService\/GetItems\/v1\/\?input_json=/);
        expect(decodeURIComponent(sources.metadataUrl("steam:252950")!)).toContain('"appid":252950');
        expect(sources.metadataUrl("gog:1207658924")).toBe("https://api.gog.com/products/1207658924");
        expect(sources.metadataUrl("epic:fixture-namespace:fixture-item")).toBeNull();
        expect(sources.metadataUrl("ubisoft:635")).toBeNull();
        expect(sources.metadataUrl("not a ref")).toBeNull();
    });

    it("reads the box art from Steam's answer and the icon from GOG's", () => {
        expect(sources.artUrlFrom("steam:100", STEAM_ANSWER)).toBe(
            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/100/abc123/library_capsule.jpg?t=1"
        );
        expect(sources.artUrlFrom("gog:1", { images: { icon: "//images-4.gog-statics.com/abc.png" } })).toBe(
            "https://images-4.gog-statics.com/abc.png"
        );
    });

    it("asks the Microsoft Store for a product this server found, and takes its box art scaled down", () => {
        expect(sources.metadataUrl("msstore:BT5P2X999VH2")).toBe(
            "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=BT5P2X999VH2&market=US&languages=en-US"
        );
        const images = [
            { ImagePurpose: "Logo", Width: 50, Uri: "//store-images.s-microsoft.com/image/apps.1.logo50" },
            { ImagePurpose: "Logo", Width: 300, Uri: "//store-images.s-microsoft.com/image/apps.2.logo300" },
            { ImagePurpose: "BoxArt", Width: 2160, Uri: "//store-images.s-microsoft.com/image/apps.3.boxart" }
        ];
        const answer = (list: unknown[]) => ({ Products: [{ LocalizedProperties: [{ Images: list }] }] });
        expect(sources.artUrlFrom("msstore:BT5P2X999VH2", answer(images))).toBe(
            "https://store-images.s-microsoft.com/image/apps.3.boxart?w=256&h=256"
        );
        expect(sources.artUrlFrom("msstore:BT5P2X999VH2", answer(images.slice(0, 2)))).toBe(
            "https://store-images.s-microsoft.com/image/apps.2.logo300?w=256&h=256"
        );
        expect(sources.artUrlFrom("msstore:BT5P2X999VH2", answer([{ ImagePurpose: "BoxArt", Width: 9, Uri: "https://evil.example/x" }]))).toBeNull();
        expect(sources.artUrlFrom("msstore:BT5P2X999VH2", answer([images[0]]))).toBeNull();
        // Only this server writes a Microsoft Store id; a computer cannot report one.
        expect(sources.resolvable("msstore:BT5P2X999VH2")).toBe(true);
        expect(sources.resolvable("msstore:bt5p2x999vh2")).toBe(false);
        expect(core.gameReportSchema.parse({ game: { key: "a.exe", name: "A", startedAt: "2026-11-24T00:00:00.000Z", store: "msstore:BT5P2X999VH2" } }).game?.store).toBeUndefined();
    });

    it("never takes a picture from anywhere but the store's own image hosts", () => {
        expect(sources.artUrlFrom("gog:1", { images: { icon: "https://evil.example/abc.png" } })).toBeNull();
        expect(sources.artUrlFrom("gog:1", { images: { icon: "http://images-4.gog-statics.com/abc.png" } })).toBeNull();
        const escaping = { response: { store_items: [{ assets: { asset_url_format: "../../${FILENAME}", library_capsule: "x/library_capsule.jpg" } }] } };
        expect(sources.artUrlFrom("steam:100", escaping)).toBeNull();
        const dotted = { response: { store_items: [{ assets: { asset_url_format: "steam/apps/100/${FILENAME}", library_capsule: "../x.jpg" } }] } };
        expect(sources.artUrlFrom("steam:100", dotted)).toBeNull();
        expect(sources.artUrlFrom("steam:100", { response: { store_items: [] } })).toBeNull();
        expect(sources.artUrlFrom("steam:100", "nonsense")).toBeNull();
    });

    it("prefers the curated id, then the reported one, then the learned one", () => {
        expect(sources.artRefFor("rocketleague.exe", "epic:fixture-namespace:fixture-item", null)).toBe("steam:252950");
        expect(sources.artRefFor("unknown.exe", "gog:5", "steam:7")).toBe("gog:5");
        expect(sources.artRefFor("unknown.exe", undefined, "steam:7")).toBe("steam:7");
        // A store with no public catalog draws the glyph rather than nothing.
        expect(sources.artRefFor("unknown.exe", "epic:fixture-namespace:fixture-item", null)).toBeNull();
        expect(sources.artRefFor("unknown.exe", null, null)).toBeNull();
    });

    it("keeps every curated id a store id", () => {
        for (const ref of Object.values(sources.CURATED_ART)) expect(core.GAME_STORE_REF.test(ref)).toBe(true);
    });
});

describe("the picture this server keeps", () => {
    it("redraws the store's picture as a 128px WebP, once for readers asking at once", async () => {
        fake.metadata = STEAM_ANSWER;
        fake.image = await picture(600, 900);
        const [first, second] = await Promise.all([gameArt("steam:100"), gameArt("steam:100")]);
        expect(fake.metadataCalls).toBe(1);
        expect(fake.imageCalls).toBe(1);
        expect(first).toEqual(second);
        const { default: sharp } = await import("sharp");
        const meta = await sharp(first!).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual(["webp", ART_SIDE, ART_SIDE]);
        // Kept: the next reader is answered without asking the store.
        await gameArt("steam:100");
        expect(fake.metadataCalls).toBe(1);
    });

    it("refuses what is not a picture, and does not ask again at once", async () => {
        fake.metadata = STEAM_ANSWER;
        fake.image = new TextEncoder().encode("<html>not a picture</html>");
        expect(await gameArt("steam:100")).toBeNull();
        expect(await gameArt("steam:100")).toBeNull();
        expect(fake.metadataCalls).toBe(1);
    });

    it("never fetches for a store it does not ask", async () => {
        expect(await gameArt("epic:fixture-namespace:fixture-item")).toBeNull();
        expect(await gameArt("steam:not-a-number")).toBeNull();
        expect(fake.metadataCalls).toBe(0);
    });

    it("learns a reported id for older desktop apps, and the first to say keeps it", async () => {
        expect(await artRefOfReport("fixture-game.exe", "gog:5")).toBe("gog:5");
        expect(await artRefOfReport("fixture-game.exe", undefined)).toBe("gog:5");
        await artRefOfReport("fixture-game.exe", "steam:9");
        expect(fake.keys.get("fixture-game.exe")).toBe("gog:5");
    });
});
