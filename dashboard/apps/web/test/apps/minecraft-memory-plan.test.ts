/**
 * The heap a server is planned, and what stops the plan.
 *
 * The case this exists for is a real one: a server created for a few friends got
 * 1536 MB, later took a mod loader and six mods, and ran out of memory in the
 * middle of generating the world - which from inside the game looks like chunks
 * that stop appearing and mobs that stand still, with the tick rate reading a
 * perfect twenty. So the first thing asserted here is that those inputs no longer
 * produce that figure, and the rest is about the two things that must bound the
 * answer: what the operator allowed, and what the machine actually has.
 */

import { describe, expect, it } from "vitest";
import * as plan from "@polaris-app/game-servers/src/lib/minecraft/memory-plan";

describe("what a server is planned", () => {
    it("gives a vanilla server for a few friends about what it always got", () => {
        expect(plan.plannedHeapMb({ concurrentPlayers: 5, loader: "" })).toBe(1536);
    });

    it("no longer sizes a modded server as if it were vanilla", () => {
        // The Offgrid case: NeoForge, six mods, five people at a time. It was
        // running on 1536 MB and died in the lighting engine.
        const modded = plan.plannedHeapMb({ concurrentPlayers: 5, loader: "neoforge", mods: 6 });
        expect(modded).toBeGreaterThan(1536);
        expect(modded).toBe(3072);
    });

    it("counts a mod loader before any mod is installed on it", () => {
        const bare = plan.plannedHeapMb({ concurrentPlayers: 5, loader: "" });
        const loader = plan.plannedHeapMb({ concurrentPlayers: 5, loader: "fabric" });
        expect(loader - bare).toBeGreaterThanOrEqual(1024);
    });

    it("asks less of a plugin server than of a mod loader", () => {
        const plugins = plan.plannedHeapMb({ concurrentPlayers: 10, loader: "paper", mods: 8 });
        const mods = plan.plannedHeapMb({ concurrentPlayers: 10, loader: "neoforge", mods: 8 });
        expect(plugins).toBeLessThan(mods);
    });

    it("says what it counted, in words rather than in arithmetic", () => {
        expect(plan.planReason({ concurrentPlayers: 5, loader: "neoforge", mods: 6 })).toBe(
            "a mod loader, 6 mods, 5 players at a time"
        );
        expect(plan.planReason({ concurrentPlayers: 1, loader: "", mods: 0 })).toBe(
            "one player at a time"
        );
    });
});

describe("how many people to plan for", () => {
    it("plans for the crowd it actually gets, not the slots it offers", () => {
        expect(plan.playersToPlanFor(3, 20)).toBe(4);
        expect(plan.playersToPlanFor(12, 20)).toBe(12);
    });

    it("never plans for more people than the server lets in", () => {
        expect(plan.playersToPlanFor(30, 8)).toBe(8);
    });

    it("plans for somebody on a server nobody has joined yet", () => {
        expect(plan.playersToPlanFor(0, 20)).toBe(4);
    });
});

describe("what bounds a plan", () => {
    it("stops at the ceiling the operator set", () => {
        expect(plan.clampHeapMb(8192, { ceilingMb: 4096 })).toBe(4096);
    });

    it("stops at what the machine has left, whatever the ceiling says", () => {
        // 8 GB machine, 4 GB already promised to other servers, 2 GB kept for the
        // machine itself: 2 GB left.
        expect(
            plan.clampHeapMb(8192, {
                ceilingMb: 16384,
                machineTotalMb: 8192,
                otherServersMb: 4096
            })
        ).toBe(2048);
    });

    it("leaves a server running on a machine with nothing to spare", () => {
        // Not zero, and not a refusal: the server it is about is already running.
        expect(
            plan.clampHeapMb(4096, {
                machineTotalMb: 4096,
                otherServersMb: 4096
            })
        ).toBe(plan.FLOOR_MB);
    });

    it("bounds nothing it cannot measure", () => {
        expect(plan.clampHeapMb(4096, { machineTotalMb: null })).toBe(4096);
    });
});

describe("raising a server that has run out", () => {
    it("goes up by a step it is worth restarting for", () => {
        expect(plan.raisedHeapMb(2048, { ceilingMb: 8192 })).toBe(2048 + plan.RAISE_STEP_MB);
    });

    it("says there is nothing left rather than raising to the same figure", () => {
        expect(plan.raisedHeapMb(4096, { ceilingMb: 4096 })).toBeNull();
    });
});

describe("who decides", () => {
    it("treats a server that predates the plan as one somebody typed a figure for", () => {
        expect(plan.memoryMode(undefined)).toBe("fixed");
        expect(plan.memoryMode("auto")).toBe("auto");
        expect(plan.memoryMode("something else")).toBe("fixed");
    });

    it("falls back to the default ceiling rather than to no ceiling", () => {
        expect(plan.memoryCeilingMb(undefined)).toBe(plan.DEFAULT_CEILING_MB);
        expect(plan.memoryCeilingMb(64)).toBe(plan.DEFAULT_CEILING_MB);
        expect(plan.memoryCeilingMb(4096)).toBe(4096);
    });
});
