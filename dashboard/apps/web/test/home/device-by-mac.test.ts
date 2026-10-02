/**
 * A device given by its MAC instead of its IP.
 *
 * The registry lets every address field take a MAC; the account layer wraps each
 * driver so it is handed the IP the MAC answers on now, and stores the MAC back
 * whatever the driver returns. The network is a fake: a neighbour table that can
 * be rewritten (the router lending a new address), a subnet, and a record of
 * every knock - so what is checked is where the answer comes from, how often the
 * network is bothered, and that a device the router moved is followed.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as registry from "@polaris-app/places/src/lib/device-connections";
import { withAddresses } from "@polaris-app/places/src/lib/driver-addresses";
import { DriverError, type DeviceDriver } from "@polaris-app/places/src/lib/drivers/contract";
import {
    locateMac,
    macsAt,
    useLocateNetwork
} from "@polaris-app/places/src/lib/integrations/mac-locate";

const MAC = "C8:F7:42:1A:2B:3C";

let table = new Map<string, string>();
/** Entries the subnet sweep makes appear, as the host's ARP would. */
let onKnock = new Map<string, string>();
let knocks = 0;
let reads = 0;

beforeEach(() => {
    table = new Map();
    onKnock = new Map();
    knocks = 0;
    reads = 0;
    useLocateNetwork({
        async neighbours() {
            reads += 1;
            return new Map(table);
        },
        async knock() {
            knocks += 1;
            for (const [address, mac] of onKnock) table.set(address, mac);
        },
        subnet: async () => ["192.168.1.2", "192.168.1.3"],
        settleMs: 0
    });
});

describe("finding where a MAC is", () => {
    it("reads it from the neighbour table, whatever spelling the table uses", async () => {
        table.set("192.168.1.40", "c8:f7:42:1a:2b:3c");
        await expect(locateMac(MAC)).resolves.toBe("192.168.1.40");
        expect(knocks).toBe(0);
    });

    it("asks the table once for a house full of lookups", async () => {
        table.set("192.168.1.40", "c8:f7:42:1a:2b:3c");
        table.set("192.168.1.41", "c8:f7:42:1a:2b:3d");
        await locateMac(MAC);
        await locateMac("C8:F7:42:1A:2B:3D");
        await locateMac(MAC);
        expect(reads).toBe(1);
    });

    it("knocks on the subnet when the table has not seen it, then reads again", async () => {
        onKnock.set("192.168.1.3", "c8f7421a2b3c");
        await expect(locateMac(MAC)).resolves.toBe("192.168.1.3");
        expect(knocks).toBe(1);
    });

    it("asks the connection's own scan before sweeping, where it has one", async () => {
        const asked: string[] = [];
        const own = async (hex: string) => {
            asked.push(hex);
            return "192.168.1.50";
        };
        await expect(locateMac(MAC, { own })).resolves.toBe("192.168.1.50");
        expect(asked).toEqual(["c8f7421a2b3c"]);
        expect(knocks).toBe(0);
    });

    it("never answers with an address no device is ever at", async () => {
        table.set("127.0.0.1", "c8:f7:42:1a:2b:3c");
        await expect(locateMac(MAC, { own: async () => "169.254.169.254" })).resolves.toBeNull();
    });

    it("does not sweep again and again for a device that is simply off", async () => {
        await expect(locateMac(MAC)).resolves.toBeNull();
        await expect(locateMac(MAC, { fresh: true })).resolves.toBeNull();
        expect(knocks).toBe(1);
    });

    it("prefers a new address over the one it stopped answering at", async () => {
        table.set("192.168.1.40", "c8:f7:42:1a:2b:3c");
        table.set("192.168.1.77", "c8:f7:42:1a:2b:3c");
        await expect(locateMac(MAC, { fresh: true, avoid: "192.168.1.40" })).resolves.toBe(
            "192.168.1.77"
        );
    });

    it("names the MAC each scanned address answered as", async () => {
        table.set("192.168.1.40", "c8:f7:42:1a:2b:3c");
        const macs = await macsAt(["192.168.1.40", "192.168.1.41"]);
        expect([...macs]).toEqual([["192.168.1.40", MAC]]);
    });
});

/** A Shelly driver that records the host it was handed, and answers only at
 *  the addresses listed in `answering`. */
function shelly(answering: Set<string>) {
    const handed: string[] = [];
    const driver: DeviceDriver = {
        connection: "shelly-local",
        async verify(credentials) {
            handed.push(credentials.host!);
            if (!answering.has(credentials.host!)) {
                throw new DriverError("The device did not answer in time.", "unreachable");
            }
            return { host: credentials.host!, password: credentials.password ?? "" };
        },
        async list(credentials) {
            handed.push(credentials.host!);
            if (!answering.has(credentials.host!)) {
                throw new DriverError("The device did not answer in time.", "unreachable");
            }
            return [];
        },
        async act() {}
    };
    return { driver: withAddresses(driver), handed };
}

describe("a driver handed a MAC", () => {
    it("is given the IP, and what it returns to be stored keeps the MAC", async () => {
        table.set("192.168.1.40", "c8:f7:42:1a:2b:3c");
        const { driver, handed } = shelly(new Set(["192.168.1.40"]));
        const stored = await driver.verify({ host: MAC, password: "pw" });
        expect(handed).toEqual(["192.168.1.40"]);
        expect(stored).toEqual({ host: MAC, password: "pw" });
    });

    it("follows the device when the router lends it a new address", async () => {
        table.set("192.168.1.40", "c8:f7:42:1a:2b:3c");
        const answering = new Set(["192.168.1.40"]);
        const { driver, handed } = shelly(answering);
        await driver.list({ host: MAC });

        // The lease changes: the old address is silent, the new one answers.
        answering.clear();
        answering.add("192.168.1.77");
        table.delete("192.168.1.40");
        onKnock.set("192.168.1.77", "c8:f7:42:1a:2b:3c");
        await expect(driver.list({ host: MAC })).resolves.toEqual([]);
        expect(handed).toEqual(["192.168.1.40", "192.168.1.40", "192.168.1.77"]);

        // And keeps the new one: the next call goes straight there.
        await driver.list({ host: MAC });
        expect(handed.at(-1)).toBe("192.168.1.77");
    });

    it("passes the refusal on when the device is nowhere else", async () => {
        table.set("192.168.1.40", "c8:f7:42:1a:2b:3c");
        const { driver } = shelly(new Set());
        await expect(driver.list({ host: MAC })).rejects.toThrow("did not answer in time");
    });

    it("says which MAC nothing answers as", async () => {
        const { driver, handed } = shelly(new Set());
        await expect(driver.list({ host: MAC })).rejects.toThrow(
            `Nothing on this network answers as ${MAC}.`
        );
        expect(handed).toEqual([]);
    });

    it("leaves an address that is an IP or a name alone, and never looks anything up", async () => {
        const { driver, handed } = shelly(new Set(["192.168.1.40", "shelly-plug.local"]));
        await driver.list({ host: "192.168.1.40" });
        await driver.list({ host: "shelly-plug.local" });
        expect(handed).toEqual(["192.168.1.40", "shelly-plug.local"]);
        expect(reads).toBe(0);
    });
});

describe("the registry's address fields", () => {
    it("lets every field that says where a device is take a MAC", () => {
        const where = registry.DEVICE_CONNECTIONS.flatMap((connection) =>
            connection.fields
                .filter((field) => field.key === "host" || field.key === "url")
                .map((field) => `${connection.id}.${field.key}:${field.address === true}`)
        );
        expect(where.length).toBeGreaterThan(5);
        expect(where.filter((entry) => entry.endsWith(":false"))).toEqual([]);
    });

    it("stores a MAC in one spelling, whichever it was typed in", () => {
        const connection = registry.deviceConnection("shelly-local")!;
        expect(registry.normalizeFields(connection, { host: " c8f7.421a.2b3c " }).host).toBe(MAC);
        expect(registry.normalizeFields(connection, { host: "192.168.1.40" }).host).toBe(
            "192.168.1.40"
        );
    });

    it("holds a MAC being typed to all twelve digits, and leaves empty alone", () => {
        const connection = registry.deviceConnection("shelly-local")!;
        const host = connection.fields.find((field) => field.key === "host")!;
        expect(registry.fieldIssue(host, "C8:F7:4", undefined, undefined, true)).toBe(
            "A MAC address has 12 digits."
        );
        expect(registry.fieldIssue(host, "", undefined, undefined, true)).toBeNull();
        expect(registry.fieldIssue(host, MAC, undefined, undefined, true)).toBeNull();
        expect(registry.fieldIssue(host, "FF:FF:FF:FF:FF:FF", undefined, undefined, true)).toBe(
            "That is not a device's MAC address."
        );
        expect(registry.fieldsComplete(connection, { host: "C8:F7:4" }, ["host"])).toBe(false);
        expect(registry.fieldsComplete(connection, { host: MAC }, ["host"])).toBe(true);
        expect(registry.fieldsComplete(connection, { host: MAC })).toBe(true);
    });
});
