import { describe, expect, it, vi } from "vitest";
import type { OfficialRunner } from "../../../src/main/addons/hercules-official-run";
import { answerOfficial, officialRequestSchema, officialRunnerFor } from "../../../src/main/addons/official";

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
        const answer = await answerOfficial(runner, manager as never, "hercules-stream100", choose("stop"), write);
        expect(answer).toEqual({ ok: true });
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
        expect(await answerOfficial(runner, manager as never, "hercules-stream100", { kind: "look" }, write)).toEqual({ found: null, imported: null, backup: null });
        expect(await answerOfficial(runner, manager as never, "hercules-stream100", { kind: "restore" }, write)).toMatchObject({ ok: true, started: true });
        expect(await answerOfficial(runner, manager as never, "hercules-stream100", { kind: "launch" }, write)).toBe(true);
        expect(manager.install).not.toHaveBeenCalled();
    });

    it("refuses requests of any other shape and has no runner off Windows or for other add-ons", () => {
        expect(officialRequestSchema.safeParse({ kind: "choose", choice: "format", accepted: [] }).success).toBe(false);
        expect(officialRequestSchema.safeParse({ kind: "choose", choice: "stop", accepted: ["root"] }).success).toBe(false);
        expect(officialRunnerFor("hercules-stream100", "/tmp", "linux")).toBeNull();
        expect(officialRunnerFor("other", "C:\\addons", "win32")).toBeNull();
    });
});
