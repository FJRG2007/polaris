import { describe, expect, it } from "vitest";
import { actionFingerprint, describeStep, DeviceActions, readActionStore, runSteps, windowsKeyCodes, type ActionStore, type StepRunner } from "@/main/plugins/device-actions";

function fakes() {
    const log: string[] = [];
    let clock = 0;
    const runner: StepRunner = {
        open: async (path) => (log.push(`${clock} open ${path}`), true),
        website: async (url) => (log.push(`${clock} web ${url}`), true),
        run: async (file, args) => (log.push(`${clock} run ${file} ${JSON.stringify(args)}`), !file.endsWith("bad.exe")),
        hotkey: async (step) => (log.push(`${clock} key ${step.key}`), true),
        polaris: async (action) => (log.push(`${clock} call ${action}`), true),
        launcher: async (entry) => (log.push(`${clock} launch ${entry}`), true)
    };
    const sleep = async (ms: number) => {
        clock += ms;
    };
    return { log, runner, sleep, now: () => clock };
}

const action = { id: "rec", name: "Record", steps: [{ kind: "hotkey" as const, key: "f9", ctrl: false, alt: false, shift: false, meta: false }], off: [{ kind: "hotkey" as const, key: "f10", ctrl: false, alt: false, shift: false, meta: false }] };

describe("device actions", () => {
    it("runs a macro in order on a fake clock and goes on after a failed step", async () => {
        const { log, runner, sleep } = fakes();
        const ok = await runSteps(
            [
                { kind: "run", file: "C:\\bad.exe", args: ["--a b"] },
                { kind: "delay", ms: 200 },
                { kind: "website", url: "https://example.com" },
                { kind: "delay", ms: 50 },
                { kind: "launcher", entry: "system:lock" }
            ],
            runner,
            sleep
        );
        expect(ok).toBe(false);
        expect(log).toEqual(['0 run C:\\bad.exe ["--a b"]', "200 web https://example.com", "250 launch system:lock"]);
    });

    it("asks before the first run, remembers the answer, asks again after a change, and alternates two states", async () => {
        const { log, runner, sleep } = fakes();
        let asked = 0;
        let answer = false;
        let stored: ActionStore | null = null;
        const actions = new DeviceActions({ read: async () => null, write: async (store) => void (stored = store), confirm: async () => (asked++, answer), runner, sleep });
        expect(await actions.save(action)).toBe(true);
        expect(await actions.run("rec")).toBe("declined");
        expect(log).toEqual([]);
        answer = true;
        expect(await actions.run("rec")).toBe("ran");
        expect(await actions.run("rec")).toBe("ran");
        expect(asked).toBe(2);
        expect(log).toEqual(["0 key f9", "0 key f10"]);
        expect(stored!.confirmed.rec).toBe(actionFingerprint(action));
        await actions.save({ ...action, name: "Renamed" });
        expect(await actions.run("rec")).toBe("ran");
        expect(asked).toBe(2);
        await actions.save({ ...action, steps: [{ kind: "open", path: "C:\\x" }] });
        await actions.run("rec");
        expect(asked).toBe(3);
        expect(await actions.run("nope")).toBe("unknown");
        expect(await actions.save({ ...action, steps: [{ kind: "run", file: "relative.exe", args: [] }] })).toBe(false);
    });

    it("drops stored entries that no longer fit and the answers of actions that are gone", () => {
        const store = readActionStore({ actions: [action, { id: "x", name: "bad", steps: [{ kind: "run", file: "obs" }] }, action], confirmed: { rec: "a", gone: "b" }, on: { gone: true } });
        expect(store.actions.map((item) => item.id)).toEqual(["rec"]);
        expect(store.confirmed).toEqual({ rec: "a" });
        expect(store.on).toEqual({});
        expect(readActionStore("garbage")).toEqual({ actions: [], confirmed: {}, on: {} });
    });

    it("maps hotkeys to Windows key codes and says each step plainly", () => {
        expect(windowsKeyCodes({ kind: "hotkey", key: "m", ctrl: true, alt: false, shift: true, meta: false })).toEqual([0x11, 0x10, 0x4d]);
        expect(windowsKeyCodes({ kind: "hotkey", key: "f12", ctrl: false, alt: true, shift: false, meta: false })).toEqual([0x12, 0x7b]);
        expect(windowsKeyCodes({ kind: "hotkey", key: "mediaPlayPause", ctrl: false, alt: false, shift: false, meta: false })).toEqual([0xb3]);
        expect(describeStep({ kind: "run", file: "C:\\obs.exe", args: ["--startrecording"] })).toBe('Run C:\\obs.exe with "--startrecording"');
        expect(describeStep({ kind: "hotkey", key: "m", ctrl: true, alt: false, shift: false, meta: false })).toBe("Press Ctrl+M");
    });
});
