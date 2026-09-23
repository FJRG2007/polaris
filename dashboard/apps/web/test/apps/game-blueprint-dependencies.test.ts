/**
 * A blueprint that installs a plugin has to install what that plugin needs.
 *
 * Found by building all four plugin blueprints on real Docker and reading what
 * each server said. Three enabled their plugin. Skyblock installed
 * IridiumSkyblock, refused to load it -
 * `UnknownDependencyException: Unknown/missing dependency plugins: [Vault]` -
 * and then came up perfectly happily as an ordinary flat world with no skyblock
 * in it. Nothing on any screen said so; the server had reached "Done".
 *
 * Vault has only ever been published on SpigotMC, so the image's Modrinth
 * dependency resolution could not have fetched it however it was configured.
 * Installing it is what the SpigotMC list is for, and with it in place the same
 * server logs `[Vault] Enabling` and then `[IridiumSkyblock] Enabling`.
 */

import { describe, expect, it } from "vitest";
import {
    findBlueprint,
    GAME_BLUEPRINTS
} from "@polaris-app/game-servers/src/lib/minecraft/blueprints";
import { parseSpigetList } from "@polaris-app/game-servers/src/lib/minecraft/spiget";

/** Vault, on SpigotMC. The number is the resource page. */
const VAULT = 34315;

describe("what a blueprint installs beyond its own plugin", () => {
    it("gives Skyblock the library its plugin will not load without", () => {
        expect(findBlueprint("skyblock")?.spigot).toEqual([VAULT]);
    });

    it("asks for nothing from SpigotMC where the plugins did not need it", () => {
        // Parkour, Bed wars and the shrinking border each enabled on their own in
        // the same experiment, so adding resources for them would be installing
        // somebody else's jar for no reason.
        for (const id of ["parkour", "bedwars", "shrinking-world", "survival", "creative"]) {
            expect(findBlueprint(id)?.spigot ?? []).toEqual([]);
        }
    });

    it("only ever names whole resource numbers", () => {
        // The value is handed to the image as-is and a stray word in it is an
        // install that fails on every start.
        for (const blueprint of GAME_BLUEPRINTS) {
            const asked = blueprint.spigot ?? [];
            expect(parseSpigetList(asked.join(","))).toEqual([...asked]);
        }
    });
});
