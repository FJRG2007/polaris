/**
 * Linking a Nuki account to the broker Polaris runs: which of its locks are on
 * the broker, matched by the Nuki ID inside their Web id, and that a token
 * typed over the account later keeps the link.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    credentials: {} as Record<string, string>,
    held: new Map<string, Record<string, string>>(),
    brokerDown: false,
    rows: [] as { id: string; name: string; externalId: string }[]
}));

vi.mock("@polaris-app/places/src/lib/device-accounts", () => ({
    accountWithCredentials: async () => ({
        view: { id: "acc", connection: "nuki-web" },
        credentials: mocks.credentials
    }),
    linkLocal: vi.fn()
}));
vi.mock("@polaris-app/places/src/lib/integrations/nuki-mqtt", () => ({
    NukiMqttError: class extends Error {},
    readBroker: async () => {
        if (mocks.brokerDown) throw new Error("down");
        return mocks.held;
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: { placeDevice: { findMany: async () => mocks.rows } }
}));
vi.mock("@polaris-app/places/src/lib/side-service", () => ({ findService: async () => null }));

const local = await import("@polaris-app/places/src/lib/local-broker");
const accounts = await import("@polaris-app/places/src/lib/device-accounts");

beforeEach(() => {
    mocks.credentials = { token: "t" };
    mocks.held = new Map();
    mocks.brokerDown = false;
    mocks.rows = [{ id: "door", name: "Studio Door", externalId: "17988169541" }];
});

describe("the local link state", () => {
    it("is not linked without broker fields", async () => {
        const state = await local.localLinkState("install", "acc");
        expect(state.linked).toBe(false);
        expect(state.devices).toEqual([
            { id: "door", name: "Studio Door", nukiId: "302DAF45", connected: false }
        ]);
    });

    it("says a lock is connected once it publishes, whatever the case of its id", async () => {
        mocks.credentials = { token: "t", localHost: "192.168.1.20", localPassword: "p" };
        mocks.held.set("302daf45", { connected: "true", deviceType: "4" });
        const state = await local.localLinkState("install", "acc");
        expect(state.linked).toBe(true);
        expect(state.broker?.port).toBe(1883);
        expect(state.devices[0]?.connected).toBe(true);
    });

    it("is waiting again when the lock's last will says it left", async () => {
        mocks.credentials = { token: "t", localHost: "192.168.1.20", localPassword: "p" };
        mocks.held.set("302DAF45", { connected: "false" });
        expect((await local.localLinkState("install", "acc")).devices[0]?.connected).toBe(false);
    });

    it("says when the broker cannot be read", async () => {
        mocks.credentials = { token: "t", localHost: "192.168.1.20", localPassword: "p" };
        mocks.brokerDown = true;
        expect((await local.localLinkState("install", "acc")).reachable).toBe(false);
    });
});

describe("linking", () => {
    it("writes the broker into the account's own fields", async () => {
        await local.linkNukiAccount("install", "acc", {
            host: "192.168.1.20",
            port: 1883,
            username: "polaris",
            password: "p"
        });
        expect(accounts.linkLocal).toHaveBeenCalledWith("install", "acc", {
            localHost: "192.168.1.20",
            localPort: "1883",
            localUsername: "polaris",
            localPassword: "p"
        });
    });
});
