/**
 * Nothing of Polaris's reaches a player still at Polaris login's prompt: every
 * line that shows something is narrowed to the players without the tag the mod
 * and the plugin put on a held player, and everything else is sent untouched.
 */

import { describe, expect, it } from "vitest";
import * as prelogin from "@polaris-app/game-servers/src/lib/minecraft/prelogin";
import { relayLine } from "@polaris-app/game-servers/src/lib/minecraft/chat-relay";
import * as events from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import { broadcastArgv } from "@polaris-app/game-servers/src/lib/minecraft/broadcast";
import { COMMAND_BYTES_MAX } from "@polaris-app/game-servers/src/lib/minecraft/command-size";
import * as challenges from "@polaris-app/game-servers/src/lib/minecraft/challenges/commands";

const IN = "tag=!polaris_pending";
const hidden = prelogin.hiddenFromPending;

describe("the tag", () => {
    it("is the one the mod and the plugin put on a held player", () => {
        expect(prelogin.PENDING_TAG).toBe("polaris_pending");
    });
});

describe("narrowedTarget", () => {
    it("adds the test to every kind of selector", () => {
        expect(prelogin.narrowedTarget("@a")).toBe(`@a[${IN}]`);
        expect(prelogin.narrowedTarget("@a[]")).toBe(`@a[${IN}]`);
        expect(prelogin.narrowedTarget("@a[tag=pl_es]")).toBe(`@a[tag=pl_es,${IN}]`);
        expect(prelogin.narrowedTarget("@p")).toBe(`@p[${IN}]`);
        expect(prelogin.narrowedTarget("@r[limit=2]")).toBe(`@r[limit=2,${IN}]`);
        expect(prelogin.narrowedTarget("@e[type=player]")).toBe(`@e[type=player,${IN}]`);
    });

    it("keeps a selector's brackets whole", () => {
        expect(prelogin.narrowedTarget("@a[nbt={Inventory:[{id:\"a\"}]}]")).toBe(
            `@a[nbt={Inventory:[{id:"a"}]},${IN}]`
        );
    });

    it("turns a name into a selector for that name, Floodgate's too", () => {
        expect(prelogin.narrowedTarget("Ana")).toBe(`@a[name=Ana,${IN}]`);
        expect(prelogin.narrowedTarget(".Bedrock_1")).toBe(`@a[name=.Bedrock_1,${IN}]`);
    });

    it("leaves @s, a UUID and a selector that already asks about the tag alone", () => {
        expect(prelogin.narrowedTarget("@s")).toBe("@s");
        const uuid = "0d6a2c1e-6a3b-4a0b-9c6f-5d1e2f3a4b5c";
        expect(prelogin.narrowedTarget(uuid)).toBe(uuid);
        expect(prelogin.narrowedTarget(`@a[${IN}]`)).toBe(`@a[${IN}]`);
        expect(prelogin.narrowedTarget("@a[tag=polaris_pending]")).toBe("@a[tag=polaris_pending]");
    });
});

describe("hiddenFromPending", () => {
    it("narrows a line to everybody", () => {
        expect(hidden('tellraw @a {"text":"hi"}')).toBe(`tellraw @a[${IN}] {"text":"hi"}`);
        expect(hidden('title @a actionbar {"text":"5"}')).toBe(
            `title @a[${IN}] actionbar {"text":"5"}`
        );
        expect(hidden("title @a times 10 70 20")).toBe(`title @a[${IN}] times 10 70 20`);
    });

    it("narrows a line to one player by name", () => {
        expect(hidden('tellraw Ana {"text":"hi"}')).toBe(
            `tellraw @a[name=Ana,${IN}] {"text":"hi"}`
        );
        expect(hidden("title Ana clear")).toBe(`title @a[name=Ana,${IN}] clear`);
    });

    it("narrows a sound to its listeners, and whoever execute aims it with", () => {
        expect(hidden("playsound minecraft:ui.toast.in master @a ~ ~ ~ 1 1")).toBe(
            `playsound minecraft:ui.toast.in master @a[${IN}] ~ ~ ~ 1 1`
        );
        expect(
            hidden("execute as @a at @s run playsound minecraft:entity.generic.explode master @s ~ ~ ~ 0.8 0.6")
        ).toBe(
            `execute as @a[${IN}] at @s run playsound minecraft:entity.generic.explode master @s ~ ~ ~ 0.8 0.6`
        );
        expect(
            hidden("execute as Ana at @s run playsound minecraft:ui.toast.challenge_complete master @s ~ ~ ~ 1 1")
        ).toBe(
            `execute as @a[name=Ana,${IN}] at @s run playsound minecraft:ui.toast.challenge_complete master @s ~ ~ ~ 1 1`
        );
    });

    it("narrows each selector execute names on the way to a showing command", () => {
        expect(
            hidden(
                "execute in minecraft:overworld positioned 1 64 2 as @a[distance=..48] run title @s actionbar {\"text\":\"x\"}"
            )
        ).toBe(
            `execute in minecraft:overworld positioned 1 64 2 as @a[distance=..48,${IN}] run title @s actionbar {"text":"x"}`
        );
        expect(hidden('execute as @a run execute at @s run tellraw @s {"text":"x"}')).toBe(
            `execute as @a[${IN}] run execute at @s run tellraw @s {"text":"x"}`
        );
    });

    it("takes the slash and the namespace as the game does", () => {
        expect(hidden('/tellraw @a {"text":"hi"}')).toBe(`/tellraw @a[${IN}] {"text":"hi"}`);
        expect(hidden('minecraft:tellraw @a {"text":"hi"}')).toBe(
            `minecraft:tellraw @a[${IN}] {"text":"hi"}`
        );
    });

    it("never touches an @a inside the words", () => {
        expect(hidden('tellraw @a {"text":"say @a and Ana"}')).toBe(
            `tellraw @a[${IN}] {"text":"say @a and Ana"}`
        );
    });

    it("leaves reads, counts, gifts and cleanups exactly as they were", () => {
        for (const line of [
            "list uuids",
            "execute as @a run data get entity @s Pos",
            "execute as @a run scoreboard players get @s pe_score",
            "scoreboard players enable @a pc_menu",
            "tag @a remove pe_seen",
            "give Ana minecraft:diamond 1",
            "effect clear @a minecraft:speed",
            "bossbar set polaris:event players @a",
            "scoreboard objectives setdisplay sidebar polaris_side",
            "say hello",
            "execute as @a[tag=pe_x] run tp @s 0 64 0"
        ])
            expect(hidden(line)).toBe(line);
    });

    it("is the same line when asked twice", () => {
        const once = hidden('execute as Ana at @s run tellraw @a {"text":"x"}');
        expect(hidden(once)).toBe(once);
    });

    it("sends the line as it was rather than one the console tool would drop", () => {
        const long = `tellraw @a ${JSON.stringify({ text: "x".repeat(COMMAND_BYTES_MAX - 30) })}`;
        expect(long.length).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
        expect(hidden(long)).toBe(long);
    });

    it("covers what Polaris actually sends: challenges, events, broadcasts, the chat relay", () => {
        expect(hidden(events.sound("minecraft:block.bell.use"))).toContain(`execute as @a[${IN}] at @s`);
        expect(hidden(challenges.actionBar("Ana", "&aDone"))).toContain(`title @a[name=Ana,${IN}] actionbar`);
        expect(hidden(challenges.tell("@a", "&aSeason over"))).toContain(`tellraw @a[${IN}] `);
        for (const line of challenges.completion("Ana", "Done", "Mine 10 logs"))
            expect(hidden(line)).toContain(`@a[name=Ana,${IN}]`);
        expect(hidden(events.say("&eAn event starts"))).toContain(`tellraw @a[${IN}] `);
        for (const line of events.titleCommands("Event", "Starts now"))
            expect(hidden(line)).toContain(`title @a[${IN}] `);
        expect(prelogin.hiddenFromPendingArgv(broadcastArgv("java", "Restart in 5 minutes"))[0]).toMatch(
            new RegExp(`^tellraw @a\\[${IN}\\] `)
        );
        const relayed = relayLine("@a", {
            author: "Ana",
            conversation: "general",
            inChannel: true,
            text: "hi"
        });
        expect(hidden(relayed!)).toMatch(new RegExp(`^tellraw @a\\[${IN}\\] `));
    });
});

describe("hiddenFromPendingArgv", () => {
    it("sends one line when it changed, the words as they were when it did not", () => {
        expect(prelogin.hiddenFromPendingArgv(["tellraw", "@a", '{"text":"x"}'])).toEqual([
            `tellraw @a[${IN}] {"text":"x"}`
        ]);
        const read = ["scoreboard", "players", "list", "Ana"];
        expect(prelogin.hiddenFromPendingArgv(read)).toBe(read);
    });
});

describe("who is still at the prompt", () => {
    it("is read by the tag", () => {
        expect(prelogin.PENDING_READ).toBe(
            "execute as @a[tag=polaris_pending] run data get entity @s XpLevel"
        );
    });

    it("is nobody on an empty answer", () => {
        expect(prelogin.pendingNames("", ["Ana"])).toEqual([]);
    });

    it("reads the names out of answers the game runs together", () => {
        const said =
            "Ana has the following entity data: 0Ben has the following entity data: 12";
        expect(prelogin.pendingNames(said, ["Ana", "Ben", "Cleo"]).sort()).toEqual(["Ana", "Ben"]);
    });

    it("is left out of who is online as the players see it", () => {
        const list = { online: 3, max: 20, players: ["Ana", "Ben", "Cleo"] };
        expect(prelogin.withoutPending(list, ["ben"])).toEqual({
            online: 2,
            max: 20,
            players: ["Ana", "Cleo"]
        });
        expect(prelogin.withoutPending(list, [])).toBe(list);
    });
});
