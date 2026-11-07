/**
 * Themes and add-ons picked for a TV: the catalog read whole or not at all, a
 * pick stored as its own choice beside Block ads and trackers, and a TV's report
 * kept only for the latest choice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CHOICE = "0190a000-0000-7000-8000-0000000000aa";
let stored: { desired: unknown } | null = null;
let clientBuild: number | null = 15;
let catalogBody: string | null = null;
const written: unknown[] = [];

// The gallery renders in its own test (packages/ui); here only the picker around it is under test.
vi.mock("@polaris/ui/tv-gallery", () => ({ TvGallery: () => null }));
vi.mock("node:fs/promises", async (original) => ({
    ...(await original<typeof import("node:fs/promises")>()),
    readFile: async () => catalogBody
}));
vi.mock("@/lib/tv/release", () => ({
    TV_CATALOG_NAME: "catalog.json",
    preparedTvCatalogFile: async () => (catalogBody === null ? null : { path: "catalog.json" })
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        tvPreference: {
            findUnique: async () => stored,
            updateMany: async (args: { data: unknown }) => {
                written.push(args.data);
                return { count: 1 };
            },
            upsert: async (args: { update: unknown }) => {
                written.push(args.update);
                return {};
            }
        },
        apiKey: {
            findFirst: async () => ({ clientBuild, tvPreference: stored })
        }
    }
}));

const picks = await import("@/lib/tv/catalog-picks");
const { catalogStatus, toggledAddons } = await import("@/app/(app)/account/tv/tv-catalog-picker");

function entry(kind: string, id: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        kind,
        name: `Sample ${id}`,
        description: "Sample description",
        network: false,
        minSdk: 21,
        screenshot: `${kind}-${id}.jpg`,
        ...extra
    };
}

beforeEach(() => {
    stored = null;
    clientBuild = 15;
    written.length = 0;
    catalogBody = JSON.stringify({
        version: 1,
        items: [entry("theme", "aerial"), entry("addon", "weather"), entry("addon", "sleep-timer")]
    });
});

describe("reading the catalog", () => {
    it("keeps the entries that read cleanly, once each", () => {
        const body = JSON.stringify({
            version: 1,
            items: [
                entry("theme", "aerial"),
                entry("theme", "aerial"),
                entry("theme", "../x"),
                entry("addon", "weather", { screenshot: "elsewhere.jpg" }),
                entry("widget", "clock"),
                entry("addon", "tatami", { minSdk: "new" })
            ]
        });
        expect(picks.parseTvCatalog(body)?.map((item) => item.id)).toEqual(["aerial", "tatami"]);
    });

    it("is null for a catalog of another version or not JSON at all", () => {
        expect(picks.parseTvCatalog('{"version":2,"items":[]}')).toBeNull();
        expect(picks.parseTvCatalog("not json")).toBeNull();
    });
});

describe("a TV's report", () => {
    function poll(query: string) {
        return new Request(`https://polaris.example/api/tv/state?${query}`);
    }

    it("is read only with a known outcome and a choice id", () => {
        expect(picks.reportedCatalog(poll(`theme=applied&themeChoice=${CHOICE}`))).toEqual({
            theme: { report: "applied", choice: CHOICE },
            addons: null
        });
        expect(picks.reportedCatalog(poll("theme=applied"))).toBeNull();
        expect(picks.reportedCatalog(poll(`addons=everything&addonsChoice=${CHOICE}`))).toBeNull();
    });

    it("is kept for the latest choice, and blocking is left as it was", async () => {
        stored = { desired: { blocking: true, theme: { id: "aerial", choice: CHOICE } } };
        await picks.noteTvCatalog("key-1", {
            theme: { report: "applied", choice: CHOICE },
            addons: null
        });
        expect(written).toEqual([
            {
                desired: {
                    blocking: true,
                    theme: { id: "aerial", choice: CHOICE, applied: "applied" }
                }
            }
        ]);
    });

    it("is ignored for an earlier choice", async () => {
        stored = { desired: { theme: { id: "aerial", choice: CHOICE } } };
        await picks.noteTvCatalog("key-1", {
            theme: { report: "failed", choice: "0190a000-0000-7000-8000-0000000000bb" },
            addons: null
        });
        expect(written).toEqual([]);
    });
});

describe("picking for a TV", () => {
    it("stores a theme as a new choice beside what was asked before", async () => {
        stored = { desired: { blocking: false } };
        expect(await picks.setTvTheme("user-1", "key-1", "aerial")).toBe("done");
        const [update] = written as { desired: { blocking: boolean; theme: { id: string } } }[];
        expect(update!.desired.blocking).toBe(false);
        expect(update!.desired.theme).toMatchObject({ id: "aerial", applied: null });
    });

    it("refuses an id the catalog does not list, and a launcher too old to act", async () => {
        expect(await picks.setTvAddons("user-1", "key-1", ["weather", "nope"])).toBe("notInCatalog");
        expect(await picks.setTvTheme("user-1", "key-1", "weather")).toBe("notInCatalog");
        clientBuild = 14;
        expect(await picks.setTvTheme("user-1", "key-1", "aerial")).toBe("tooOld");
        expect(written).toEqual([]);
    });

    it("sorts and de-duplicates the add-ons asked", () => {
        const parsed = picks.tvAddonsPickSchema.parse({
            keyId: "0190a000-0000-7000-8000-000000000001",
            addons: ["weather", "sleep-timer", "weather"]
        });
        expect(parsed.addons).toEqual(["sleep-timer", "weather"]);
        expect(toggledAddons(["weather"], "sleep-timer")).toEqual(["sleep-timer", "weather"]);
        expect(toggledAddons(["weather"], "weather")).toEqual([]);
    });
});

describe("the line under the picker", () => {
    const row = (catalog: unknown, versionCode: number | null = 15) =>
        ({ versionCode, catalog }) as Parameters<typeof catalogStatus>[0];

    it("says what stands", () => {
        expect(catalogStatus(row({ theme: null, addons: null }, 14))).toBe("updateFirst");
        expect(catalogStatus(row({ theme: null, addons: null }))).toBe("notAsked");
        expect(catalogStatus(row({ theme: { id: "a", applied: null }, addons: null }))).toBe("waiting");
        expect(
            catalogStatus(
                row({
                    theme: { id: "a", applied: "applied" },
                    addons: { ids: ["w"], applied: "asked" }
                })
            )
        ).toBe("asked");
        expect(catalogStatus(row({ theme: null, addons: { ids: [], applied: "installed" } }))).toBe(
            "installed"
        );
    });
});
