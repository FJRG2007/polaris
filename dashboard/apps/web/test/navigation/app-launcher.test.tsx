/**
 * The app switcher: Game servers as an app of its own, and the top row of the
 * launcher.
 *
 * What is asserted: Game servers is its own entry, gated on its install like
 * Places and Tools, and no longer a screen in the Apps rail; its path resolves to
 * it although Apps owns everything under /apps; the menu is favorites, then a
 * row of recent apps, then a shelf per category, each app once and only apps the
 * account can open - for thirty-two apps as for nine; the Overview rail is the
 * favorites; arranging keeps favorites the account cannot open today; a stored list
 * that is not a list of real apps is read as nothing pinned; and the switcher
 * draws each app once, as an icon and a name with no description.
 */

import { AppSwitcher } from "@polaris/ui";
import { describe, expect, it } from "vitest";
import { reachableApps } from "@/lib/app-access";
import { Gamepad2, HardDrive } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { APP_CATEGORIES, APP_SECTIONS, POLARIS_APPS, resolveActiveApp } from "@/lib/apps";
import {
    LAUNCHER_ROW_SIZE,
    RECENT_APPS,
    arrangeFavorites,
    favoriteAppsSchema,
    launcherLayout,
    moveFavorite,
    parseFavoriteApps,
    railApps,
    sameOrder
} from "@/lib/app-launcher";

describe("Game servers in the switcher", () => {
    it("is an app of its own, turned on by its install", async () => {
        const games = POLARIS_APPS.find((app) => app.id === "games");
        expect(games).toMatchObject({
            label: "Game servers",
            href: "/apps/games",
            requiresApp: "game-servers"
        });
        const reach = (installed: string[]) =>
            reachableApps({
                isAdmin: true,
                can: async () => true,
                isInstalled: async (id) => installed.includes(id)
            });
        expect((await reach([])).map((app) => app.id)).not.toContain("games");
        expect((await reach(["game-servers"])).map((app) => app.id)).toContain("games");
    });

    it("is no longer a screen of Apps", () => {
        expect(APP_SECTIONS.apps?.some((section) => section.href === "/apps/games")).toBe(false);
    });

    it("owns its path inside the Apps subtree, and Apps keeps the rest", () => {
        expect(resolveActiveApp("/apps/games").id).toBe("games");
        expect(resolveActiveApp("/apps/games/anything").id).toBe("games");
        expect(resolveActiveApp("/apps/deploy").id).toBe("apps");
        expect(resolveActiveApp("/apps/gamesroom").id).toBe("apps");
        expect(resolveActiveApp("/apps/installed/abc").id).toBe("apps");
    });
});

describe("the launcher's layout", () => {
    const available = [
        "overview",
        "drive",
        "vault",
        "apps",
        "games",
        "tasks",
        "chat",
        "mail",
        "notes"
    ];

    it("puts favorites first in their order, then recent apps, each once", () => {
        const layout = launcherLayout({
            available,
            favorites: ["mail", "games"],
            recent: ["chat", "mail", "chat", "notes", "drive", "vault"]
        });
        expect(layout.favorites).toEqual(["mail", "games"]);
        expect(layout.recent).toEqual(["chat", "notes", "drive"]);
        expect(layout.recent).toHaveLength(RECENT_APPS);
    });

    it("files every other app on its category's shelf, in the order the shelves are declared", () => {
        const layout = launcherLayout({ available, favorites: ["mail"], recent: ["drive"] });
        expect(layout.shelves).toEqual([
            { category: "work", ids: ["overview", "tasks", "notes"] },
            { category: "communication", ids: ["chat"] },
            { category: "infrastructure", ids: ["apps"] },
            { category: "games", ids: ["games"] },
            { category: "tools", ids: ["vault"] }
        ]);
    });

    it("keeps every favorite, however many there are", () => {
        const favorites = available.slice(0, 8).reverse();
        expect(launcherLayout({ available, favorites, recent: [] }).favorites).toEqual(favorites);
    });

    it("never draws an app the account cannot open", () => {
        const layout = launcherLayout({
            available: ["drive", "chat"],
            favorites: ["admin"],
            recent: ["home"]
        });
        expect(layout).toEqual({
            favorites: [],
            recent: [],
            shelves: [
                { category: "work", ids: ["drive"] },
                { category: "communication", ids: ["chat"] }
            ]
        });
    });

    it("draws thirty-two apps once each, on six shelves", () => {
        const categories = APP_CATEGORIES.map((category) => category.id);
        const ids = Array.from({ length: 32 }, (_, at) => `fixture-${at + 1}`);
        const categoryOf = (id: string) => categories[Number(id.split("-")[1]) % categories.length];
        const layout = launcherLayout({
            available: ids,
            favorites: ["fixture-7", "fixture-2"],
            recent: ["fixture-30", "fixture-7", "fixture-11"],
            categoryOf
        });
        const drawn = [
            ...layout.favorites,
            ...layout.recent,
            ...layout.shelves.flatMap((shelf) => shelf.ids)
        ];
        expect(drawn.sort()).toEqual([...ids].sort());
        expect(layout.shelves.map((shelf) => shelf.category)).toEqual(categories);
        expect(layout.recent).toEqual(["fixture-30", "fixture-11"]);
    });

    it("gives every app in the catalogue a shelf that exists", () => {
        const shelves = new Set<string>(APP_CATEGORIES.map((category) => category.id));
        for (const app of POLARIS_APPS) expect(shelves.has(app.category)).toBe(true);
    });
});

describe("the Overview rail", () => {
    it("lists only the favorites, in their order, never the Overview itself", () => {
        expect(
            railApps({
                available: ["overview", "drive", "chat", "mail"],
                favorites: ["mail", "overview", "drive"]
            })
        ).toEqual(["mail", "drive"]);
    });

    it("falls back to the first apps for somebody with no favorites they can open", () => {
        const available = ["overview", "drive", "vault", "apps", "tasks", "chat", "mail", "notes"];
        expect(railApps({ available, favorites: ["admin"] })).toEqual(
            available.slice(1, 1 + LAUNCHER_ROW_SIZE)
        );
    });
});

describe("arranging favorites", () => {
    it("moves one app and clamps at the ends", () => {
        expect(moveFavorite(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
        expect(moveFavorite(["a", "b", "c"], "a", 3)).toEqual(["b", "c", "a"]);
        const same = ["a", "b", "c"];
        expect(moveFavorite(same, "a", -1)).toBe(same);
    });

    it("keeps favorites this account cannot open in their slots", () => {
        // "admin" is a favorite from a role somebody held last week.
        expect(
            arrangeFavorites(["mail", "admin", "drive", "chat"], ["chat", "mail", "drive"])
        ).toEqual(["chat", "admin", "mail", "drive"]);
    });

    it("tells an unchanged order from a changed one", () => {
        expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true);
        expect(sameOrder(["a", "b"], ["b", "a"])).toBe(false);
        expect(sameOrder(["a"], ["a", "b"])).toBe(false);
    });
});

describe("stored favorites", () => {
    it("accepts real apps in the account's order", () => {
        expect(favoriteAppsSchema.parse(["mail", "drive"])).toEqual(["mail", "drive"]);
    });

    it("refuses an app that does not exist, a hidden one, or one twice", () => {
        expect(favoriteAppsSchema.safeParse(["nope"]).success).toBe(false);
        expect(favoriteAppsSchema.safeParse(["account"]).success).toBe(false);
        expect(favoriteAppsSchema.safeParse(["mail", "mail"]).success).toBe(false);
        expect(favoriteAppsSchema.safeParse("mail").success).toBe(false);
    });

    it("reads anything unusable as nothing pinned", () => {
        expect(parseFavoriteApps(null)).toEqual([]);
        expect(parseFavoriteApps("{not json")).toEqual([]);
        expect(parseFavoriteApps('["nope"]')).toEqual([]);
        expect(parseFavoriteApps('["chat"]')).toEqual(["chat"]);
        expect(parseFavoriteApps('["nope","chat","chat"]')).toEqual(["chat"]);
    });
});

describe("the switcher", () => {
    const apps = [
        {
            id: "drive",
            label: "Drive",
            description: "Files across every NAS",
            icon: HardDrive,
            href: "/drive"
        },
        {
            id: "games",
            label: "Game servers",
            description: "Servers",
            icon: Gamepad2,
            href: "/apps/games"
        }
    ];

    it("draws the trigger for the app somebody is in", () => {
        const html = renderToStaticMarkup(
            <AppSwitcher
                apps={apps}
                currentAppId="games"
                sections={[{ key: "favorites", label: "Favorites", ids: ["games"] }]}
                pinned={["games"]}
                onTogglePin={() => undefined}
            />
        );
        expect(html).toContain("Game servers");
        expect(html).not.toContain("Files across every NAS");
    });
});
