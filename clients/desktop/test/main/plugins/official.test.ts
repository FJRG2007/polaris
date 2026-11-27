import { describe, expect, it, vi } from "vitest";
import type { DriverRunner } from "../../../src/main/plugins/hercules-driver";
import type { OfficialRunner } from "../../../src/main/plugins/hercules-official-run";
import { answerOfficial, DRIVER_REQUIREMENT, driverRequirement, lookDriver, officialRequestSchema, officialRunnerFor, requirementRunnerFor } from "../../../src/main/plugins/official";

type Execute = Awaited<ReturnType<OfficialRunner["execute"]>>;

const LAYOUT = { pages: [{ knobs: [], buttons: [] }], profiles: [] };

function fakes(executed: Execute, installed: { ok: true; } | { ok: false; reason: string; } = { ok: true }) {
    const order: string[] = [];
    const runner = {
        look: vi.fn(async () => ({ found: null, imported: null })),
        readBackup: vi.fn(async () => null),
        execute: vi.fn(async () => {
            order.push("execute");
            return executed;
        }),
        restore: vi.fn(async () => ({ ok: true, autostart: 1, settings: true, started: true, missing: false, declined: false })),
        launch: vi.fn(async () => true)
    } as unknown as OfficialRunner;
    const manager = {
        install: vi.fn(async () => {
            order.push("install");
            return installed;
        }),
        setSetting: vi.fn(async (_id: string, key: string) => {
            order.push(`set:${key}`);
            return { ok: true };
        })
    };
    const write = vi.fn(async (name: string, _text: string) => {
        order.push(`write:${name}`);
    });
    return { runner, manager, write, order };
}

const choose = (choice: "stop" | "uninstall" | "keep") => officialRequestSchema.parse({ kind: "choose", choice, accepted: ["usb"] });

describe("answerOfficial", () => {
    it("carries the choice out before installing, then sets the values and keeps the layout", async () => {
        const { runner, manager, write, order } = fakes({ ok: true, values: { knob1: "music", button2: "call.mic" }, layout: LAYOUT, install: true } as Execute);
        const installed = vi.fn(async () => undefined);
        const request = officialRequestSchema.parse({ kind: "choose", choice: "stop", accepted: ["usb"], requires: ["driver"] });
        const answer = await answerOfficial(runner, manager as never, "hercules-stream100", request, write, installed);
        expect(answer).toEqual({ ok: true });
        // What the consent listed to set up follows the install, never before it.
        expect(installed).toHaveBeenCalledWith(["driver"]);
        expect(order).toEqual(["execute", "install", "set:knob1", "set:button2", "write:layout.json"]);
        expect(runner.execute).toHaveBeenCalledWith("stop");
        expect(manager.install).toHaveBeenCalledWith("hercules-stream100", ["usb"]);
        expect(manager.setSetting).toHaveBeenCalledWith("hercules-stream100", "knob1", "music");
        expect(JSON.parse(write.mock.calls[0]?.[1] ?? "null")).toEqual(LAYOUT);
    });

    it("installs nothing when a step of the choice failed", async () => {
        const { runner, manager, write, order } = fakes({ ok: false, reason: "declined" } as Execute);
        expect(await answerOfficial(runner, manager as never, "hercules-stream100", choose("uninstall"), write)).toEqual({ ok: false, reason: "declined" });
        expect(order).toEqual(["execute"]);
    });

    it("reports a failed install and applies nothing after it", async () => {
        const { runner, manager, write, order } = fakes({ ok: true, values: { knob1: "music" }, layout: LAYOUT, install: true } as Execute, { ok: false, reason: "download" });
        expect(await answerOfficial(runner, manager as never, "hercules-stream100", choose("keep"), write)).toEqual({ ok: false, reason: "install", install: "download" });
        expect(order).toEqual(["execute", "install"]);
    });

    it("writes no layout when the official app had none", async () => {
        const { runner, manager, write } = fakes({ ok: true, values: {}, layout: null, install: true } as Execute);
        await answerOfficial(runner, manager as never, "hercules-stream100", choose("keep"), write);
        expect(write).not.toHaveBeenCalled();
    });

    it("answers look, restore and launch from the runner", async () => {
        const { runner, manager, write } = fakes({ ok: false, reason: "cancelled" } as Execute);
        expect(await answerOfficial(runner, manager as never, "hercules-stream100", { kind: "look" }, write)).toEqual({ found: null, driverInUse: false, imported: null, backup: null });
        // With Polaris' own driver on the device the page says the official app is not needed.
        expect(await answerOfficial(runner, manager as never, "hercules-stream100", { kind: "look" }, write, undefined, async () => true)).toMatchObject({ driverInUse: true });
        expect(await answerOfficial(runner, manager as never, "hercules-stream100", { kind: "look" }, write, undefined, () => Promise.reject(new Error("gone")))).toMatchObject({ driverInUse: false });
        expect(await answerOfficial(runner, manager as never, "hercules-stream100", { kind: "restore" }, write)).toMatchObject({ ok: true, started: true });
        expect(await answerOfficial(runner, manager as never, "hercules-stream100", { kind: "launch" }, write)).toBe(true);
        expect(manager.install).not.toHaveBeenCalled();
    });

    it("refuses requests of any other shape and has no runner off Windows or for other plugins", () => {
        expect(officialRequestSchema.safeParse({ kind: "choose", choice: "format", accepted: [] }).success).toBe(false);
        expect(officialRequestSchema.safeParse({ kind: "choose", choice: "stop", accepted: ["root"] }).success).toBe(false);
        expect(officialRunnerFor("hercules-stream100", "/tmp", "linux")).toBeNull();
        expect(officialRunnerFor("other", "C:\\plugins", "win32")).toBeNull();
    });
});

describe("the Stream 100's driver as a requirement", () => {
    type State = Awaited<ReturnType<DriverRunner["state"]>>;
    const runner = (state: State) => ({ state: vi.fn(async () => state), install: vi.fn(async () => ({ ok: true })) }) as unknown as DriverRunner;

    it("reads met while Polaris' driver or WinUSB holds it, missing while another driver does", async () => {
        expect(await driverRequirement(runner({ state: "installed" })).look()).toEqual({ state: "met", before: true });
        expect(await driverRequirement(runner({ state: "notNeeded" })).look()).toEqual({ state: "met", before: false });
        expect(await driverRequirement(runner({ state: "needed", hercules: true })).look()).toEqual({ state: "missing", before: false });
        // Set up once and taken back since (a Hercules reinstall): it is put back by itself.
        expect(await driverRequirement(runner({ state: "repair" })).look()).toEqual({ state: "missing", before: true });
        expect(await driverRequirement(runner({ state: "unplugged", installed: true })).look()).toEqual({ state: "away", before: true });
    });

    it("sets up through the driver's own install, and is known only for the Stream 100's driver on Windows", async () => {
        const driver = runner({ state: "needed", hercules: false });
        expect(await driverRequirement(driver).setUp()).toEqual({ ok: true });
        expect(driver.install).toHaveBeenCalledTimes(1);
        expect(requirementRunnerFor("hercules-stream100", "other", "C:\plugins")).toBeNull();
        expect(requirementRunnerFor("another-plugin", DRIVER_REQUIREMENT, "C:\plugins")).toBeNull();
    });

    it("answers the view's driver.look with the last failure, null without a driver", async () => {
        expect(await lookDriver(null, null)).toBeNull();
        expect(await lookDriver(runner({ state: "needed", hercules: true }), "declined")).toEqual({ state: "needed", hercules: true, failure: "declined" });
        expect(await lookDriver(runner({ state: "installed" }), null)).toEqual({ state: "installed", failure: null });
    });

    it("carries what the consent listed to set up through the official choice, none from an older page", () => {
        expect(officialRequestSchema.parse({ kind: "choose", choice: "keep", accepted: [] })).toMatchObject({ requires: [] });
        expect(officialRequestSchema.parse({ kind: "choose", choice: "keep", accepted: [], requires: ["driver"] })).toMatchObject({ requires: ["driver"] });
        expect(officialRequestSchema.safeParse({ kind: "choose", choice: "keep", accepted: [], requires: ["../x"] }).success).toBe(false);
    });
});
