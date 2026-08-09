/**
 * Decisions that had to wait.
 *
 * The two things worth pinning are the ones that would be silent if they were
 * wrong: a payload nobody can read must apply nothing, and an entry that has
 * lapsed must be dropped rather than carried out a month late.
 */

import { describe, expect, it } from "vitest";
import { maxStackFor } from "@/lib/apps/minecraft/items";
import {
    NEEDS_PLAYER,
    QUEUED_KINDS,
    QUEUE_TTL_MS,
    describeQueued,
    parseQueuedPayload,
    waitingOn,
    type QueuedAction
} from "@/lib/apps/minecraft/queue";

function waiting(overrides: Partial<QueuedAction> = {}): QueuedAction {
    return {
        id: "1",
        username: "Alex",
        kind: "give",
        payload: { kind: "give", item: "minecraft:stone", count: 4 },
        needsPlayer: true,
        expiresAt: new Date(Date.now() + QUEUE_TTL_MS).toISOString(),
        lastError: null,
        createdAt: new Date().toISOString(),
        ...overrides
    };
}

describe("what waits for whom", () => {
    it("holds an item back until the player is there", () => {
        expect(NEEDS_PLAYER.give).toBe(true);
        expect(NEEDS_PLAYER["set-slot"]).toBe(true);
        expect(NEEDS_PLAYER.clear).toBe(true);
    });

    it("does not hold a ban back for the person it is meant to keep out", () => {
        // Java writes a ban to its own list whether or not the name is connected,
        // so waiting for them to join would be waiting for the wrong thing.
        expect(NEEDS_PLAYER.ban).toBe(false);
        expect(NEEDS_PLAYER.pardon).toBe(false);
        expect(NEEDS_PLAYER.op).toBe(false);
        expect(NEEDS_PLAYER["whitelist-add"]).toBe(false);
    });

    it("has an answer for every kind there is", () => {
        for (const kind of QUEUED_KINDS) expect(typeof NEEDS_PLAYER[kind]).toBe("boolean");
    });

    it("says what it is waiting on", () => {
        expect(waitingOn(waiting())).toContain("join");
        expect(waitingOn(waiting({ needsPlayer: false }))).toContain("server");
    });
});

describe("reading a stored payload back", () => {
    it("round-trips each kind", () => {
        expect(parseQueuedPayload("give", '{"item":"minecraft:stone","count":4}')).toEqual({
            kind: "give",
            item: "minecraft:stone",
            count: 4
        });
        expect(parseQueuedPayload("ban", '{"reason":"Blew up spawn"}')).toEqual({
            kind: "ban",
            reason: "Blew up spawn"
        });
        expect(parseQueuedPayload("pardon", "{}")).toEqual({ kind: "pardon" });
    });

    it("applies nothing for a row it cannot read", () => {
        // A row written by an older version, or edited by hand. Applying the half
        // that parsed would be carrying out something nobody asked for.
        expect(parseQueuedPayload("give", "not json")).toBeNull();
        expect(parseQueuedPayload("give", '{"item":"minecraft:stone"}')).toBeNull();
        expect(parseQueuedPayload("give", '{"item":"minecraft:stone","count":0}')).toBeNull();
        expect(parseQueuedPayload("nonsense", "{}")).toBeNull();
    });
});

describe("what a waiting entry reads as", () => {
    it("says the thing itself, not the kind", () => {
        expect(describeQueued(waiting())).toBe("Give 4 x minecraft:stone");
        expect(describeQueued(waiting({ payload: { kind: "pardon" } }))).toBe("Lift the ban");
        expect(describeQueued(waiting({ payload: { kind: "ban", reason: "Griefing" } }))).toContain("Griefing");
        expect(
            describeQueued(waiting({ payload: { kind: "set-slot", slot: 3, item: "minecraft:tnt", count: 1 } }))
        ).toContain("slot 3");
    });
});

describe("how long a decision keeps", () => {
    it("is thirty days", () => {
        expect(QUEUE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    });
});

describe("stack ceilings", () => {
    it("knows the things that come one at a time", () => {
        expect(maxStackFor("minecraft:diamond_sword")).toBe(1);
        expect(maxStackFor("minecraft:iron_helmet")).toBe(1);
        expect(maxStackFor("minecraft:water_bucket")).toBe(1);
        expect(maxStackFor("minecraft:bucket_of_axolotl")).toBe(1);
        expect(maxStackFor("minecraft:oak_boat")).toBe(1);
    });

    it("knows the sixteens", () => {
        expect(maxStackFor("minecraft:ender_pearl")).toBe(16);
        expect(maxStackFor("minecraft:snowball")).toBe(16);
        expect(maxStackFor("minecraft:oak_sign")).toBe(16);
    });

    it("is sixty-four for everything else, which the server clamps anyway", () => {
        expect(maxStackFor("minecraft:stone")).toBe(64);
        expect(maxStackFor("minecraft:cobblestone")).toBe(64);
        expect(maxStackFor("some_mod:strange_thing")).toBe(64);
    });
});
