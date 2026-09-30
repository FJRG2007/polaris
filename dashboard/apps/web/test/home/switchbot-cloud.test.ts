/**
 * SwitchBot: the signature, what each device type becomes, and the daily budget.
 *
 * The signature is rebuilt here from SwitchBot's own code examples (base64 of an
 * HMAC-SHA256 over token + t + nonce, keyed by the secret) from what was actually
 * sent. Their README has no fixed example with a known answer, so the formula is
 * what is held.
 *
 * The budget matters as much: the account allows 10,000 calls a day, and a
 * screen that polls every half a minute would spend it. So what is asserted is
 * also how many calls a second read costs - none - and that a refresh or a press
 * reads fresh.
 *
 * No network. `fetch` is replaced.
 */

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { switchBotSign } from "@polaris-app/places/src/lib/integrations/switchbot-api";
import { forgetSwitchBot, switchBotCloudDriver } from "@polaris-app/places/src/lib/drivers/switchbot-cloud";

const KEYS = { token: "open-token-0123456789", secret: "secret-key-0123" };

interface Sent {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}

let sent: Sent[] = [];
let devices: unknown[] = [];
let statuses: Record<string, unknown> = {};
let httpStatus = 200;

function envelope(body: unknown, statusCode = 100): Response {
    return new Response(JSON.stringify({ statusCode, message: "success", body }), { status: httpStatus });
}

beforeEach(() => {
    sent = [];
    httpStatus = 200;
    forgetSwitchBot();
    devices = [
        { deviceId: "PLUG1", deviceName: "Kettle", deviceType: "Plug Mini (EU)", enableCloudService: true, hubDeviceId: "000000000000" },
        { deviceId: "BOT1", deviceName: "Coffee", deviceType: "Bot", enableCloudService: true, hubDeviceId: "HUB1" },
        { deviceId: "LOCK1", deviceName: "Front door", deviceType: "Smart Lock Pro", enableCloudService: true, hubDeviceId: "HUB1" },
        { deviceId: "METER1", deviceName: "Bedroom", deviceType: "Meter", enableCloudService: true, hubDeviceId: "HUB1" },
        { deviceId: "DOOR1", deviceName: "Back door", deviceType: "Contact Sensor", enableCloudService: true, hubDeviceId: "HUB1" },
        { deviceId: "CURT1", deviceName: "Curtain", deviceType: "Curtain", enableCloudService: true, hubDeviceId: "HUB1" },
        { deviceId: "BULB1", deviceName: "Hall", deviceType: "Color Bulb", enableCloudService: false, hubDeviceId: "000000000000" }
    ];
    statuses = {
        PLUG1: { deviceId: "PLUG1", switchStatus: 1, power: 1500.2, version: "V1.2" },
        BOT1: { deviceId: "BOT1", power: "off", battery: 100, deviceMode: "switchMode" },
        LOCK1: { deviceId: "LOCK1", lockState: "unlock", doorState: "open", battery: 60 },
        METER1: { deviceId: "METER1", temperature: 21.4, humidity: 48, battery: 100 },
        DOOR1: { deviceId: "DOOR1", openState: "timeOutNotClose", battery: 10 }
    };
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        sent.push({
            url: String(url),
            method: String(init.method),
            headers: init.headers as Record<string, string>,
            body: typeof init.body === "string" ? init.body : ""
        });
        if (httpStatus === 401) return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
        const path = new URL(String(url)).pathname;
        if (path === "/v1.1/devices") return envelope({ deviceList: devices, infraredRemoteList: [] });
        const status = /^\/v1\.1\/devices\/([^/]+)\/status$/.exec(path);
        if (status) return statuses[status[1]!] ? envelope(statuses[status[1]!]) : envelope({}, 161);
        if (path.endsWith("/commands")) return envelope({});
        return envelope({}, 190);
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("what SwitchBot is sent", () => {
    it("signs every request as their code examples do", async () => {
        await switchBotCloudDriver.verify(KEYS);
        const request = sent[0]!;
        const expected = createHmac("sha256", KEYS.secret)
            .update(`${KEYS.token}${request.headers.t}${request.headers.nonce}`)
            .digest("base64");
        expect(request.headers.Authorization).toBe(KEYS.token);
        expect(request.headers.sign).toBe(expected);
        expect(request.headers.t).toMatch(/^\d{13}$/);
        expect(switchBotSign("t", "s", "1661927531000", "n")).toBe(
            createHmac("sha256", "s").update("t1661927531000n").digest("base64")
        );
    });

    it("sends a command in the documented shape", async () => {
        await switchBotCloudDriver.act(KEYS, { externalId: "PLUG1", kind: "outlet" }, "turn-off");
        const command = sent.at(-1)!;
        expect(command.method).toBe("POST");
        expect(new URL(command.url).pathname).toBe("/v1.1/devices/PLUG1/commands");
        expect(JSON.parse(command.body)).toEqual({ command: "turnOff", parameter: "default", commandType: "command" });
    });

    it("locks and unlocks, and refuses to guess a latch command", async () => {
        await switchBotCloudDriver.act(KEYS, { externalId: "LOCK1", kind: "lock" }, "lock");
        expect(JSON.parse(sent.at(-1)!.body)).toMatchObject({ command: "lock" });
        await expect(
            switchBotCloudDriver.act(KEYS, { externalId: "LOCK1", kind: "lock" }, "unlatch")
        ).rejects.toThrow();
    });
});

describe("what comes back", () => {
    it("maps what it can draw and leaves the rest out", async () => {
        const found = await switchBotCloudDriver.list(KEYS);
        expect(found.map((row) => [row.externalId, row.kind, row.state, row.value ?? null, row.online])).toEqual([
            ["PLUG1", "outlet", "on", null, true],
            ["BOT1", "switch", "off", null, true],
            ["LOCK1", "lock", "unlocked", null, true],
            ["METER1#temperature", "sensor", "unknown", "21.4", true],
            ["METER1#humidity", "sensor", "unknown", "48", true],
            ["DOOR1", "sensor", "unknown", "Open", true],
            ["BULB1", "light", "unknown", null, false]
        ]);
        expect(found.find((row) => row.externalId === "LOCK1")?.doorState).toBe("open");
        expect(found.find((row) => row.externalId === "DOOR1")?.batteryCritical).toBe(true);
    });

    it("marks one device offline without failing the account", async () => {
        delete statuses.BOT1;
        const found = await switchBotCloudDriver.list(KEYS);
        expect(found.find((row) => row.externalId === "BOT1")).toMatchObject({ online: false, state: "unknown" });
    });

    it("says the keys or the day's allowance are the problem on a 401", async () => {
        httpStatus = 401;
        await expect(switchBotCloudDriver.verify(KEYS)).rejects.toMatchObject({ kind: "unauthorized" });
    });
});

describe("the daily allowance", () => {
    it("costs nothing to read twice in a few minutes", async () => {
        await switchBotCloudDriver.list(KEYS);
        const first = sent.length;
        await switchBotCloudDriver.list(KEYS);
        expect(sent.length).toBe(first);
    });

    it("reads fresh after a refresh", async () => {
        await switchBotCloudDriver.list(KEYS);
        const first = sent.length;
        await switchBotCloudDriver.probe!(KEYS, []);
        await switchBotCloudDriver.list(KEYS);
        expect(sent.length).toBe(first * 2);
    });

    it("reads a device fresh after it was told to do something", async () => {
        await switchBotCloudDriver.list(KEYS);
        await switchBotCloudDriver.act(KEYS, { externalId: "PLUG1", kind: "outlet" }, "turn-off");
        statuses.PLUG1 = { deviceId: "PLUG1", switchStatus: 0 };
        const found = await switchBotCloudDriver.list(KEYS);
        expect(found.find((row) => row.externalId === "PLUG1")?.state).toBe("off");
    });
});
