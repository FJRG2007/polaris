/**
 * Who an ARK server lets in.
 *
 * Two locks and both of them fail open if nobody checks: the image ships a join
 * password printed in its own README, and `-exclusivejoin` is one word inside a
 * string of launch options that anything editing that string could drop. So the
 * rules that decide a Steam id, a password and that one flag are checked here
 * rather than trusted to the form that renders them - the form is a view of these,
 * never the authority.
 *
 * The other thing worth pinning down is the difference between a player being on
 * the list and the server having been told about them. A new server spends its
 * first while installing thirty gigabytes and can be told nothing at all, so
 * "added" and "applied" are separate states, and collapsing them is what would
 * have a moderator adding somebody twice.
 */

import { describe, expect, it } from "vitest";
import * as access from "@/lib/apps/ark/access";

const ALICE = "76561198000000001";
const BOB = "76561198000000002";

describe("a Steam id", () => {
    it("is seventeen digits starting with the account prefix", () => {
        expect(access.isSteamId(ALICE)).toBe(true);
        expect(access.isSteamId(` ${ALICE} `)).toBe(true);
    });

    it("is not a name, a shorter number, or one that is not an account", () => {
        expect(access.isSteamId("Alice")).toBe(false);
        expect(access.isSteamId("765611980000")).toBe(false);
        expect(access.isSteamId("1234567890123456789")).toBe(false);
        // A vanity URL is what people actually have on hand, and it is not an id.
        expect(access.isSteamId("https://steamcommunity.com/id/alice")).toBe(false);
    });
});

describe("a join password", () => {
    it("is letters and digits, long enough to be worth having", () => {
        expect(access.isJoinPassword("Correct9Horse")).toBe(true);
        expect(access.isJoinPassword("abcd1234")).toBe(true);
    });

    it("refuses what ARK will not carry, and what is too short to matter", () => {
        expect(access.isJoinPassword("short1")).toBe(false);
        expect(access.isJoinPassword("has a space")).toBe(false);
        expect(access.isJoinPassword("punctuation!")).toBe(false);
        expect(access.isJoinPassword("")).toBe(false);
    });

    it("mints one that its own check accepts", () => {
        // The same source of randomness on both sides, so this is the generator
        // and the validator agreeing rather than a fixed string.
        const password = access.generateJoinPassword((size) => new Uint8Array(Array.from({ length: size }, (_, i) => i * 7)));
        expect(access.isJoinPassword(password)).toBe(true);
    });
});

describe("the closed-server flag", () => {
    it("is added without disturbing the options somebody else set", () => {
        expect(access.withExclusiveJoin("-PreventHibernation", true)).toBe("-PreventHibernation -exclusivejoin");
    });

    it("is taken out without taking the rest with it", () => {
        expect(access.withExclusiveJoin("-PreventHibernation -exclusivejoin -NoBattlEye", false)).toBe(
            "-PreventHibernation -NoBattlEye"
        );
    });

    it("is never added twice", () => {
        expect(access.withExclusiveJoin("-exclusivejoin", true)).toBe("-exclusivejoin");
    });

    it("is recognised whatever case it was written in", () => {
        expect(access.isExclusiveJoin("-ExclusiveJoin")).toBe(true);
        expect(access.isExclusiveJoin("-PreventHibernation")).toBe(false);
        expect(access.isExclusiveJoin(undefined)).toBe(false);
    });
});

describe("the allow list", () => {
    it("reads back what was written to the install", () => {
        const list = access.withPlayer([], { steamId: ALICE, label: "Alice" }, "2026-01-01T00:00:00.000Z");
        expect(access.readAllowList({ [access.ALLOW_LIST_KEY]: list })).toEqual(list);
    });

    it("is empty for an install that has none, and for one whose blob is nonsense", () => {
        expect(access.readAllowList({})).toEqual([]);
        expect(access.readAllowList({ [access.ALLOW_LIST_KEY]: "not a list" })).toEqual([]);
    });

    it("drops an entry whose id is not one the server could be told", () => {
        const rows = [{ steamId: "nonsense", label: "Mallory", addedAt: "x", appliedAt: null }];
        expect(access.readAllowList({ [access.ALLOW_LIST_KEY]: rows })).toEqual([]);
    });

    it("does not un-tell the server about somebody added twice", () => {
        const applied = [{ steamId: ALICE, label: "Alice", addedAt: "then", appliedAt: "then" }];
        const again = access.withPlayer(applied, { steamId: ALICE, label: "Alice again" }, "now");
        expect(again).toHaveLength(1);
        expect(again[0]?.appliedAt).toBe("then");
        expect(again[0]?.label).toBe("Alice again");
    });

    it("separates who is on it from who the server knows about", () => {
        const list = access.withPlayer(
            [{ steamId: ALICE, label: "Alice", addedAt: "then", appliedAt: "then" }],
            { steamId: BOB, label: "Bob" },
            "now"
        );
        expect(access.pendingPlayers(list).map((entry) => entry.steamId)).toEqual([BOB]);
    });

    it("takes somebody off without touching anybody else", () => {
        const list = access.withPlayer(access.withPlayer([], { steamId: ALICE, label: "Alice" }, "t"), { steamId: BOB, label: "Bob" }, "t");
        expect(access.withoutPlayer(list, ALICE).map((entry) => entry.steamId)).toEqual([BOB]);
    });
});
