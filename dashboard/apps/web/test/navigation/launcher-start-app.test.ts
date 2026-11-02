/**
 * The app somebody chooses to open on entering Polaris: kept beside their
 * favorites, ignored the moment they cannot open it, and never in the way of a
 * screen turning somebody away.
 */

import { describe, expect, it } from "vitest";
import { homePathFor, startPathFor } from "@/lib/app-access";
import {
    arrangedPrefs,
    launcherPrefsSchema,
    parseLauncherPrefs,
    serializeLauncherPrefs
} from "@/lib/app-launcher";

const access = (held: readonly string[]) => ({
    isAdmin: false,
    can: async (permission: string) => held.includes(permission)
});

describe("the stored choice", () => {
    it("is kept alongside the lists, and survives being read back", () => {
        const prefs = { favorites: ["chat"], order: [], home: "chat" };
        expect(parseLauncherPrefs(serializeLauncherPrefs(prefs))).toEqual(prefs);
    });

    it("leaves an account that chose nothing storing what it always did", () => {
        expect(serializeLauncherPrefs({ favorites: ["chat"], order: [], home: null })).toBe(
            '["chat"]'
        );
        expect(serializeLauncherPrefs({ favorites: [], order: [], home: null })).toBeNull();
    });

    it("reads every older shape as no choice", () => {
        expect(parseLauncherPrefs('["chat"]').home).toBeNull();
        expect(parseLauncherPrefs('{"favorites":[],"order":["chat"]}').home).toBeNull();
    });

    it("forgets an app that no longer exists", () => {
        expect(parseLauncherPrefs('{"favorites":[],"order":[],"home":"gone"}').home).toBeNull();
    });

    it("tells a save that says nothing from one that clears it", () => {
        const older = launcherPrefsSchema.parse({ favorites: [], order: [] });
        const cleared = launcherPrefsSchema.parse({ favorites: [], order: [], home: null });
        expect(older).not.toHaveProperty("home");
        expect(cleared).toHaveProperty("home", null);
    });

    it("refuses an app that does not exist", () => {
        expect(
            launcherPrefsSchema.safeParse({ favorites: [], order: [], home: "gone" }).success
        ).toBe(false);
    });
});

describe("arranging the menu", () => {
    it("keeps favorites and the opening app", () => {
        const stored = { favorites: ["chat"], order: [], home: "drive" };
        const next = arrangedPrefs(stored, ["drive", "chat"]);
        expect(next.favorites).toEqual(["chat"]);
        expect(next.home).toBe("drive");
        expect(next.order).toEqual(["drive", "chat"]);
    });
});

describe("entering Polaris", () => {
    const ordinary = access(["drive.read", "chat.use"]);
    const admin = { isAdmin: true, can: async () => true };

    it("opens the chosen app", async () => {
        expect(await startPathFor(admin, "chat")).toBe("/chat");
    });

    it("lands where it always did with nothing chosen", async () => {
        expect(await startPathFor(ordinary, null)).toBe(await homePathFor(ordinary));
    });

    it("ignores a choice this account can no longer open", async () => {
        expect(await startPathFor(ordinary, "router")).toBe(await homePathFor(ordinary));
    });

    it("can choose the Overview itself", async () => {
        expect(await startPathFor(admin, "overview")).toBe("/home");
    });
});
