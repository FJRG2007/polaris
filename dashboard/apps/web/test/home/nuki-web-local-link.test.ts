/**
 * A Nuki Web account with the local link: the same locks, read and moved over
 * the broker on this network where they are on it, through the cloud where
 * they are not - and never a second copy of a door.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let contents = new Map<string, Record<string, string>>();
let sent: { deviceId: string; action: number }[] = [];
let cloudActions: { id: string; action: number }[] = [];
let brokerDown = false;

vi.mock("@polaris-app/places/src/lib/integrations/nuki-mqtt", () => ({
    NukiMqttError: class extends Error {
        kind = "unreachable";
    },
    readBroker: async () => {
        if (brokerDown) throw new Error("down");
        return contents;
    },
    watchBroker: async (_broker: unknown, changed: (deviceId: string) => void) => {
        changed("302DAF45");
    },
    sendAction: async (_broker: unknown, deviceId: string, action: number) => {
        sent.push({ deviceId, action });
    }
}));

vi.mock("@polaris-app/places/src/lib/integrations/nuki-api", () => ({
    NukiError: class extends Error {},
    nukiFirmware: () => "5.9.4",
    listSmartlocks: async () => [
        {
            smartlockId: 17988169541,
            type: 4,
            name: "Studio Door",
            serverState: 0,
            state: { state: 1, doorState: 2, batteryCharge: 80, batteryCritical: false }
        }
    ],
    performAction: async (_token: string, id: string, action: number) => {
        cloudActions.push({ id, action });
    }
}));

const web = await import("@polaris-app/places/src/lib/drivers/nuki-web");

const CLOUD = { token: "t" };
const LINKED = {
    token: "t",
    localHost: "192.168.1.20",
    localPort: "1883",
    localUsername: "polaris",
    localPassword: "p"
};
const ON_BROKER = {
    deviceType: "4",
    name: "Studio Door",
    state: "3",
    doorsensorState: "3",
    batteryChargeState: "79",
    connected: "true"
};

beforeEach(() => {
    contents = new Map();
    sent = [];
    cloudActions = [];
    brokerDown = false;
});

describe("the Nuki ID behind a Web smartlockId", () => {
    it("is the low 32 bits in hex, as printed on the lock", () => {
        expect(web.nukiIdOf(17988169541)).toBe("302DAF45");
        expect(web.nukiIdOf("9298534866")).toBe("2A3C61D2");
        expect(web.nukiIdOf(0x2bb28570)).toBe("2BB28570");
    });
});

describe("reading", () => {
    it("lays the broker's state over the cloud's, on the same device", async () => {
        contents.set("302daf45", ON_BROKER);
        const [door, ...rest] = await web.nukiWebDriver.list(LINKED);
        expect(rest).toEqual([]);
        expect(door?.externalId).toBe("17988169541");
        expect(door?.state).not.toBe((await web.nukiWebDriver.list(CLOUD))[0]?.state);
        expect(door?.batteryPercent).toBe(79);
    });

    it("keeps the cloud's reading when the lock is off the broker or the broker is down", async () => {
        const cloud = await web.nukiWebDriver.list(CLOUD);
        contents.set("302DAF45", { ...ON_BROKER, connected: "false" });
        expect(await web.nukiWebDriver.list(LINKED)).toEqual(cloud);
        brokerDown = true;
        expect(await web.nukiWebDriver.list(LINKED)).toEqual(cloud);
    });
});

describe("listening", () => {
    it("treats any message as a reason to read the account", async () => {
        const changed = vi.fn();
        await web.nukiWebDriver.listen!(LINKED, changed, new AbortController().signal);
        expect(changed).toHaveBeenCalledWith([]);
    });

    it("is refused without a local link", async () => {
        await expect(
            web.nukiWebDriver.listen!(CLOUD, vi.fn(), new AbortController().signal)
        ).rejects.toThrow(/no local link/);
    });
});

describe("acting", () => {
    it("goes over the broker, under the lock's own id, when the lock is on it", async () => {
        contents.set("302daf45", ON_BROKER);
        await web.nukiWebDriver.act(LINKED, { externalId: "17988169541", kind: "lock" }, "lock");
        expect(sent).toEqual([{ deviceId: "302daf45", action: 2 }]);
        expect(cloudActions).toEqual([]);
    });

    it("goes through the cloud when the lock is not on the broker", async () => {
        await web.nukiWebDriver.act(LINKED, { externalId: "17988169541", kind: "lock" }, "lock");
        expect(sent).toEqual([]);
        expect(cloudActions).toEqual([{ id: "17988169541", action: 2 }]);
    });
});
