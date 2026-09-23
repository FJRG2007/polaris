/**
 * The server software a Minecraft server can be created with.
 *
 * One list, and everything that reads it reads the same one: the settings field
 * on the manifest, the loader the mod browser searches under, the memory the heap
 * is planned from. What is pinned here is the part that is expensive to find out
 * any other way - the image exits with "Invalid TYPE" for a name it does not
 * dispatch on, hours after the create, in a log nobody opens.
 */

import { describe, expect, it } from "vitest";
import {
    findSoftware,
    isModpackReference,
    isServerJarUrl,
    isServerSoftware,
    MINECRAFT_SOFTWARE,
    modrinthLoaderOf,
    searchSoftware,
    softwareByGroup,
    softwareLabel,
    softwareSourceEnv
} from "@polaris/core";
import { findApp } from "@/lib/apps/catalog";
import { plannedHeapMb } from "@polaris-app/game-servers/src/lib/minecraft/memory-plan";

/** Every `TYPE` the image's own `start-configuration` dispatches on, read off
 *  that case block rather than remembered. Anything Polaris offers has to be in
 *  here, or it is a server that is created and never starts. */
const IMAGE_ACCEPTS = new Set([
    "VANILLA",
    "SPIGOT",
    "BUKKIT",
    "PAPER",
    "FOLIA",
    "PURPUR",
    "PUFFERFISH",
    "LEAF",
    "FABRIC",
    "QUILT",
    "FORGE",
    "NEOFORGE",
    "ARCLIGHT",
    "MOHIST",
    "YOUER",
    "BANNER",
    "KETTING",
    "MAGMA",
    "MAGMA_MAINTAINED",
    "SPONGEVANILLA",
    "LIMBO",
    "NANOLIMBO",
    "CRUCIBLE",
    "CANYON",
    "POSEIDON",
    "CUSTOM",
    "MODRINTH"
]);

describe("what a server may be created as", () => {
    it("offers nothing the image would refuse to start", () => {
        for (const entry of MINECRAFT_SOFTWARE) expect(IMAGE_ACCEPTS.has(entry.id)).toBe(true);
    });

    it("still offers everything it used to", () => {
        // The values servers already carry. A list that dropped one of these is a
        // server whose software cannot be selected on its own settings screen.
        for (const id of ["PAPER", "PURPUR", "SPIGOT", "FABRIC", "FORGE", "NEOFORGE", "VANILLA"])
            expect(isServerSoftware(id)).toBe(true);
    });

    it("refuses a name that only looks like server software", () => {
        expect(isServerSoftware("PAPERMC")).toBe(false);
        expect(isServerSoftware("")).toBe(false);
    });

    it("is the same list the settings field offers", () => {
        const field = findApp("minecraft")?.template?.env?.find((entry) => entry.key === "TYPE");
        expect(field?.options?.map((option) => option.value)).toEqual(
            MINECRAFT_SOFTWARE.map((entry) => entry.id)
        );
    });

    it("puts every entry on exactly one shelf", () => {
        const shelved = softwareByGroup().flatMap((shelf) => shelf.entries);
        expect(shelved).toHaveLength(MINECRAFT_SOFTWARE.length);
    });

    it("finds software by what somebody would type", () => {
        expect(searchSoftware("quilt").map((entry) => entry.id)).toEqual(["QUILT"]);
        expect(searchSoftware("modpack").map((entry) => entry.id)).toContain("MODRINTH");
        expect(searchSoftware("")).toHaveLength(MINECRAFT_SOFTWARE.length);
    });
});

describe("what follows from the choice", () => {
    it("searches Modrinth under the loader that software actually loads", () => {
        expect(modrinthLoaderOf("QUILT")).toBe("quilt");
        expect(modrinthLoaderOf("PURPUR")).toBe("paper");
        expect(modrinthLoaderOf("FOLIA")).toBe("folia");
        // Arclight is NeoForge underneath and takes Bukkit plugins on top, which
        // is the half of it Modrinth can answer about.
        expect(modrinthLoaderOf("ARCLIGHT")).toBe("bukkit");
    });

    it("knows the software nothing on Modrinth loads into", () => {
        for (const id of ["VANILLA", "CUSTOM", "MODRINTH", "LIMBO", "NANOLIMBO", "SPONGEVANILLA"])
            expect(modrinthLoaderOf(id)).toBeNull();
    });

    it("prices a hybrid as the mod loader it is, not as the plugins it takes", () => {
        const players = { concurrentPlayers: 4 };
        const arclight = plannedHeapMb({ ...players, loader: "bukkit", software: "ARCLIGHT" });
        const paper = plannedHeapMb({ ...players, loader: "paper", software: "PAPER" });
        // Priced off the Bukkit loader alone these two would be the same figure,
        // and Arclight would run out of memory merging its registries.
        expect(arclight).toBeGreaterThan(paper);
    });

    it("still prices a server stored before the catalogue existed", () => {
        expect(plannedHeapMb({ concurrentPlayers: 4, loader: "fabric" })).toBe(
            plannedHeapMb({ concurrentPlayers: 4, loader: "fabric", software: "FABRIC" })
        );
    });

    it("names software the way a person writes it", () => {
        expect(softwareLabel("NEOFORGE")).toBe("NeoForge");
        expect(softwareLabel("paper")).toBe("Paper");
        // Something this build has never heard of is still nameable, because the
        // server running it is real.
        expect(softwareLabel("AIRPLANE")).toBe("Airplane");
    });
});

describe("the one value some software asks for", () => {
    it("asks only where there is something to ask", () => {
        expect(findSoftware("MODRINTH")?.asks).toBe("modpack");
        expect(findSoftware("CUSTOM")?.asks).toBe("jar");
        expect(findSoftware("PAPER")?.asks).toBeUndefined();
    });

    it("accepts a pack by name or by link", () => {
        expect(isModpackReference("cobblemon-fabric")).toBe(true);
        expect(isModpackReference("https://modrinth.com/modpack/cobblemon-fabric")).toBe(true);
        expect(isModpackReference("")).toBe(false);
        expect(isModpackReference("a pack, the one with the trains")).toBe(false);
    });

    it("takes a jar over https and nothing else", () => {
        expect(isServerJarUrl("https://example.com/server.jar")).toBe(true);
        // http is a file anybody on the way can replace, and this file becomes
        // the server.
        expect(isServerJarUrl("http://example.com/server.jar")).toBe(false);
        expect(isServerJarUrl("https://example.com/server.zip")).toBe(false);
    });

    it("hands each one to the variable the image reads it from", () => {
        expect(softwareSourceEnv("MODRINTH", "cobblemon-fabric")).toEqual({
            MODRINTH_MODPACK: "cobblemon-fabric"
        });
        expect(softwareSourceEnv("CUSTOM", "https://example.com/server.jar")).toEqual({
            CUSTOM_SERVER: "https://example.com/server.jar"
        });
        expect(softwareSourceEnv("PAPER", "anything")).toEqual({});
    });

    it("compiles Spigot rather than pretending its downloads still work", () => {
        // Spigot stopped answering automated downloads, so the image's only route
        // is to build it. Without this the server never gets a jar at all.
        expect(findSoftware("SPIGOT")?.env).toEqual({ BUILD_FROM_SOURCE: "true" });
    });
});
