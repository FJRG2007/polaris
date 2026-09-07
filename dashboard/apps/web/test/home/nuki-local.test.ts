/**
 * Nuki over a broker: what its topics mean, and what a command is.
 *
 * The transport is a socket and is not tested here. What is tested is everything
 * that decides what a reader sees: a lock that has stopped talking to the broker,
 * something else publishing under the same prefix, and the numbers that say
 * whether a door is shut.
 *
 * The retained-state model is the thing to be careful about. A broker keeps the
 * last message a device sent forever, so a lock that has been flat for a week is
 * still there saying "locked" - and drawing that as live is the exact mistake
 * this app avoids everywhere else. The device's own last will is what says
 * otherwise, and it is why `connected` decides the state rather than decorating
 * it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let contents = new Map<string, Record<string, string>>();
let sent: { deviceId: string; action: number }[] = [];

vi.mock("@/lib/integrations/nuki-mqtt", () => ({
    NukiMqttError: class extends Error {
        kind = "unreachable";
    },
    readBroker: async () => contents,
    sendAction: async (_broker: unknown, deviceId: string, action: number) => {
        sent.push({ deviceId, action });
    }
}));

const { nukiLocalDriver } = await import("@/lib/home/drivers/nuki-local");

const BROKER = { host: "192.168.1.20", port: "1883", username: "polaris", password: "x", prefix: "nuki" };

/** A Smart Lock Ultra as it publishes itself: type 5, locked, door closed. */
function lock(over: Record<string, string> = {}): Record<string, string> {
    return {
        deviceType: "5",
        name: "Studio",
        firmware: "4.1.2",
        state: "1",
        doorsensorState: "2",
        batteryChargeState: "62",
        batteryCritical: "false",
        connected: "true",
        ...over
    };
}

describe("what a broker is holding", () => {
    beforeEach(() => {
        contents = new Map([["2BB28570", lock()]]);
        sent = [];
    });

    it("reads a lock as a lock, by the id printed on it", async () => {
        const found = await nukiLocalDriver.list(BROKER);
        expect(found).toHaveLength(1);
        expect(found[0]?.externalId).toBe("2BB28570");
        expect(found[0]?.kind).toBe("lock");
        expect(found[0]?.name).toBe("Studio");
        expect(found[0]?.state).toBe("locked");
        expect(found[0]?.doorState).toBe("closed");
        expect(found[0]?.batteryPercent).toBe(62);
        expect(found[0]?.model).toBe("Smart Lock Ultra");
    });

    it("says nothing about a lock that has stopped talking to the broker", async () => {
        // Its retained state is still there and is a week old. The broker sets
        // `connected` to false itself when the device goes, which is the only
        // thing that distinguishes the two.
        contents = new Map([["2BB28570", lock({ connected: "false" })]]);
        const found = await nukiLocalDriver.list(BROKER);
        expect(found[0]?.online).toBe(false);
        expect(found[0]?.state).toBe("unknown");
    });

    it("leaves alone whatever else is publishing on the same prefix", async () => {
        contents = new Map([
            ["2BB28570", lock()],
            ["some-other-thing", { state: "1", name: "Not a Nuki" }]
        ]);
        const found = await nukiLocalDriver.list(BROKER);
        expect(found.map((device) => device.name)).toEqual(["Studio"]);
    });

    it("skips the Box, which is on the account and is not a door", async () => {
        contents = new Map([["2BB28570", lock({ deviceType: "1" })]]);
        expect(await nukiLocalDriver.list(BROKER)).toHaveLength(0);
    });

    it("reads an opener with the opener's own meaning of the same numbers", async () => {
        // Their state 3 is "ring to open active" on an opener and "unlocked" on a
        // lock. One enum, two meanings, and the device type is what picks.
        contents = new Map([["ABCD1234", lock({ deviceType: "2", state: "3" })]]);
        const found = await nukiLocalDriver.list(BROKER);
        expect(found[0]?.kind).toBe("opener");
        expect(found[0]?.state).toBe("locked");
    });

    it("refuses a broker that is answering but holds no Nuki", async () => {
        // The common way this is set up wrong: the address is right and the lock
        // was never pointed at it. Connecting would leave an empty screen with no
        // reason on it.
        contents = new Map();
        await expect(nukiLocalDriver.verify(BROKER)).rejects.toThrow(/publishing as a Nuki device/);
    });

    it("sends the number their firmware expects, not the word", async () => {
        await nukiLocalDriver.act(BROKER, { externalId: "2BB28570", kind: "lock" }, "unlatch");
        expect(sent).toEqual([{ deviceId: "2BB28570", action: 3 }]);
    });

    it("refuses an action a lock does not have rather than publishing something odd", async () => {
        await expect(
            nukiLocalDriver.act(BROKER, { externalId: "2BB28570", kind: "lock" }, "turn-on")
        ).rejects.toThrow();
        expect(sent).toHaveLength(0);
    });
});
