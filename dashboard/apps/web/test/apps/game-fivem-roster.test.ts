/**
 * One row per person, out of four lists that do not agree about who a person is.
 *
 * The fold is the whole of the players screen and it is where a bug would be
 * invisible: the same person appears as a connected client, as a row on the allow
 * list, as a ban and as an administrator, and only one of those four carries a
 * name. Folding on the wrong key produces a screen with two Alices on it, one of
 * which cannot be acted on - which reads as a broken button rather than as a
 * duplicate.
 *
 * The awkward case is that a connected client presents several identifiers at
 * once. Somebody added by their Discord id has to be the same row as the player
 * whose licence the server is reporting, or the operator adds them a second time.
 */

import { describe, expect, it } from "vitest";
import { foldFivemPlayers, matchesFivemFilter, matchesFivemPlayer } from "@/lib/apps/fivem/roster";

const LICENSE = "license:0123456789abcdef0123456789abcdef01234567";
const DISCORD = "discord:112233445566778899";
const NOW = "2026-08-24T10:00:00.000Z";

const ALICE = {
    id: 3,
    name: "Alice",
    ping: 42,
    identifiers: [LICENSE, DISCORD],
    endpoint: null
};

const EMPTY = { allowList: [], bans: [], admins: [] };

describe("the roster", () => {
    it("has a row for somebody who is only playing", () => {
        const [row] = foldFivemPlayers([ALICE], EMPTY);
        expect(row).toMatchObject({ name: "Alice", online: true, playerId: 3, identifier: LICENSE, allowed: false });
    });

    it("has a row for somebody who is only on the list", () => {
        const [row] = foldFivemPlayers([], {
            ...EMPTY,
            allowList: [{ identifier: DISCORD, label: "Bob", addedAt: NOW, appliedAt: NOW }]
        });
        expect(row).toMatchObject({ name: "Bob", online: false, allowed: true, waiting: false, playerId: null });
    });

    it("folds a player onto their own list row by any identifier they presented", () => {
        const rows = foldFivemPlayers([ALICE], {
            ...EMPTY,
            // Added by the Discord id, reported by the licence. One person.
            allowList: [{ identifier: DISCORD, label: "Alice on the list", addedAt: NOW, appliedAt: NOW }],
            admins: [{ identifier: LICENSE, label: "Alice", addedAt: NOW }]
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ name: "Alice", online: true, allowed: true, admin: true });
    });

    it("offers no slot for a reading that carried none", () => {
        // The live stream reports a name and an identifier and no slot at all.
        // A kick addressed to an invented number is a kick against whoever is in
        // that slot right now, so the row has to say it cannot be kicked.
        const [row] = foldFivemPlayers([{ ...ALICE, id: -1 }], EMPTY);
        expect(row?.online).toBe(true);
        expect(row?.playerId).toBe(null);
    });

    it("says when the server has not been handed somebody yet", () => {
        const [row] = foldFivemPlayers([], {
            ...EMPTY,
            allowList: [{ identifier: LICENSE, label: "Alice", addedAt: NOW, appliedAt: null }]
        });
        expect(row?.waiting).toBe(true);
        expect(row?.addedAt).toBe(NOW);
    });

    it("carries the ban itself, so the row can say when it lifts", () => {
        const ban = { identifier: DISCORD, label: "Bob", reason: "Griefing", at: NOW, until: NOW };
        const [row] = foldFivemPlayers([], { ...EMPTY, bans: [ban] });
        expect(row?.banned).toEqual(ban);
    });

    it("puts whoever is playing at the top and sorts the rest by name", () => {
        const rows = foldFivemPlayers([ALICE], {
            ...EMPTY,
            allowList: [
                { identifier: "license:aaa", label: "Zoe", addedAt: NOW, appliedAt: NOW },
                { identifier: "license:bbb", label: "Ben", addedAt: NOW, appliedAt: NOW }
            ]
        });
        expect(rows.map((row) => row.name)).toEqual(["Alice", "Ben", "Zoe"]);
    });

    it("matches the identifier however it was cased on the list", () => {
        const rows = foldFivemPlayers([ALICE], {
            ...EMPTY,
            allowList: [{ identifier: LICENSE.toUpperCase(), label: "Alice", addedAt: NOW, appliedAt: NOW }]
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.allowed).toBe(true);
    });
});

describe("searching", () => {
    it("finds somebody by name or by any identifier", () => {
        const [row] = foldFivemPlayers([ALICE], EMPTY);
        expect(matchesFivemPlayer(row!, "ali")).toBe(true);
        expect(matchesFivemPlayer(row!, "112233")).toBe(true);
        expect(matchesFivemPlayer(row!, "")).toBe(true);
        expect(matchesFivemPlayer(row!, "bob")).toBe(false);
    });
});

describe("the filters", () => {
    it("cut on the four states a row can be in", () => {
        const rows = foldFivemPlayers([ALICE], {
            allowList: [{ identifier: LICENSE, label: "Alice", addedAt: NOW, appliedAt: NOW }],
            bans: [{ identifier: "license:banned", label: "Ben", reason: "", at: NOW, until: null }],
            admins: [{ identifier: LICENSE, label: "Alice", addedAt: NOW }]
        });
        expect(rows.filter((row) => matchesFivemFilter(row, "online"))).toHaveLength(1);
        expect(rows.filter((row) => matchesFivemFilter(row, "allowed"))).toHaveLength(1);
        expect(rows.filter((row) => matchesFivemFilter(row, "operators"))).toHaveLength(1);
        expect(rows.filter((row) => matchesFivemFilter(row, "banned"))).toHaveLength(1);
        expect(rows.filter((row) => matchesFivemFilter(row, "all"))).toHaveLength(2);
    });
});
