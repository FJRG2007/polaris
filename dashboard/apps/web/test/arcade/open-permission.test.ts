/**
 * `arcade.open` on the server: the Games page refuses whoever lacks it, and the
 * menu entry asks for the same permission and for the app being installed.
 */

import { describe, expect, it, vi } from "vitest";

const held = vi.hoisted(() => ({ permissions: new Set<string>() }));

class Refused extends Error {}

vi.mock("@polaris/app-host", () => ({
    host: {
        session: {
            requirePermission: async (permission: string) => {
                if (!held.permissions.has(permission)) throw new Refused(permission);
            }
        }
    }
}));
vi.mock("@polaris/ui", () => ({ PAGE_FILL: "fill" }));
vi.mock("next/navigation", () => ({
    notFound: () => {
        throw new Error("not found");
    }
}));
vi.mock("../../../arcade/src/screens/library", () => ({ GamesScreen: () => null }));

const { default: GamesPage } = await import("../../../arcade/src/routes/games/[[...path]]/page");
const { POLARIS_APPS } = await import("@/lib/apps");

const params = (path?: string[]) => ({ params: Promise.resolve(path ? { path } : {}) });

describe("arcade.open", () => {
    it("is required by the Games page, for the library and for a game", async () => {
        held.permissions = new Set(["arcade.calls"]);
        await expect(GamesPage(params())).rejects.toBeInstanceOf(Refused);
        await expect(GamesPage(params(["new-york"]))).rejects.toBeInstanceOf(Refused);
    });

    it("opens the page for somebody who holds it", async () => {
        held.permissions = new Set(["arcade.open"]);
        await expect(GamesPage(params())).resolves.toBeTruthy();
        await expect(GamesPage(params(["no-such-game"]))).rejects.toThrow("not found");
    });

    it("gates the menu entry, which needs the app installed too", () => {
        const entry = POLARIS_APPS.find((app) => app.id === "arcade");
        expect(entry).toMatchObject({
            href: "/games",
            permission: "arcade.open",
            requiresApp: "arcade"
        });
    });
});
