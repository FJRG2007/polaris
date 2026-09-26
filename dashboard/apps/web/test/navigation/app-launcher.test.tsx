/**
 * The app switcher: Game servers as an app of its own, and the top row of the
 * launcher.
 *
 * What is asserted: Game servers is its own entry, gated on its install like
 * Places and Tools, and no longer a screen in the Apps rail; its path resolves to
 * it although Apps owns everything under /apps; the top row is pins, then recent
 * apps, then suggested ones, only ever apps the account can open; a stored list
 * that is not a list of real apps is read as nothing pinned; and the switcher
 * draws each app once, as an icon and a name with no description.
 */

import { AppSwitcher } from "@polaris/ui";
import { describe, expect, it } from "vitest";
import { reachableApps } from "@/lib/app-access";
import { Gamepad2, HardDrive } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { APP_SECTIONS, POLARIS_APPS, resolveActiveApp } from "@/lib/apps";
import {
    LAUNCHER_ROW_SIZE,
    favoriteAppsSchema,
    launcherLayout,
    parseFavoriteApps
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

describe("the launcher's top row", () => {
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

    it("suggests the first apps somebody can open when there is nothing else", () => {
        const layout = launcherLayout({ available, favorites: [], recent: [] });
        expect(layout.featured).toEqual(available.slice(0, LAUNCHER_ROW_SIZE));
        expect(layout.pinned).toBe(false);
        expect(layout.rest).toEqual(available.slice(LAUNCHER_ROW_SIZE));
    });

    it("puts pins first, then recent apps, then suggestions, each once", () => {
        const layout = launcherLayout({
            available,
            favorites: ["mail", "games"],
            recent: ["chat", "mail", "chat", "notes"]
        });
        expect(layout.featured).toEqual(["mail", "games", "chat", "notes", "overview", "drive"]);
        expect(layout.pinned).toBe(true);
        expect([...layout.featured, ...layout.rest].sort()).toEqual([...available].sort());
    });

    it("keeps every pin, however many there are", () => {
        const favorites = available.slice(0, 8).reverse();
        expect(launcherLayout({ available, favorites, recent: [] }).featured).toEqual(favorites);
    });

    it("never draws an app the account cannot open", () => {
        const layout = launcherLayout({
            available: ["drive", "chat"],
            favorites: ["admin"],
            recent: ["places"]
        });
        expect(layout).toEqual({ featured: ["drive", "chat"], pinned: false, rest: [] });
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
                featured={["games"]}
                pinned={["games"]}
                onTogglePin={() => undefined}
            />
        );
        expect(html).toContain("Game servers");
        expect(html).not.toContain("Files across every NAS");
    });
});
