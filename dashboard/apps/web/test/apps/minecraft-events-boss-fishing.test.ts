import { describe, expect, it } from "vitest";
import * as speech from "@polaris-app/game-servers/src/lib/minecraft/speech";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as fishing from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/boss-fishing";
import * as say from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/boss-fishing-messages";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";

describe("the legendary fish", () => {
    it("is as strong as the catches asked for each player fishing as it starts", () => {
        expect(fishing.hooked(10, ["Ana", "Ben", "Cid"]).max).toBe(30);
        expect(fishing.hooked(10, ["Ana", "Ana"]).fishers).toEqual(["Ana"]);
        // Nobody could be read: sized for one, never for nobody.
        expect(fishing.hooked(7, []).max).toBe(7);
    });

    it("grows for whoever starts fishing later, keeping what was already taken off it", () => {
        let state = fishing.withCatches(fishing.hooked(10, ["Ana", "Ben"]), new Map([["Ana", 6]]));
        expect(fishing.strengthLeft(state, new Set())).toBe(14);
        const { state: next, added } = fishing.grown(state, 10, ["ana", "Ben", "Cid"]);
        expect(added).toEqual(["Cid"]);
        expect(next.max).toBe(30);
        expect(fishing.strengthLeft(next, new Set())).toBe(24);
        // Nobody new: as it was.
        expect(fishing.grown(next, 10, ["Cid"]).state).toBe(next);
        // Sized for one with nobody read, the first to come takes that place.
        state = fishing.hooked(10, []);
        expect(fishing.grown(state, 10, ["Ana"]).state.max).toBe(10);
        expect(fishing.grown(state, 10, ["Ana", "Ben"]).state.max).toBe(20);
    });

    it("keeps every catch it was told of, and leaves out whoever wears it down for nothing", () => {
        let state = fishing.hooked(10, ["Ana", "Ben"]);
        state = fishing.withCatches(
            state,
            new Map([
                ["Ana", 5],
                ["Ben", 9]
            ])
        );
        // Ben logged off and Ana's count reads lower: nothing is lost.
        state = fishing.withCatches(state, new Map([["ana", 3]]));
        expect(state.caught).toEqual({ Ana: 5, Ben: 9 });
        expect(fishing.strengthLeft(state, new Set())).toBe(6);
        expect(fishing.strengthLeft(state, new Set(["ben"]))).toBe(15);
        expect(
            fishing.strengthLeft(fishing.withCatches(state, new Map([["Ana", 50]])), new Set())
        ).toBe(0);
    });

    it("is said to tire at three quarters, half and a quarter of its strength", () => {
        expect(fishing.stagesDue(20, 20)).toBe(0);
        expect(fishing.stagesDue(15, 20)).toBe(1);
        expect(fishing.stagesDue(10, 20)).toBe(2);
        expect(fishing.stagesDue(1, 20)).toBe(3);
    });
});

describe("what a boss fishing sends", () => {
    it("counts fish as the fishing contest does, and treasures as a rare catch does", () => {
        const setup = fishing.fishSetup();
        expect(setup).toContain(
            "scoreboard objectives add pe_fbf minecraft.custom:minecraft.fish_caught"
        );
        // Every fishing treasure.
        for (const id of ["name_tag", "saddle", "nautilus_shell", "enchanted_book", "bow"])
            expect(setup.some((line) => line.endsWith(`minecraft.picked_up:minecraft.${id}`))).toBe(
                true
            );
        expect(fishing.READ_TREASURES).toBe(
            "execute as @a[scores={pe_rdc=1..,pe_rfr=1..}] run data get entity @s Pos"
        );
        expect(fishing.treasureLine("Ana")).toBe("scoreboard players add Ana pe_fbt 3");
        expect(fishing.fishTick()).toContain(
            "execute as @a[scores={pe_fbs=1..}] run scoreboard players operation @s pe_score = @s pe_fbs"
        );
        const removed = fishing.fishCleanup();
        for (const line of setup.filter((one) => one.startsWith("scoreboard objectives add ")))
            expect(removed).toContain(
                line.replace(" add ", " remove ").split(" ").slice(0, 4).join(" ")
            );
    });

    it("celebrates a landing with sparks and sounds, never a rocket that bursts on anybody", () => {
        const lines = fishing.landedLines();
        expect(lines.some((line) => line.includes("particle minecraft:firework"))).toBe(true);
        expect(
            lines.some((line) => line.includes("playsound minecraft:entity.firework_rocket"))
        ).toBe(true);
        expect(lines.some((line) => line.includes("summon"))).toBe(false);
    });

    it("says everything in both languages within a command", () => {
        const spoken = speech.spoken(say);
        const lines = [
            commands.say(spoken.hookedLine(9000, 3, speech.EVERY)),
            commands.say(spoken.treasureLine("Abcdefghijklmnop", 3, speech.EVERY)),
            commands.say(spoken.tiringLine(25, speech.EVERY)),
            commands.say(spoken.strongerLine(30, speech.EVERY)),
            commands.say(spoken.landedLine(speech.EVERY)),
            commands.say(spoken.escapedLine(9000, speech.EVERY)),
            ...commands.titleCommands(
                spoken.landedTitle(speech.EVERY),
                spoken.landedSubtitle(speech.EVERY)
            ),
            ...commands.titleCommands(
                spoken.hookedTitle(speech.EVERY),
                spoken.escapedTitle(speech.EVERY)
            ),
            ...commands.barUpdate(spoken.bar(9000, 9000, "10:00", speech.EVERY), 9000, 9000)
        ];
        for (const line of lines)
            for (const language of speech.LANGUAGES)
                expect(
                    commandBytes(
                        commands.namespaced(speech.localize(line, speech.audienceOf(language))[0]!)
                    )
                ).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
        expect(say.escapedLine(4, "es")).toContain("Nadie gana");
        expect(say.escapedLine(4, "en")).toContain("Nobody wins");
    });
});
