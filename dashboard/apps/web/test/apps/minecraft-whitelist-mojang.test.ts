/**
 * Adding a player on a server that asks Mojang.
 *
 * The game answers "That player does not exist" both for a name Mojang does not
 * know and for a lookup that timed out. Polaris believed it every time, so a slow
 * moment at Mojang told the operator to check the spelling of a right name and to
 * turn authentication off - and pressing the same button again worked. Pinned:
 * a name Mojang knows is asked for again, a name it denies is called unknown, and
 * a Mojang that does not answer is said to be that.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mojang = vi.hoisted(() => ({ verdict: "yes" as "yes" | "no" | "unknown" }));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/skin-service", () => ({
    mojangKnowsName: vi.fn(async () => mojang.verdict)
}));

const { addThroughGame } = await import("@polaris-app/game-servers/src/lib/minecraft/player-access");

type Server = Parameters<typeof addThroughGame>[0];

function server(answers: string[]): { server: Server; say: ReturnType<typeof vi.fn> } {
    const say = vi.fn(async () => answers.shift() ?? "Added ErMigue04 to the whitelist");
    return { server: { say } as unknown as Server, say };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

async function run(target: Server): Promise<string | null> {
    const done = addThroughGame(target, "ErMigue04").then(
        () => null,
        (error: Error) => error.message
    );
    await vi.runAllTimersAsync();
    return done;
}

describe("adding a player through the game", () => {
    it("asks again when Mojang knows the name the game could not find", async () => {
        mojang.verdict = "yes";
        const { server: target, say } = server(["That player does not exist"]);
        expect(await run(target)).toBeNull();
        expect(say).toHaveBeenCalledTimes(2);
    });

    it("calls the name unknown only when Mojang says so", async () => {
        mojang.verdict = "no";
        const { server: target, say } = server(["That player does not exist"]);
        expect(await run(target)).toBe("games:lib.unknownName");
        expect(say).toHaveBeenCalledTimes(1);
    });

    it("says Mojang did not answer instead of blaming the name", async () => {
        mojang.verdict = "unknown";
        const { server: target } = server(["That player does not exist"]);
        const said = await run(target);
        expect(said).toBe("games:lib.mojangSlow");
    });

    it("gives up after its retries with the same sentence", async () => {
        mojang.verdict = "yes";
        const { server: target, say } = server([
            "That player does not exist",
            "That player does not exist",
            "That player does not exist"
        ]);
        expect(await run(target)).toBe("games:lib.mojangSlow");
        expect(say).toHaveBeenCalledTimes(3);
    });
});
