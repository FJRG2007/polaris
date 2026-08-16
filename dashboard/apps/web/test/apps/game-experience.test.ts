/**
 * Changing what experience a player has, in both games.
 *
 * The commands are built rather than typed, and they run on somebody's server, so
 * what they come out as is worth pinning down - including the two places where
 * the games differ from each other rather than from Polaris.
 */

import { describe, expect, it } from "vitest";
import { experienceCommand, MAX_EXPERIENCE } from "@/lib/apps/minecraft/experience";
import { arkExperienceCommand, MAX_ARK_EXPERIENCE } from "@/lib/apps/ark/experience";

describe("experienceCommand", () => {
    it("gives levels", () => {
        expect(experienceCommand({ player: "Ada", mode: "add", amount: 5, unit: "levels" })).toEqual([
            "xp",
            "add",
            "Ada",
            "5",
            "levels"
        ]);
    });

    it("takes them away with a negative add, which is all the game has", () => {
        expect(experienceCommand({ player: "Ada", mode: "remove", amount: 5, unit: "points" })).toEqual([
            "xp",
            "add",
            "Ada",
            "-5",
            "points"
        ]);
    });

    it("sets them with the subcommand that is meant for it", () => {
        expect(experienceCommand({ player: "Ada", mode: "set", amount: 0, unit: "levels" })).toEqual([
            "xp",
            "set",
            "Ada",
            "0",
            "levels"
        ]);
    });

    it("clamps an amount somebody typed an extra nought onto", () => {
        expect(
            experienceCommand({ player: "Ada", mode: "add", amount: 99_999_999, unit: "points" })[3]
        ).toBe(String(MAX_EXPERIENCE));
    });

    it("refuses anything that is not a player name", () => {
        for (const player of ["", "Ada Lovelace", "a".repeat(17), "Ada; op Bob"]) {
            expect(() =>
                experienceCommand({ player, mode: "add", amount: 1, unit: "levels" })
            ).toThrow();
        }
    });
});

describe("arkExperienceCommand", () => {
    it("hands it to the survivor rather than to their tribe", () => {
        expect(arkExperienceCommand("1234567890", 1000)).toBe("GiveExpToPlayer 1234567890 1000 0 1");
    });

    it("clamps, and never asks for less than one", () => {
        expect(arkExperienceCommand("1", 0)).toBe("GiveExpToPlayer 1 1 0 1");
        expect(arkExperienceCommand("1", 99_999_999)).toBe(
            `GiveExpToPlayer 1 ${MAX_ARK_EXPERIENCE} 0 1`
        );
    });

    it("refuses a Steam id, which is the other kind of number", () => {
        // The commands that take an in-game id do nothing at all when handed one
        // of these, so it has to fail here rather than quietly on the server.
        expect(() => arkExperienceCommand("not-a-number", 1)).toThrow();
    });
});
