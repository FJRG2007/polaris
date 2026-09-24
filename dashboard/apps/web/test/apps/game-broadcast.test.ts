/**
 * What a message from Polaris looks like to the people playing.
 *
 * `say` prints whoever sent it, and a command sent over RCON is sent by a source
 * the server calls `Rcon` - so a scheduled "restarting in five minutes" arrived
 * in the game as `[Rcon] restarting in five minutes`. Nobody playing knows what
 * RCON is; the thing talking to them is Polaris.
 *
 * What is pinned here is the command actually sent, because the failure mode is
 * silent in both directions: a malformed component is a message nobody sees, and
 * Bedrock's `tellraw` takes a different body from Java's - sending one the other's
 * way is also a message nobody sees.
 */

import { describe, expect, it } from "vitest";
import {
    BROADCAST_TAG,
    broadcastArgv,
    sayArgv
} from "@polaris-app/game-servers/src/lib/minecraft/broadcast";

const WARNING = "The server restarts in 5 minutes";

describe("a message from Polaris", () => {
    it("is written by the server rather than quoted from a sender", () => {
        const [verb, who] = broadcastArgv("java", WARNING);
        expect(verb).toBe("tellraw");
        expect(who).toBe("@a");
    });

    it("carries the tag and the message, and nothing about RCON", () => {
        const body = broadcastArgv("java", WARNING)[2] ?? "";
        const parsed = JSON.parse(body) as { text: string }[];
        expect(parsed.map((part) => part.text).join("")).toBe(`[${BROADCAST_TAG}] ${WARNING}`);
        expect(body).not.toMatch(/rcon/i);
    });

    it("speaks Bedrock's own form on Bedrock", () => {
        // The same verb with a different body. Java's component list on Bedrock is
        // a command the server refuses, which is a warning nobody in the game sees.
        const body = broadcastArgv("bedrock", WARNING)[2] ?? "";
        const parsed = JSON.parse(body) as { rawtext: { text: string }[] };
        expect(parsed.rawtext[0]?.text).toBe(`[${BROADCAST_TAG}] ${WARNING}`);
    });

    it("survives the characters an operator actually types", () => {
        // It is one argument on the way out, so quotes and braces reach the server
        // as themselves rather than closing the component early.
        const typed = 'Backup at 4am - say "hi" to {everyone} \\ ok';
        const body = broadcastArgv("java", typed)[2] ?? "";
        const parsed = JSON.parse(body) as { text: string }[];
        expect(parsed.map((part) => part.text).join("")).toBe(`[${BROADCAST_TAG}] ${typed}`);
    });

    it("keeps accents and emoji intact", () => {
        const typed = "Reinicio en 5 minutos - guardad, por favor";
        const body = broadcastArgv("java", typed)[2] ?? "";
        expect(JSON.parse(body).map((part: { text: string }) => part.text).join("")).toContain(typed);
    });

    it("is never split into words on the way out", () => {
        // `runServerCommand` takes argv, not a line, so a message with spaces stays
        // one argument. Three parts, whatever the message is.
        expect(broadcastArgv("java", "a b c d e")).toHaveLength(3);
    });
});

describe("the fallback", () => {
    it("still says who it is from", () => {
        // Used only when a server refuses `tellraw`. It reads as `[Rcon] [Polaris]
        // ...`, which is not pretty - and a warning that never arrived is worse.
        expect(sayArgv(WARNING)).toEqual(["say", `[${BROADCAST_TAG}] ${WARNING}`]);
    });
});
