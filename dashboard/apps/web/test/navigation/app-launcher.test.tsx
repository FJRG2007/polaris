/**
 * The app switcher: Game servers as an app of its own, and the top row of the
 * launcher.
 *
 * What is asserted: Game servers is its own entry, gated on its install like
 * Places and Tools, and no longer a screen in the Apps rail; its path resolves to
 * it although Apps owns everything under /apps; the menu is one order - the
 * arranged one, then favorites, then by decayed use, then the registry - each
 * app once and only apps the account can open, for thirty-two apps as for nine;
 * a usage history that does not parse is none; the Overview rail is the
 * favorites in that order; arranging keeps apps the account cannot open today in
 * their slots; a stored list from before the menu could be arranged keeps its
 * favorites in their order; anything else unparseable is nothing chosen; and the
 * switcher draws each app once, as an icon and a name with no description.
 */

import { AppSwitcher } from "@polaris/ui";
import { describe, expect, it } from "vitest";
import { reachableApps } from "@/lib/app-access";
import { Gamepad2, HardDrive } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { APP_SECTIONS, POLARIS_APPS, resolveActiveApp } from "@/lib/apps";
import {
    LAUNCHER_ROW_SIZE,
    arrangeApps,
    arrangeFavorites,
    launcherOrder,
    launcherPrefsSchema,
    moveFavorite,
    parseAppUsage,
    parseLauncherPrefs,
    railApps,
    recordAppOpen,
    sameOrder,
    serializeLauncherPrefs,
    usageScore,
    type AppUsage
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

describe("the launcher's order", () => {
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
    const DAY = 24 * 60 * 60 * 1000;
    const NOW = Date.UTC(2026, 0, 31);
    /** `count` opens of `id`, the last `daysAgo` days before NOW. */
    const opened = (usage: AppUsage, id: string, count: number, daysAgo: number) => {
        let next = usage;
        for (let at = 0; at < count; at++) next = recordAppOpen(next, id, NOW - daysAgo * DAY);
        return next;
    };

    it("is the registry's order for somebody with no favorites, arrangement or use", () => {
        expect(launcherOrder({ available, favorites: [], now: NOW })).toEqual(available);
    });

    it("puts favorites first in their order, then the rest by use, then never-used apps in registry order", () => {
        const usage = opened(opened({}, "notes", 3, 1), "chat", 1, 1);
        expect(launcherOrder({ available, favorites: ["mail", "games"], usage, now: NOW })).toEqual(
            ["mail", "games", "notes", "chat", "overview", "drive", "vault", "apps", "tasks"]
        );
    });

    it("lets recent use outweigh more opens long ago", () => {
        // Ten opens two months ago are worth less than two this week.
        const usage = opened(opened({}, "drive", 10, 60), "tasks", 2, 2);
        const order = launcherOrder({ available, favorites: [], usage, now: NOW });
        expect(order.indexOf("tasks")).toBeLessThan(order.indexOf("drive"));
        expect(usageScore(usage.drive, NOW)).toBeCloseTo(10 * 0.5 ** (60 / 14), 6);
    });

    it("breaks a tie in use by the latest open", () => {
        const usage: AppUsage = {
            vault: { score: 1, at: NOW - DAY },
            drive: { score: 1, at: NOW - DAY }
        };
        const order = launcherOrder({ available, favorites: [], usage, now: NOW - DAY });
        expect(order.slice(0, 2)).toEqual(["drive", "vault"]);
        const later = { ...usage, vault: { score: 1, at: NOW - DAY + 1 } };
        expect(
            launcherOrder({ available, favorites: [], usage: later, now: NOW - DAY + 1 })[0]
        ).toBe("vault");
    });

    it("keeps the arranged order above favorites and use, and puts apps it does not name after it", () => {
        const usage = opened({}, "notes", 5, 0);
        expect(
            launcherOrder({
                available,
                arranged: ["chat", "drive", "overview"],
                favorites: ["mail"],
                usage,
                now: NOW
            })
        ).toEqual([
            "chat",
            "drive",
            "overview",
            "mail",
            "notes",
            "vault",
            "apps",
            "games",
            "tasks"
        ]);
    });

    it("never draws an app the account cannot open, and draws each app once", () => {
        expect(
            launcherOrder({
                available: ["drive", "chat"],
                arranged: ["admin", "chat", "chat"],
                favorites: ["admin", "drive"],
                usage: opened({}, "mail", 4, 0),
                now: NOW
            })
        ).toEqual(["chat", "drive"]);
    });

    it("orders thirty-two apps, each once", () => {
        const ids = Array.from({ length: 32 }, (_, at) => `fixture-${at + 1}`);
        const order = launcherOrder({
            available: ids,
            arranged: ["fixture-30"],
            favorites: ["fixture-7", "fixture-2"],
            now: NOW
        });
        expect([...order].sort()).toEqual([...ids].sort());
        expect(order.slice(0, 4)).toEqual(["fixture-30", "fixture-7", "fixture-2", "fixture-1"]);
    });
});

describe("app usage", () => {
    it("counts listed apps only, so it never outgrows the catalogue", () => {
        expect(recordAppOpen({}, "nope", 1)).toEqual({});
        expect(recordAppOpen({}, "account", 1)).toEqual({});
        expect(recordAppOpen({}, "chat", 5)).toEqual({ chat: { score: 1, at: 5 } });
    });

    it("reads a corrupt history as none and drops what is not an app", () => {
        expect(parseAppUsage(null)).toEqual({});
        expect(parseAppUsage("chat")).toEqual({});
        expect(parseAppUsage({ chat: { score: -1, at: 1 } })).toEqual({});
        expect(parseAppUsage({ chat: { score: "1", at: 1 } })).toEqual({});
        expect(parseAppUsage({ chat: { score: 2, at: 10 }, nope: { score: 1, at: 1 } })).toEqual({
            chat: { score: 2, at: 10 }
        });
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

    it("lists the favorites in the order the menu was arranged in", () => {
        expect(
            railApps({
                available: ["overview", "drive", "chat", "mail", "notes"],
                favorites: ["mail", "drive", "notes"],
                arranged: ["drive", "chat", "mail"]
            })
        ).toEqual(["drive", "mail", "notes"]);
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

    it("keeps arranged apps this account cannot open in their slots, and adds new ones at the end", () => {
        expect(arrangeApps([], ["chat", "mail"])).toEqual(["chat", "mail"]);
        expect(arrangeApps(["mail", "admin", "drive"], ["drive", "chat", "mail"])).toEqual([
            "drive",
            "admin",
            "chat",
            "mail"
        ]);
    });

    it("tells an unchanged order from a changed one", () => {
        expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true);
        expect(sameOrder(["a", "b"], ["b", "a"])).toBe(false);
        expect(sameOrder(["a"], ["a", "b"])).toBe(false);
    });
});

describe("stored favorites", () => {
    it("accepts real apps in the account's order", () => {
        expect(launcherPrefsSchema.parse(["mail", "drive"])).toEqual(["mail", "drive"]);
    });

    it("refuses an app that does not exist, a hidden one, or one twice", () => {
        expect(launcherPrefsSchema.safeParse(["nope"]).success).toBe(false);
        expect(launcherPrefsSchema.safeParse(["account"]).success).toBe(false);
        expect(launcherPrefsSchema.safeParse(["mail", "mail"]).success).toBe(false);
        expect(launcherPrefsSchema.safeParse("mail").success).toBe(false);
    });

    it("reads anything unusable as nothing pinned", () => {
        expect(parseLauncherPrefs(null).favorites).toEqual([]);
        expect(parseLauncherPrefs("{not json").favorites).toEqual([]);
        expect(parseLauncherPrefs('["nope"]').favorites).toEqual([]);
        expect(parseLauncherPrefs('["chat"]').favorites).toEqual(["chat"]);
        expect(parseLauncherPrefs('["nope","chat","chat"]').favorites).toEqual(["chat"]);
    });

    it("keeps a list stored before the menu could be arranged, in its order", () => {
        const stored = parseLauncherPrefs('["mail","drive","chat"]');
        expect(stored).toEqual({ favorites: ["mail", "drive", "chat"], order: [] });
        expect(
            launcherOrder({
                available: ["drive", "chat", "mail", "notes"],
                arranged: stored.order,
                favorites: stored.favorites,
                now: 0
            })
        ).toEqual(["mail", "drive", "chat", "notes"]);
    });

    it("stores the old list until the menu is arranged, and both lists after", () => {
        expect(serializeLauncherPrefs({ favorites: [], order: [] })).toBeNull();
        expect(serializeLauncherPrefs({ favorites: ["mail"], order: [] })).toBe('["mail"]');
        const both = serializeLauncherPrefs({ favorites: ["mail"], order: ["chat", "mail"] });
        expect(parseLauncherPrefs(both)).toEqual({ favorites: ["mail"], order: ["chat", "mail"] });
    });

    it("reads a stored arrangement that is not usable as none, keeping what is", () => {
        const stored = JSON.stringify({ favorites: "mail", order: ["chat", "nope", "chat"] });
        expect(parseLauncherPrefs(stored)).toEqual({ favorites: [], order: ["chat"] });
        expect(parseLauncherPrefs("42")).toEqual({ favorites: [], order: [] });
        expect(parseLauncherPrefs(JSON.stringify(null))).toEqual({ favorites: [], order: [] });
    });

    it("accepts a save of both lists, or of the favorites alone from an older tab", () => {
        expect(launcherPrefsSchema.parse({ favorites: ["mail"], order: ["chat"] })).toEqual({
            favorites: ["mail"],
            order: ["chat"]
        });
        expect(launcherPrefsSchema.parse(["mail"])).toEqual(["mail"]);
        expect(launcherPrefsSchema.safeParse({ favorites: ["mail"] }).success).toBe(false);
        expect(
            launcherPrefsSchema.safeParse({ favorites: [], order: ["chat", "chat"] }).success
        ).toBe(false);
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
                order={["games"]}
            />
        );
        expect(html).toContain("Game servers");
        expect(html).not.toContain("Files across every NAS");
    });
});
