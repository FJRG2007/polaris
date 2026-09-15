/**
 * The identity an unauthenticated Minecraft server gives a player.
 *
 * This is pinned harder than most of what is here because getting it wrong is
 * invisible from both ends: the roster file lists the player by name, the screen
 * shows them as allowed, and the server refuses them with a message that says
 * they are not on a list they are plainly on. Nothing logs a mismatch, because
 * from the server's point of view there is no mismatch - it looked up an identity
 * and did not find it.
 *
 * The vectors below are not invented. The algorithm that produces them was
 * checked against a real server first: the UUID it computes for a name is the one
 * that server had already written for that player itself, and correcting a live
 * whitelist to match let a player in who had been refused for hours.
 */

import { describe, expect, it } from "vitest";
import {
    isOfflineUuid,
    offlineUuid,
    rosterNames,
    withOfflineIdentities,
    withOfflineNames,
    withoutName
} from "@/lib/apps/minecraft/offline-identity";

/** A whitelist as the game writes one. */
function file(entries: readonly { uuid: string; name: string }[]): string {
    return `${JSON.stringify(entries, null, 2)}\n`;
}

describe("offlineUuid", () => {
    it("is the value the game itself computes for that name", () => {
        expect(offlineUuid("Steve")).toBe("5627dd98-e6be-3c21-b8a8-e92344183641");
        expect(offlineUuid("Alice")).toBe("10920508-d5d8-3eed-93d2-92f193afe7d7");
    });

    // Version 3 is the whole point: Mojang issues version 4, so an entry carrying
    // one of those is an entry the login can never match on this server.
    it("is version 3 with the RFC 4122 variant", () => {
        const uuid = offlineUuid("Steve");
        expect(uuid[14]).toBe("3");
        expect("89ab").toContain(uuid[19]);
        expect(isOfflineUuid(uuid)).toBe(true);
    });

    it("does not accept a Mojang uuid as one of its own", () => {
        // Version 4, which is what `whitelist add` writes into the file.
        expect(isOfflineUuid("069a79f4-44e9-4726-a5be-fca90e38aaf5")).toBe(false);
    });

    // The game treats these as two different players, so the hash must too.
    it("is case-sensitive", () => {
        expect(offlineUuid("steve")).not.toBe(offlineUuid("Steve"));
        expect(offlineUuid("steve")).toBe("53909932-f794-33c0-9329-948045a4c1ce");
    });

    it("is the same on every machine and every call", () => {
        expect(offlineUuid("Alice")).toBe(offlineUuid("Alice"));
    });
});

describe("withOfflineNames", () => {
    it("adds a name that is not there, under the computed identity", () => {
        const written = withOfflineNames("[]", ["Steve"]);
        expect(written).not.toBeNull();
        expect(JSON.parse(written ?? "")).toEqual([{ uuid: offlineUuid("Steve"), name: "Steve" }]);
    });

    // The repair for a list built by `whitelist add`: the name is already there and
    // the uuid beside it is the one the login will never look under.
    it("corrects an entry that carries a Mojang uuid", () => {
        const before = file([{ uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", name: "Steve" }]);
        const after = withOfflineNames(before, ["Steve"]);
        expect(JSON.parse(after ?? "")).toEqual([{ uuid: offlineUuid("Steve"), name: "Steve" }]);
    });

    it("leaves a file that already says exactly this alone", () => {
        const before = file([{ uuid: offlineUuid("Steve"), name: "Steve" }]);
        expect(withOfflineNames(before, ["Steve"])).toBeNull();
    });

    it("adds several at once and keeps what was already right", () => {
        const before = file([{ uuid: offlineUuid("Steve"), name: "Steve" }]);
        const after = withOfflineNames(before, ["Steve", "Alice"]);
        expect(rosterNames(after ?? "")).toEqual(["Steve", "Alice"]);
    });

    // An ops entry carries a permission level this module has no opinion about.
    it("keeps every other field on an entry it corrects", () => {
        const before = file([
            {
                uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5",
                name: "Steve",
                level: 4,
                bypassesPlayerLimit: false
            }
        ] as never);
        const after = JSON.parse(withOfflineNames(before, ["Steve"]) ?? "");
        expect(after[0]).toMatchObject({
            level: 4,
            bypassesPlayerLimit: false,
            uuid: offlineUuid("Steve")
        });
    });

    it("matches an existing entry whatever case it was written in", () => {
        const before = file([{ uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", name: "steve" }]);
        const after = JSON.parse(withOfflineNames(before, ["steve"]) ?? "");
        expect(after).toHaveLength(1);
    });

    // A file the server is halfway through writing must not throw a screen away.
    it("treats an unreadable file as an empty roster", () => {
        expect(rosterNames(withOfflineNames("{ not json", ["Steve"]) ?? "")).toEqual(["Steve"]);
        expect(rosterNames(withOfflineNames("", ["Steve"]) ?? "")).toEqual(["Steve"]);
    });

    it("ignores a blank name rather than writing an entry for nobody", () => {
        expect(withOfflineNames("[]", ["   "])).toBeNull();
    });
});

describe("withoutName", () => {
    it("takes the name off", () => {
        const before = file([
            { uuid: offlineUuid("Steve"), name: "Steve" },
            { uuid: offlineUuid("Alice"), name: "Alice" }
        ]);
        expect(rosterNames(withoutName(before, "Steve") ?? "")).toEqual(["Alice"]);
    });

    it("says nothing changed when the name was not on it", () => {
        expect(
            withoutName(file([{ uuid: offlineUuid("Alice"), name: "Alice" }]), "Steve")
        ).toBeNull();
    });

    // A list built by the old command can hold one player twice, once under each
    // kind of uuid. Removing them has to remove both or they stay half-allowed.
    it("takes every entry under that name, not the first", () => {
        const before = file([
            { uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", name: "Steve" },
            { uuid: offlineUuid("Steve"), name: "steve" }
        ]);
        expect(rosterNames(withoutName(before, "Steve") ?? "")).toEqual([]);
    });
});

describe("withOfflineIdentities", () => {
    it("rewrites a file whose uuids all came from Mojang", () => {
        const before = file([
            { uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", name: "Steve" },
            { uuid: "853c80ef-3c37-49fd-aa49-938b674adae6", name: "Alice" }
        ]);
        const after = JSON.parse(withOfflineIdentities(before) ?? "");
        expect(after).toEqual([
            { uuid: offlineUuid("Steve"), name: "Steve" },
            { uuid: offlineUuid("Alice"), name: "Alice" }
        ]);
    });

    // What a half-repaired list looks like: the dead entry and the working one,
    // both naming the same person.
    it("collapses a name that appears twice onto the entry that carried the rest", () => {
        const before = file([
            { uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", name: "Steve", level: 4 },
            { uuid: offlineUuid("Steve"), name: "Steve" }
        ] as never);
        const after = JSON.parse(withOfflineIdentities(before) ?? "");
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ uuid: offlineUuid("Steve"), level: 4 });
    });

    it("leaves a file that is already correct alone", () => {
        const before = file([{ uuid: offlineUuid("Steve"), name: "Steve" }]);
        expect(withOfflineIdentities(before)).toBeNull();
    });

    it("has nothing to say about an empty or unreadable file", () => {
        expect(withOfflineIdentities("")).toBeNull();
        expect(withOfflineIdentities("[]")).toBeNull();
        expect(withOfflineIdentities("not json at all")).toBeNull();
    });
});
