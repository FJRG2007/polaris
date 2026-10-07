/**
 * The Polaris mod's event commands, and the plain path every other server keeps.
 *
 * What is pinned: a capability counts only when the mod lists it (any other
 * answer is a server without it); keys are stable per run and player and safe as
 * a file name; a batch is written whole or not at all; and `build` goes through
 * the mod only where it said it can, waits for it to finish, and falls back to
 * plain lines everywhere else.
 */

import { describe, expect, it } from "vitest";
import * as inServer from "@polaris-app/game-servers/src/lib/minecraft/events/in-server";
import type { ServerContainer } from "@polaris-app/game-servers/src/lib/minecraft/service";

const CAPS = '{"ok":true,"polaris":"0.4.0+abc","caps":["stash","batch","seek"]}';

let ids = 0;

function fakeServer(answer: (command: string) => string, edition: "java" | "bedrock" = "java") {
    const said: string[] = [];
    const sent: string[] = [];
    const server = {
        installedAppId: `server-${(ids += 1)}`,
        edition,
        say: async ([command]: readonly string[]) => {
            said.push(command!);
            return answer(command!);
        },
        sayAll: async (lines: readonly string[]) => {
            sent.push(...lines);
        }
    } as unknown as ServerContainer;
    return { server, said, sent };
}

describe("capabilities", () => {
    it("counts only what the mod lists", () => {
        expect([...inServer.parseCaps(CAPS)]).toEqual(["stash", "batch", "seek"]);
        expect(inServer.parseCaps('{"ok":true,"polaris":"0.5.0","caps":["stash","later"]}')).toEqual(
            new Set(["stash"])
        );
    });

    it("is nothing on a server without the mod", () => {
        expect(inServer.parseCaps("Unknown or incomplete command, see below for error")).toEqual(
            new Set()
        );
        expect(inServer.parseCaps("")).toEqual(new Set());
        expect(inServer.parseCaps('{"ok":false}')).toEqual(new Set());
    });

    it("asks once a minute per server, and never a Bedrock one", async () => {
        const { server, said } = fakeServer(() => CAPS);
        expect(await inServer.capabilities(server, 1_000)).toEqual(new Set(["stash", "batch", "seek"]));
        await inServer.capabilities(server, 30_000);
        expect(said).toEqual(["polaris caps"]);
        await inServer.capabilities(server, 62_000);
        expect(said).toHaveLength(2);
        const bedrock = fakeServer(() => CAPS, "bedrock");
        expect(await inServer.capabilities(bedrock.server)).toEqual(new Set());
        expect(bedrock.said).toEqual([]);
    });
});

describe("stash commands", () => {
    it("keys a run and a player the same way every time, as one safe word", () => {
        const key = inServer.stashKey("run-1", "Steve");
        expect(key).toBe(inServer.stashKey("run-1", "steve"));
        expect(key).not.toBe(inServer.stashKey("run-2", "Steve"));
        expect(key).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        expect(inServer.stashKey("run-1", "Steve", 1)).toBe(`${key}-1`);
    });

    it("leaves a name the mod cannot take to the old path", () => {
        expect(inServer.stashLine("save", "Steve", "pek")).toBe("polaris stash save Steve pek");
        expect(inServer.stashLine("restore", ".BedrockGuy", "pek")).toBeNull();
    });

    it("reads the mod's answer, and nothing else", () => {
        expect(
            inServer.parseStashReply('{"key":"k","player":"Steve","ok":true,"already":false,"items":3}')
        ).toMatchObject({ ok: true, already: false, items: 3 });
        expect(inServer.parseStashReply('{"ok":false,"why":"offline"}')).toEqual({
            ok: false,
            why: "offline"
        });
        expect(inServer.parseStashReply("Unknown or incomplete command")).toBeNull();
    });
});

describe("batches", () => {
    it("writes each command to storage, escaped, and starts it", () => {
        const lines = inServer.batchLines("pb1", ['say "hi"', "fill 0 0 0 9 9 9 minecraft:stone"], 4096)!;
        expect(lines).toEqual([
            "data remove storage polaris:batch pb1",
            'data modify storage polaris:batch pb1 append value "say \\"hi\\""',
            'data modify storage polaris:batch pb1 append value "fill 0 0 0 9 9 9 minecraft:stone"',
            "polaris batch run pb1 4096"
        ]);
    });

    it("is not written at all when one line would be too long", () => {
        expect(inServer.batchLines("pb1", [`say ${"x".repeat(1000)}`])).toBeNull();
    });

    it("builds through the mod where it can, and waits for it", async () => {
        let polls = 0;
        const { server, said, sent } = fakeServer((command) => {
            if (command === "polaris caps") return CAPS;
            if (command.startsWith("polaris batch run"))
                return '{"ok":true,"key":"k","done":false,"total":2,"ran":0,"failed":0}';
            polls += 1;
            return `{"ok":true,"key":"k","done":${polls >= 2},"total":2,"ran":${polls},"failed":0}`;
        });
        expect(await inServer.build(server, ["fill 0 0 0 9 9 9 stone", "say done"], undefined, async () => undefined)).toBe(
            true
        );
        expect(sent[0]).toMatch(/^data remove storage polaris:batch pb/);
        expect(sent).toHaveLength(3);
        expect(said.filter((one) => one.startsWith("polaris batch status"))).toHaveLength(2);
    });

    it("sends plain lines on a server without the mod", async () => {
        const { server, said, sent } = fakeServer(() => "Unknown or incomplete command");
        const lines = ["fill 0 0 0 9 9 9 stone", "say done"];
        expect(await inServer.build(server, lines)).toBe(true);
        expect(sent).toEqual(lines);
        expect(said).toEqual(["polaris caps"]);
    });

    it("falls back when the batch is not answered as the mod", async () => {
        const { server, sent } = fakeServer((command) =>
            command === "polaris caps" ? CAPS : "Unknown or incomplete command"
        );
        const lines = ["fill 0 0 0 9 9 9 stone"];
        expect(await inServer.build(server, lines)).toBe(true);
        expect(sent.slice(-1)).toEqual(lines);
    });
});
