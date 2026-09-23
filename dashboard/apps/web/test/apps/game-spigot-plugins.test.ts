/**
 * Plugins from SpigotMC, which is where most of them are published.
 *
 * The list the image installs from is a row of resource numbers, so what is
 * pinned here is the reading and writing of that row, and the two kinds of
 * resource that look installable and are not: a paid one and one whose download
 * button sends you somewhere else. Both download as an HTML page that the server
 * then tries to load as a jar.
 */

import { describe, expect, it } from "vitest";
import { findApp, tunableEnvVars } from "@/lib/apps/catalog";
import { formatSpigetList, parseSpigetList, SPIGET_KEY } from "@polaris-app/game-servers/src/lib/minecraft/spiget";

describe("the list the image installs from", () => {
    it("reads the numbers a server carries", () => {
        expect(parseSpigetList("9089,34315")).toEqual([9089, 34315]);
        expect(parseSpigetList(" 9089 , 34315 ")).toEqual([9089, 34315]);
    });

    it("drops anything that is not a resource number", () => {
        // The value is handed to the image as-is, and a word in it is a plugin
        // install that fails on every start.
        expect(parseSpigetList("9089,essentials,0,-4,")).toEqual([9089]);
        expect(parseSpigetList("")).toEqual([]);
    });

    it("never writes the same plugin twice", () => {
        expect(parseSpigetList("9089,9089")).toEqual([9089]);
        expect(formatSpigetList([9089, 9089, 34315])).toBe("9089,34315");
    });

    it("writes it the way the image reads it", () => {
        expect(formatSpigetList([9089, 34315])).toBe("9089,34315");
        expect(formatSpigetList([])).toBe("");
    });
});

describe("where the list lives", () => {
    it("is a setting a server already running can be given", () => {
        const manifest = findApp("minecraft");
        expect(tunableEnvVars(manifest!).some((entry) => entry.key === SPIGET_KEY)).toBe(true);
    });

    it("is seeded only on a server that runs plugins", () => {
        // On a modded server every one of these is a jar the server cannot read.
        const field = findApp("minecraft")?.template?.env?.find((entry) => entry.key === SPIGET_KEY);
        expect(field?.pluginServersOnly).toBe(true);
        expect(field?.default).toBe("");
    });
});
