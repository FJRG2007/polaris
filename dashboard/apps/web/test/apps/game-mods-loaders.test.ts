/**
 * Every server the catalogue can create can open its mods screen.
 *
 * The browser route checked the loader against five literals written out beside
 * it. The day the software catalogue grew it could produce three more - `quilt`,
 * `folia`, and the `bukkit` the hybrids are filed under - and a server created on
 * any of them opened its Mods tab and got "Could not read this server's list".
 * Creatable and broken, which is the exact failure the catalogue exists to
 * remove, reintroduced one file away from it.
 */

import { describe, expect, it } from "vitest";
import {
    isBrowsableLoader,
    MINECRAFT_SOFTWARE,
    modrinthLoaders,
    modrinthLoaderOf
} from "@polaris/core";
import {
    categoriesForLoader,
    isPluginLoader
} from "@polaris-app/game-servers/src/lib/minecraft/modrinth";

describe("the loaders the mods browser answers for", () => {
    it("covers every software the catalogue can create", () => {
        for (const entry of MINECRAFT_SOFTWARE) {
            if (entry.loader === null) continue;
            expect(isBrowsableLoader(entry.loader)).toBe(true);
        }
    });

    it("includes the ones that were missing", () => {
        for (const loader of ["quilt", "folia", "bukkit"]) {
            expect(modrinthLoaders()).toContain(loader);
        }
    });

    it("refuses anything no software is filed under", () => {
        // It goes into a query to somebody else's API, so it is a closed set even
        // though it is no longer a written-out one.
        expect(isBrowsableLoader("rhubarb")).toBe(false);
        expect(isBrowsableLoader("")).toBe(false);
    });

    it("knows which half of Modrinth each of them is", () => {
        // A plugin server and a modded one are filed under different tags for the
        // same idea, and asking for the wrong one answers with nothing at all
        // rather than with an error.
        expect(isPluginLoader(modrinthLoaderOf("ARCLIGHT") ?? "")).toBe(true);
        expect(isPluginLoader(modrinthLoaderOf("FOLIA") ?? "")).toBe(true);
        expect(isPluginLoader(modrinthLoaderOf("QUILT") ?? "")).toBe(false);
    });

    it("has something to browse by for every one of them", () => {
        for (const loader of modrinthLoaders()) {
            expect(categoriesForLoader(loader).length).toBeGreaterThan(0);
        }
    });
});
