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
    isReadableRoster,
    offlineUuid,
    rosterNames,
    withOfflineIdentities,
    withOfflineNames,
    withoutInventedIdentities,
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

    // Matched whatever case it was written in, and then written under the name
    // that was asked for - both halves of it. The identity is a hash of the name
    // beside it, so replacing one and keeping the other is how a correct entry
    // becomes a pair no login will ever compute.
    it("leaves the name and the identity beside it agreeing", () => {
        const before = file([{ uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", name: "steve" }]);
        const after = JSON.parse(withOfflineNames(before, ["Steve"]) ?? "[]");
        expect(after).toHaveLength(1);
        expect(after[0]).toEqual({ uuid: offlineUuid("Steve"), name: "Steve" });
        expect(offlineUuid(after[0].name)).toBe(after[0].uuid);
    });

    // The server keys its rosters by the identity it computes, and it computes a
    // different one for each spelling. A row that already carries its own is a
    // player who can join right now, so renaming it to serve a request about
    // another spelling is that player locked out of a list still bearing a name
    // that looks like theirs.
    it("adds a spelling beside a working one rather than renaming it", () => {
        const before = file([{ uuid: offlineUuid("steve"), name: "steve" }]);
        const after = JSON.parse(withOfflineNames(before, ["Steve"]) ?? "[]");
        expect(after).toEqual([
            { uuid: offlineUuid("steve"), name: "steve" },
            { uuid: offlineUuid("Steve"), name: "Steve" }
        ]);
    });

    // Two spellings on the list, one of them broken. The request is about the
    // working one and must find it, not the broken row it case-matches.
    it("prefers the exact spelling over a broken one that only matches case", () => {
        const before = file([
            { uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", name: "Steve" },
            { uuid: offlineUuid("steve"), name: "steve" }
        ]);
        expect(withOfflineNames(before, ["steve"])).toBeNull();
    });

    // A server nobody has listed anybody on has no file at all, and that is an
    // empty roster: the first name goes onto it.
    it("writes the first name onto a file that is not there yet", () => {
        expect(rosterNames(withOfflineNames("", ["Steve"]) ?? "")).toEqual(["Steve"]);
    });

    // The game rewrites these files while it runs, so a read can land between its
    // own writes. Those names are not gone, they were not seen - and writing what
    // an empty roster would produce is a whitelist holding nobody but the player
    // being added, with everybody else quietly off the server.
    it("writes nothing at all over a file it could not read", () => {
        expect(withOfflineNames("{ not json", ["Steve"])).toBeNull();
        expect(withOfflineNames('[{"uuid":"0-0-0-0-1","na', ["Steve"])).toBeNull();
        expect(withoutName("{ not json", "Steve")).toBeNull();
        expect(isReadableRoster('[{"uuid":"0-0-0-0-1","na')).toBe(false);
        expect(isReadableRoster("")).toBe(true);
    });

    // One entry it cannot make sense of is still a file full of players. Reading
    // past it would drop every one of them.
    it("writes nothing over a file one of whose entries it could not read", () => {
        expect(withOfflineNames('[{"uuid":"0-0-0-0-1","name":null}]', ["Steve"])).toBeNull();
        expect(isReadableRoster('[{"uuid":"0-0-0-0-1","name":null}]')).toBe(false);
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

    // The ban list is where this costs the most. Two spellings are two players to
    // the server, so lifting one on the strength of the other is a ban silently
    // gone - and a name typed in another case is a known way round an offline ban.
    it("leaves another spelling that is a working identity of its own", () => {
        const before = file([
            { uuid: offlineUuid("Steve"), name: "Steve" },
            { uuid: offlineUuid("steve"), name: "steve" }
        ]);
        expect(rosterNames(withoutName(before, "Steve") ?? "")).toEqual(["steve"]);
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

    // Two spellings are two players, and the repair pass reaches the ban list.
    // Collapsing them there is one of two bans lifted by a sweep nobody ran.
    it("keeps two spellings of a name as the two players the server sees", () => {
        const before = file([
            { uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", name: "Steve" },
            { uuid: "853c80ef-3c37-49fd-aa49-938b674adae6", name: "steve" }
        ]);
        const after = JSON.parse(withOfflineIdentities(before) ?? "");
        expect(after).toEqual([
            { uuid: offlineUuid("Steve"), name: "Steve" },
            { uuid: offlineUuid("steve"), name: "steve" }
        ]);
    });

    it("has nothing to say about an empty or unreadable file", () => {
        expect(withOfflineIdentities("")).toBeNull();
        expect(withOfflineIdentities("[]")).toBeNull();
        expect(withOfflineIdentities("not json at all")).toBeNull();
    });
});

/**
 * The way back, for a server whose authentication was turned on again.
 *
 * The repair above only runs in one direction, and the setting it keys off is a
 * switch on the Settings screen. Flipped back, every entry Polaris wrote names a
 * player under an identity the login stops computing - so the file lists them,
 * the screen lists them, `whitelist list` lists them, and the server refuses
 * every one of them.
 */
describe("withoutInventedIdentities", () => {
    it("takes out the rows the authenticated login can no longer match", () => {
        const before = file([
            { uuid: offlineUuid("Steve"), name: "Steve" },
            { uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", name: "Alice" }
        ]);
        expect(rosterNames(withoutInventedIdentities(before, ["Steve", "Alice"]) ?? "")).toEqual(["Alice"]);
    });

    // Removing it is only ever the first half of putting the player back through
    // the game itself, so a name nobody is about to re-add is a name that stays.
    it("leaves a stranded row for somebody Polaris was not asked about", () => {
        const before = file([
            { uuid: offlineUuid("Steve"), name: "Steve" },
            { uuid: offlineUuid("Alice"), name: "Alice" }
        ]);
        expect(rosterNames(withoutInventedIdentities(before, ["Steve"]) ?? "")).toEqual(["Alice"]);
    });

    it("matches the name however it was spelled in the request", () => {
        const before = file([{ uuid: offlineUuid("Steve"), name: "Steve" }]);
        expect(rosterNames(withoutInventedIdentities(before, ["steve"]) ?? "")).toEqual([]);
    });

    // The pass that calls this runs every couple of minutes against every server,
    // and these files are rewritten by the game while it runs - so a file with
    // nothing to correct has to come back as nothing to write.
    it("says nothing about a file holding only identities Mojang issued", () => {
        const before = file([{ uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", name: "Steve" }]);
        expect(withoutInventedIdentities(before, ["Steve"])).toBeNull();
    });

    it("says nothing about an empty or unreadable file", () => {
        expect(withoutInventedIdentities("", ["Steve"])).toBeNull();
        expect(withoutInventedIdentities("[]", ["Steve"])).toBeNull();
        expect(withoutInventedIdentities("half a file {", ["Steve"])).toBeNull();
    });
});
