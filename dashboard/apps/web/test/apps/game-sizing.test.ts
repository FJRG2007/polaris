/**
 * How big a server has to be, and what a blueprint puts in it.
 *
 * Both are decided for the operator rather than asked of them, which is only an
 * improvement if the answers are right: a heap sized from the slot count instead
 * of from the players actually on would hand 200-slot servers 11 GB, and a
 * blueprint that quietly dropped the anticheat the manager installs would ship an
 * unprotected server that looks configured.
 */

import { describe, expect, it } from "vitest";
import { parseMemoryMb } from "@polaris-app/game-servers/src/lib/games-service";
import { blueprintsFor, findBlueprint, formatMemory } from "@polaris-app/game-servers/src/lib/minecraft/blueprints";
import { plannedHeapMb } from "@polaris-app/game-servers/src/lib/minecraft/memory-plan";

describe("the heap a server is sized with", () => {
    it("gives a small server enough to run at all", () => {
        expect(plannedHeapMb({ concurrentPlayers: 1 })).toBeGreaterThanOrEqual(1536);
    });

    it("grows with the players actually on, not the slots", () => {
        expect(plannedHeapMb({ concurrentPlayers: 40 })).toBeGreaterThan(
            plannedHeapMb({ concurrentPlayers: 8 })
        );
    });

    it("asks a minigame blueprint for more than a survival one at the same size", () => {
        expect(plannedHeapMb({ concurrentPlayers: 20, weight: "heavy" })).toBeGreaterThan(
            plannedHeapMb({ concurrentPlayers: 20, weight: "normal" })
        );
        expect(plannedHeapMb({ concurrentPlayers: 20, weight: "light" })).toBeLessThan(
            plannedHeapMb({ concurrentPlayers: 20, weight: "normal" })
        );
    });

    // What stops a runaway figure is no longer part of this sum: the ceiling the
    // operator set and what the machine actually has are applied where the plan is
    // applied, and they are asserted in the memory-plan tests.
    it("grows with a mod loader and with the mods on it", () => {
        const vanilla = plannedHeapMb({ concurrentPlayers: 8 });
        const loader = plannedHeapMb({ concurrentPlayers: 8, loader: "neoforge" });
        const modded = plannedHeapMb({ concurrentPlayers: 8, loader: "neoforge", mods: 10 });
        expect(loader).toBeGreaterThan(vanilla);
        expect(modded).toBeGreaterThan(loader);
    });

    it("lands on figures the image understands", () => {
        expect(formatMemory(2048)).toBe("2G");
        expect(formatMemory(2560)).toBe("2560M");
    });
});

describe("parseMemoryMb", () => {
    it("reads what was handed out, however it was written", () => {
        expect(parseMemoryMb("2G")).toBe(2048);
        expect(parseMemoryMb("2560M")).toBe(2560);
        expect(parseMemoryMb("1024")).toBe(1024);
    });

    // Written before the settings form corrected the spelling on the way in, and
    // still in the database. Read as nothing, one server's whole heap goes missing
    // from what the machine is judged to have promised.
    it("reads the spelling the JVM rejects but an operator still typed", () => {
        expect(parseMemoryMb("8GB")).toBe(8192);
        expect(parseMemoryMb("2048MB")).toBe(2048);
        expect(parseMemoryMb("8 gb")).toBe(8192);
    });

    // A server whose memory cannot be read counts as nothing rather than as a
    // guess, so placement never reports capacity that is not there.
    it("counts an unreadable value as nothing", () => {
        expect(parseMemoryMb("")).toBe(0);
        expect(parseMemoryMb("lots")).toBe(0);
        expect(parseMemoryMb("8TB")).toBe(0);
    });
});

describe("blueprints", () => {
    it("offers Bedrock only what Bedrock can run", () => {
        // Every plugin blueprint is Java: Bedrock loads no plugins at all.
        for (const blueprint of blueprintsFor("bedrock")) expect(blueprint.projects).toEqual([]);
    });

    it("pins the software its plugins need", () => {
        expect(findBlueprint("skyblock")?.software).toBe("PAPER");
    });

    it("requires every plugin, so a blueprint cannot boot as an ordinary server", () => {
        // These used to be optional, on the reasoning that a release the plugin had
        // not been rebuilt for should not stop the server starting. What it did
        // instead was start it as vanilla, silently - which is the whole of what a
        // Bed wars server looks like when BedWars1058 is not on it. The version is
        // pinned to one the plugins can run on before anything is created, so the
        // case this guarded against is handled where it belongs. Asserted again,
        // with the rest of that reasoning, in game-blueprint.test.ts.
        for (const blueprint of blueprintsFor("java")) {
            for (const project of blueprint.projects) expect(project.endsWith("?")).toBe(false);
        }
    });
});
