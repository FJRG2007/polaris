/**
 * What the store listing shows and in what order, and the one action each card
 * leads with - decided in `lib/apps/marketplace-store`, apart from the drawing.
 */

import { describe, expect, it } from "vitest";
import { appPreview, hasScreenshots } from "@/lib/apps/app-screenshots";
import { appsByCategory, findApp, type AppManifest } from "@/lib/apps/catalog";
import {
    ADDED_ON,
    featuredApps,
    filterStoreApps,
    installBadge,
    primaryAction,
    storeCategories,
    storeShelves
} from "@/lib/apps/marketplace-store";

const offered = (): AppManifest[] => appsByCategory().flatMap((group) => group.apps);
const app = (id: string): AppManifest => findApp(id)!;
const ids = (apps: readonly AppManifest[]) => apps.map((item) => item.id);

describe("filtering and sorting the listing", () => {
    it("keeps only the chosen category, and every category on offer is a chip", () => {
        const all = offered();
        for (const category of storeCategories(all)) {
            const shown = filterStoreApps(all, { query: "", category, sort: "featured" });
            expect(shown.length, category).toBeGreaterThan(0);
            expect(
                shown.every((item) => item.category === category),
                category
            ).toBe(true);
        }
        expect(filterStoreApps(all, { query: "", category: "all", sort: "featured" })).toHaveLength(
            all.length
        );
    });

    it("searches inside the chosen category only", () => {
        const all = offered();
        expect(
            ids(filterStoreApps(all, { query: "dns", category: "Tools", sort: "featured" }))
        ).toContain("dns-blocker");
        expect(
            filterStoreApps(all, { query: "calendar", category: "Game servers", sort: "featured" })
        ).toEqual([]);
    });

    it("sorts by name the way the reader's language does, coming soon still last", () => {
        const shown = filterStoreApps(offered(), {
            query: "",
            category: "all",
            sort: "name",
            locale: "en-US"
        });
        const offeredNow = shown.filter((item) => !item.comingSoon).map((item) => item.name);
        expect(offeredNow).toEqual([...offeredNow].sort((a, b) => a.localeCompare(b, "en-US")));
        const firstSoon = shown.findIndex((item) => item.comingSoon);
        expect(shown.slice(firstSoon).every((item) => item.comingSoon)).toBe(true);
    });

    it("puts the most recently added first, and every offered app has its date", () => {
        for (const item of offered())
            expect(ADDED_ON[item.id], item.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const shown = filterStoreApps(offered(), { query: "", category: "all", sort: "recent" });
        const dates = shown.filter((item) => !item.comingSoon).map((item) => ADDED_ON[item.id]!);
        expect(dates).toEqual([...dates].sort().reverse());
        expect(shown[0]!.id).toBe("arcade");
    });

    it("keeps the catalog's order under Featured, with what is only announced last", () => {
        const shown = filterStoreApps(offered(), { query: "", category: "all", sort: "featured" });
        const soon = shown.map((item) => Boolean(item.comingSoon));
        expect(soon).toEqual([...soon].sort((a, b) => Number(a) - Number(b)));
    });
});

describe("shelves and the featured row", () => {
    it("puts Polaris's own apps on their shelf and somebody else's image on the other", () => {
        const bridge = app("messaging-bridge");
        const theirs: AppManifest = {
            ...bridge,
            id: "someone-elses",
            template: { ...bridge.template, image: "nginx:1.27" }
        };
        const shelves = storeShelves([app("calendar"), theirs]);
        expect(shelves.map((group) => group.shelf)).toEqual(["polaris", "community"]);
        expect(ids(shelves[0]!.apps)).toEqual(["calendar"]);
        expect(ids(shelves[1]!.apps)).toEqual(["someone-elses"]);
    });

    it("leaves out a shelf with nothing on it", () => {
        expect(storeShelves([app("calendar")]).map((group) => group.shelf)).toEqual(["polaris"]);
    });

    it("features only installable apps that have a real capture", () => {
        const featured = featuredApps(offered());
        expect(featured.length).toBeGreaterThan(0);
        for (const item of featured) expect(hasScreenshots(item.id), item.id).toBe(true);
        const uncaptured = offered().filter((item) => !hasScreenshots(item.id));
        expect(uncaptured.length).toBeGreaterThan(0);
        for (const item of uncaptured) expect(ids(featured)).not.toContain(item.id);
    });
});

describe("the preview a card shows", () => {
    it("is the first real capture, in the reader's language", () => {
        expect(appPreview("game-servers", "es-ES")?.dark.desktop).toBe(
            "/marketplace/games-dark-es-desktop.webp"
        );
        expect(appPreview("home", "en-US")?.light.mobile).toBe(
            "/marketplace/places-light-en-mobile.webp"
        );
    });

    it("is null for an app nobody has captured, so the card draws its placeholder", () => {
        expect(appPreview("messaging-bridge", "en-US")).toBeNull();
        expect(appPreview("not-an-app", "en-US")).toBeNull();
    });
});

describe("the action a card leads with", () => {
    const base = { installs: [], canInstall: true, installing: false };

    it("offers Install, with Configure only for an app that runs a container", () => {
        expect(primaryAction(app("messaging-bridge"), base)).toEqual({
            kind: "install",
            configurable: true
        });
        expect(primaryAction(app("calendar"), base)).toEqual({
            kind: "install",
            configurable: false
        });
    });

    it("says why instead of offering Install to a reader without the permission", () => {
        expect(primaryAction(app("calendar"), { ...base, canInstall: false })).toEqual({
            kind: "locked"
        });
    });

    it("shows Installing for the press in flight and for an install still coming up", () => {
        expect(primaryAction(app("calendar"), { ...base, installing: true })).toEqual({
            kind: "installing"
        });
        expect(
            primaryAction(app("messaging-bridge"), {
                ...base,
                installs: [{ id: "i-1", status: "installing" }]
            })
        ).toEqual({ kind: "installing" });
    });

    it("opens an installed app where it lives, even for a reader who could not install it", () => {
        expect(
            primaryAction(app("calendar"), {
                ...base,
                canInstall: false,
                installs: [{ id: "i-1", status: "stopped" }]
            })
        ).toEqual({ kind: "open", href: "/calendar" });
        expect(
            primaryAction(app("messaging-bridge"), {
                ...base,
                installs: [{ id: "i-2", status: "running" }]
            })
        ).toEqual({ kind: "open", href: "/apps/installed/i-2" });
    });

    it("never offers an app that is only announced", () => {
        expect(primaryAction(app("openclaw"), base)).toEqual({ kind: "comingSoon" });
    });

    it("badges a running install by its status and a builtin one as installed", () => {
        expect(installBadge(app("messaging-bridge"), [{ id: "i", status: "running" }])).toEqual({
            kind: "status",
            status: "running"
        });
        expect(installBadge(app("calendar"), [{ id: "i", status: "stopped" }])).toEqual({
            kind: "installed"
        });
        expect(installBadge(app("calendar"), [])).toBeNull();
    });
});
