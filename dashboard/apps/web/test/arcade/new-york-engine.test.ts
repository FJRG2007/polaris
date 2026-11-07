// @vitest-environment jsdom

/**
 * Two promises the game's engine makes: a stray error during the load does not
 * stick the game once the city is up, and a player whose model cannot be built
 * costs one attempt per vehicle, not one with every position that arrives.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({ build: vi.fn() }));

vi.mock("../../../arcade/game/new-york/engine/cars.js", () => ({
    BODY_SPECS: { sedan: {} },
    buildCarGeometry: models.build,
    createLoftedCarMaterial: vi.fn()
}));

vi.mock("../../../arcade/game/new-york/engine/helicopter.js", () => ({
    buildHelicopterBodyGeometry: models.build,
    buildHelicopterMainRotorGeometry: vi.fn(),
    buildHelicopterTailRotorGeometry: vi.fn(),
    createLoftedHelicopterMaterial: vi.fn()
}));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
    document.body.replaceChildren();
});

async function embedded() {
    const postMessage = vi.fn();
    vi.stubGlobal("parent", { postMessage });
    vi.resetModules();
    const embed = await import("../../../arcade/game/new-york/engine/embed.js");
    const sent = () => postMessage.mock.calls.map(([message]) => message.type as string);
    return { embed, sent };
}

describe("the load's last word", () => {
    it("takes a failure back when the city comes up after all", async () => {
        const { embed, sent } = await embedded();
        embed.reportFailure("error");
        embed.reportReady();
        expect(sent()).toEqual(["polaris-game:hello", "polaris-game:failed", "polaris-game:ready"]);
    });

    it("reports a failure once, and none after the city is up", async () => {
        const { embed, sent } = await embedded();
        embed.reportFailure("error");
        embed.reportFailure("data");
        embed.reportReady();
        embed.reportReady();
        embed.reportFailure("error");
        expect(sent().filter((type) => type === "polaris-game:failed")).toHaveLength(1);
        expect(sent().filter((type) => type === "polaris-game:ready")).toHaveLength(1);
    });
});

describe("a player whose model cannot be built", () => {
    const player = (mode: string) => ({
        id: "them",
        name: "Them",
        x: 1,
        y: 0,
        z: 2,
        heading: 0,
        mode,
        lamps: { brake: 0, reverse: false, signal: 0 }
    });

    it("is tried once per vehicle, and stays in the list for the map", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        models.build.mockReset();
        models.build.mockImplementation(() => {
            throw new Error("no geometry");
        });
        const listeners: ((players: unknown[]) => void)[] = [];
        vi.doMock("../../../arcade/game/new-york/engine/embed.js", () => ({
            onPlayers: (listener: (players: unknown[]) => void) => listeners.push(listener)
        }));
        const remote = await import("../../../arcade/game/new-york/engine/remote-players.js");
        const players = remote.createRemotePlayers({ add: () => undefined });
        const hear = listeners[0]!;

        for (let message = 0; message < 10; message++) hear([player("car")]);
        expect(models.build).toHaveBeenCalledTimes(1);
        expect(players.list()).toHaveLength(1);

        for (let message = 0; message < 10; message++) hear([player("helicopter")]);
        expect(models.build).toHaveBeenCalledTimes(2);
    });
});
