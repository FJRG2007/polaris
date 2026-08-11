/**
 * Folding an ARK server's two lists into one row per person.
 *
 * Who is playing and who is allowed on are two answers to halves of the same
 * question, and a card each meant reading both to find out what is going on with
 * somebody - then acting in whichever one happened to hold the verb. One row has
 * to carry every state a person is in, including the state that only exists here:
 * added to the list while the server was too busy installing to be told.
 *
 * Keyed by the Steam id and never by the name, because a character can be renamed
 * at will and two people can pick the same one.
 */

import { describe, expect, it } from "vitest";
import { foldArkPlayers, matchesArkPlayer } from "@/lib/apps/ark/players";

const ALICE = "76561198000000001";
const BOB = "76561198000000002";

const allowed = (steamId: string, label: string, appliedAt: string | null) => ({
    steamId,
    label,
    addedAt: "2026-08-01T00:00:00.000Z",
    appliedAt
});

describe("folding the lists", () => {
    it("keeps somebody who is playing and allowed as one row", () => {
        const rows = foldArkPlayers([{ name: "Alice", steamId: ALICE }], [allowed(ALICE, "Alice", "then")]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ steamId: ALICE, online: true, standing: "allowed" });
    });

    it("says when the server has not been told about somebody yet", () => {
        const rows = foldArkPlayers([], [allowed(BOB, "Bob", null)]);
        expect(rows[0]?.standing).toBe("waiting");
    });

    it("shows somebody playing who is on no list at all", () => {
        // The server was opened to everybody, or the flag is off. Either way the
        // moderator has to be able to see them and act on them.
        const rows = foldArkPlayers([{ name: "Stranger", steamId: BOB }], []);
        expect(rows[0]).toMatchObject({ online: true, standing: "not-allowed" });
    });

    it("prefers the name the server reports over the one somebody typed", () => {
        const rows = foldArkPlayers([{ name: "AliceInGame", steamId: ALICE }], [allowed(ALICE, "my sister", "then")]);
        expect(rows[0]?.name).toBe("AliceInGame");
    });

    it("falls back to the label, and then to the id, rather than an empty row", () => {
        expect(foldArkPlayers([], [allowed(ALICE, "", null)])[0]?.name).toBe(ALICE);
        expect(foldArkPlayers([{ name: "", steamId: BOB }], [])[0]?.name).toBe(BOB);
    });

    it("puts whoever is playing at the top, then sorts by name", () => {
        const rows = foldArkPlayers(
            [{ name: "Zoe", steamId: BOB }],
            [allowed(ALICE, "Alice", "then"), allowed(BOB, "Zoe", "then")]
        );
        expect(rows.map((row) => row.name)).toEqual(["Zoe", "Alice"]);
    });
});

describe("searching the table", () => {
    const row = foldArkPlayers([{ name: "Alice", steamId: ALICE }], [])[0]!;

    it("matches a name however it was capitalised", () => {
        expect(matchesArkPlayer(row, "ali")).toBe(true);
        expect(matchesArkPlayer(row, "ALI")).toBe(true);
    });

    it("matches the id, which is what a report about a player carries", () => {
        expect(matchesArkPlayer(row, "1980000000")).toBe(true);
    });

    it("matches everything when nothing was typed, and nothing when it does not", () => {
        expect(matchesArkPlayer(row, "   ")).toBe(true);
        expect(matchesArkPlayer(row, "bob")).toBe(false);
    });
});
