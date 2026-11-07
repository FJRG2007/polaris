/**
 * Themes and add-ons picked for a TV: the catalog read whole or not at all, a
 * pick stored as its own choice beside Block ads and trackers, and a TV's report
 * kept only for the latest choice.
 */

import { isDeepStrictEqual } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CHOICE = "0190a000-0000-7000-8000-0000000000aa";
let stored: { desired: unknown } | null = null;
/** Runs between the read of `desired` and its write, as another request would. */
let meanwhile: (() => void) | null = null;
let clientBuild: number | null = 16;
let catalogBody: string | null = null;
let unreachable = false;
const written: unknown[] = [];

// The gallery renders in its own test (packages/ui); here only the picker around it is under test.
vi.mock("@polaris/ui/tv-gallery", () => ({ TvGallery: () => null }));
vi.mock("node:fs/promises", async (original) => ({
    ...(await original<typeof import("node:fs/promises")>()),
    readFile: async () => catalogBody
}));
vi.mock("@/lib/tv/release", () => ({
    TV_CATALOG_NAME: "catalog.json",
    preparedTvCatalogFile: async () => {
        if (unreachable) throw new Error("unreachable");
        return catalogBody === null ? null : { path: "catalog.json" };
    }
}));
vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        tvPreference: {
            findUnique: async () => {
                const found = stored ? { ...stored } : null;
                const run = meanwhile;
                meanwhile = null;
                run?.();
                return found;
            },
            updateMany: async (args: {
                where: { desired: { equals: unknown } };
                data: { desired: unknown };
            }) => {
                if (!stored || !isDeepStrictEqual(stored.desired, args.where.desired.equals)) {
                    return { count: 0 };
                }
                written.push(args.data);
                stored = { desired: args.data.desired };
                return { count: 1 };
            },
            create: async (args: { data: { desired: unknown } }) => {
                written.push(args.data);
                stored = { desired: args.data.desired };
                return {};
            }
        },
        apiKey: {
            findFirst: async () => ({ clientBuild })
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
    meanwhile = null;
    unreachable = false;
    clientBuild = 16;
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
        await picks.noteTvCatalog("key-1", "user-1", {
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

    it("never writes over a pick made while it was being written", async () => {
        const next = "0190a000-0000-7000-8000-0000000000bb";
        stored = { desired: { theme: { id: "aerial", choice: CHOICE } } };
        meanwhile = () => {
            stored = { desired: { theme: { id: "dusk", choice: next, applied: null } } };
        };
        await picks.noteTvCatalog("key-1", "user-1", {
            theme: { report: "applied", choice: CHOICE },
            addons: null
        });
        expect(stored).toEqual({
            desired: { theme: { id: "dusk", choice: next, applied: null } }
        });
        expect(written).toEqual([]);
    });

    it("is ignored for an earlier choice", async () => {
        stored = { desired: { theme: { id: "aerial", choice: CHOICE } } };
        await picks.noteTvCatalog("key-1", "user-1", {
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

    it("keeps a report the TV made while the add-ons were being picked", async () => {
        stored = { desired: { theme: { id: "aerial", choice: CHOICE } } };
        meanwhile = () => {
            stored = { desired: { theme: { id: "aerial", choice: CHOICE, applied: "applied" } } };
        };
        expect(await picks.setTvAddons("user-1", "key-1", ["weather"])).toBe("done");
        const desired = (stored as { desired: { theme: unknown; addons: unknown } } | null)
            ?.desired;
        expect(desired?.theme).toEqual({ id: "aerial", choice: CHOICE, applied: "applied" });
        expect(desired?.addons).toMatchObject({ ids: ["weather"], applied: null });
    });

    it("tells a catalog it cannot fetch apart from an id it does not list", async () => {
        catalogBody = null;
        expect(await picks.setTvTheme("user-1", "key-1", "aerial")).toBe("notInCatalog");
        unreachable = true;
        expect(await picks.setTvTheme("user-1", "key-1", "aerial")).toBe("catalogUnreachable");
        expect(written).toEqual([]);
    });

    it("refuses an id the catalog does not list, and a launcher too old to act", async () => {
        expect(await picks.setTvAddons("user-1", "key-1", ["weather", "nope"])).toBe(
            "notInCatalog"
        );
        expect(await picks.setTvTheme("user-1", "key-1", "weather")).toBe("notInCatalog");
        clientBuild = 15;
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
    const row = (catalog: unknown, versionCode: number | null = 16) =>
        ({ versionCode, catalog }) as Parameters<typeof catalogStatus>[0];

    it("says what stands", () => {
        expect(catalogStatus(row({ theme: null, addons: null }, 15))).toBe("updateFirst");
        // No newer release to send it to: not a dead end pointing at an update that does not exist.
        expect(catalogStatus(row({ theme: null, addons: null }, 15), true)).toBe("nextUpdate");
        expect(catalogStatus(row({ theme: null, addons: null }), true)).toBe("notAsked");
        expect(catalogStatus(row({ theme: null, addons: null }))).toBe("notAsked");
        expect(catalogStatus(row({ theme: { id: "a", applied: null }, addons: null }))).toBe(
            "waiting"
        );
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
