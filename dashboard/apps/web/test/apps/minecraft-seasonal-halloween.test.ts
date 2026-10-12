/**
 * Halloween's extra touches: what a server's settings read as, what a save may
 * change, the one blood night, and the line its jar is told.
 *
 * Pinned: a server that never chose keeps safe defaults (phantoms and graves
 * off), a stored value that is not one of the choices reads as the default, the
 * blood night is Halloween itself on the server's own clock, and the line names
 * every setting as `key=value` so an older jar can skip a key it does not know.
 */

import { describe, expect, it } from "vitest";
import en from "@polaris-app/game-servers/messages/en-US/minecraft.json";
import es from "@polaris-app/game-servers/messages/es-ES/minecraft.json";
import * as halloween from "@polaris-app/game-servers/src/lib/minecraft/seasonal-halloween";

describe("a server's Halloween settings", () => {
    it("are the defaults when never chosen", () => {
        expect(halloween.halloweenSettings({})).toEqual(halloween.DEFAULT_HALLOWEEN);
        expect(halloween.DEFAULT_HALLOWEEN.phantoms).toBe(false);
        expect(halloween.DEFAULT_HALLOWEEN.graves).toBe(0);
    });

    it("keep what was chosen and drop what is not a choice", () => {
        const settings = halloween.halloweenSettings({
            [halloween.HALLOWEEN_KEY]: {
                witches: 3,
                bats: 7,
                treats: false,
                graves: 2,
                phantoms: "yes"
            }
        });
        expect(settings.witches).toBe(3);
        expect(settings.bats).toBe(halloween.DEFAULT_HALLOWEEN.bats);
        expect(settings.treats).toBe(false);
        expect(settings.graves).toBe(2);
        expect(settings.phantoms).toBe(false);
    });

    it("read a stored value that is not an object as the defaults", () => {
        expect(halloween.halloweenSettings({ [halloween.HALLOWEEN_KEY]: [1, 2] })).toEqual(
            halloween.DEFAULT_HALLOWEEN
        );
        expect(halloween.halloweenSettings({ [halloween.HALLOWEEN_KEY]: null })).toEqual(
            halloween.DEFAULT_HALLOWEEN
        );
    });

    it("are written whole on a change, keeping the rest", () => {
        const config = { [halloween.HALLOWEEN_KEY]: { witches: 2 } };
        expect(halloween.patchHalloween(config, { graves: 1 })).toEqual({
            ...halloween.DEFAULT_HALLOWEEN,
            witches: 2,
            graves: 1
        });
    });
});

describe("a save", () => {
    it("takes only known settings, each one of its choices", () => {
        expect(halloween.halloweenPatchSchema.safeParse({ witches: 2 }).success).toBe(true);
        expect(halloween.halloweenPatchSchema.safeParse({ phantoms: true, traps: 0 }).success).toBe(
            true
        );
        expect(halloween.halloweenPatchSchema.safeParse({ witches: 5 }).success).toBe(false);
        expect(halloween.halloweenPatchSchema.safeParse({ graves: 1.5 }).success).toBe(false);
        expect(halloween.halloweenPatchSchema.safeParse({ treats: 1 }).success).toBe(false);
        expect(halloween.halloweenPatchSchema.safeParse({ ghosts: true }).success).toBe(false);
        expect(halloween.halloweenPatchSchema.safeParse({}).success).toBe(false);
    });
});

describe("the blood night", () => {
    it("is Halloween itself on the server's clock", () => {
        expect(halloween.bloodNightKey(new Date("2026-10-31T12:00:00Z"), "UTC")).toBe(20261031);
        expect(halloween.bloodNightKey(new Date("2026-10-30T12:00:00Z"), "UTC")).toBe(0);
        expect(halloween.bloodNightKey(new Date("2026-11-01T00:30:00Z"), "UTC")).toBe(0);
    });

    it("follows the server's zone, and an unknown one is UTC", () => {
        // 23:30 on 30 October in UTC is already 31 October in Madrid.
        expect(halloween.bloodNightKey(new Date("2026-10-30T23:30:00Z"), "Europe/Madrid")).toBe(
            20261031
        );
        expect(halloween.bloodNightKey(new Date("2026-10-30T23:30:00Z"), "Not/AZone")).toBe(0);
    });
});

describe("the season's end", () => {
    it("is midnight after its last day on the server's clock", () => {
        expect(halloween.halloweenSecondsLeft(new Date("2026-11-02T23:00:00Z"), "UTC")).toBe(3600);
        expect(halloween.halloweenSecondsLeft(new Date("2026-11-01T00:00:00Z"), "UTC")).toBe(
            2 * 86_400
        );
        expect(halloween.halloweenSecondsLeft(new Date("2026-10-07T00:00:00Z"), "UTC")).toBe(
            27 * 86_400
        );
    });

    it("is 0 out of the season, and follows the server's zone", () => {
        expect(halloween.halloweenSecondsLeft(new Date("2026-11-03T00:00:00Z"), "UTC")).toBe(0);
        expect(halloween.halloweenSecondsLeft(new Date("2026-10-06T12:00:00Z"), "UTC")).toBe(0);
        // 23:30 on 2 November in UTC is already the 3rd, out of the season, in Madrid.
        expect(
            halloween.halloweenSecondsLeft(new Date("2026-11-02T23:30:00Z"), "Europe/Madrid")
        ).toBe(0);
    });
});

describe("the line the jar is told", () => {
    it("names every setting, with amounts as percentages", () => {
        const line = halloween.halloweenCommand(
            { ...halloween.DEFAULT_HALLOWEEN, witches: 2, phantoms: true, graves: 1 },
            20261031,
            "es",
            3600
        );
        expect(line).toBe(
            "polaris season halloween witches=200 bats=100 treats=1 horseman=1 traps=100 blood=20261031 trick=1 phantoms=1 graves=100 left=3600 lang=es"
        );
    });

    it("carries no blood night when it is switched off", () => {
        const line = halloween.halloweenCommand(
            { ...halloween.DEFAULT_HALLOWEEN, bloodNight: false },
            20261031,
            "en"
        );
        expect(line).toContain(" blood=0 ");
    });

    it("stays one word per value, so no control character or space reaches the console", () => {
        const line = halloween.halloweenCommand(halloween.DEFAULT_HALLOWEEN, 0, "en");
        expect(
            line
                .split(" ")
                .slice(3)
                .every((pair) => /^[a-z]+=[a-z0-9]+$/.test(pair))
        ).toBe(true);
    });
});

describe("the card's copy", () => {
    it("has every setting in both languages", () => {
        const keys = [
            "title",
            "needsRestart",
            ...Object.keys(halloween.HALLOWEEN_AMOUNTS).flatMap((key) => [key, `${key}Hint`]),
            ...halloween.HALLOWEEN_SWITCHES.flatMap((key) => [key, `${key}Hint`])
        ];
        for (const catalog of [en, es]) {
            const words = (catalog as { seasonalHalloween: Record<string, string> })
                .seasonalHalloween;
            for (const key of keys) expect(words[key], key).toBeTruthy();
        }
    });
});
