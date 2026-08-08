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
import { parseMemoryMb } from "@/lib/apps/games-service";
import { blueprintsFor, findBlueprint, formatMemory, recommendedMemoryMb } from "@/lib/apps/minecraft/blueprints";

describe("recommendedMemoryMb", () => {
    it("gives a small server enough to run at all", () => {
        expect(recommendedMemoryMb(1)).toBeGreaterThanOrEqual(1536);
    });

    it("grows with the players actually on, not the slots", () => {
        expect(recommendedMemoryMb(40)).toBeGreaterThan(recommendedMemoryMb(8));
    });

    it("asks a minigame blueprint for more than a survival one at the same size", () => {
        expect(recommendedMemoryMb(20, "heavy")).toBeGreaterThan(recommendedMemoryMb(20, "normal"));
        expect(recommendedMemoryMb(20, "light")).toBeLessThan(recommendedMemoryMb(20, "normal"));
    });

    // Past this the answer is a second server, not a bigger heap - and a number
    // above what the machine has would simply fail to start.
    it("stops at a heap a machine can actually give", () => {
        expect(recommendedMemoryMb(1000, "heavy")).toBeLessThanOrEqual(12288);
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

    // A server whose memory cannot be read counts as nothing rather than as a
    // guess, so placement never reports capacity that is not there.
    it("counts an unreadable value as nothing", () => {
        expect(parseMemoryMb("")).toBe(0);
        expect(parseMemoryMb("lots")).toBe(0);
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

    it("marks every plugin optional, so a new Minecraft release cannot stop the server booting", () => {
        for (const blueprint of blueprintsFor("java")) {
            for (const project of blueprint.projects) expect(project.endsWith("?")).toBe(true);
        }
    });
});
