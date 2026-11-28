import { describe, expect, it, vi } from "vitest";
import { pluginHostActionSchema } from "@polaris/core/device-plugins";
import { createLastKnown } from "../../../src/main/plugins/last-known";
import { keptDriver, lookDriver } from "../../../src/main/plugins/official";
import type { DriverRunner, DriverState } from "../../../src/main/plugins/hercules-driver";
import { createCollisionWatch, listsProgram, takeOverAction, vendorCanHold, COLLISION_BACKOFF_MS, COLLISION_EVERY_MS, TAKE_OVER_ACTION } from "../../../src/main/plugins/collision";

const ID = "hercules-stream100";

/** A timer the test runs by hand: the last one set, and how long it was for. */
function manualTimer() {
    const timers: { run: () => void; ms: number; cleared: boolean; }[] = [];
    return {
        timers,
        setTimer: (run: () => void, ms: number) => {
            const timer = { run, ms, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimer: (handle: unknown) => {
            (handle as { cleared: boolean; }).cleared = true;
        },
        live: () => timers.filter((timer) => !timer.cleared)
    };
}

describe("listsProgram", () => {
    it("finds the program by its image name, with or without .exe, in any case", () => {
        expect(listsProgram([{ name: "explorer.exe" }, { name: "stream-control.exe", path: "C:\\Program Files (x86)\\Hercules\\Stream-control.exe" }], "Stream-control.exe")).toBe(true);
        expect(listsProgram(["Stream-control"], "Stream-control.exe")).toBe(true);
        expect(listsProgram(["STREAM-CONTROL.EXE"], "Stream-control.exe")).toBe(true);
        expect(listsProgram(["stream-controller.exe", "explorer.exe"], "Stream-control.exe")).toBe(false);
        expect(listsProgram([], "Stream-control.exe")).toBe(false);
    });
});

describe("vendorCanHold", () => {
    it("is false while a WinUSB driver runs on the device, true while the vendor's can", () => {
        expect(vendorCanHold({ state: "installed" })).toBe(false);
        expect(vendorCanHold({ state: "notNeeded" })).toBe(false);
        expect(vendorCanHold({ state: "unplugged", installed: true })).toBe(false);
        expect(vendorCanHold({ state: "installed", pending: true })).toBe(true);
        expect(vendorCanHold({ state: "needed", hercules: true })).toBe(true);
        expect(vendorCanHold({ state: "repair" })).toBe(true);
        expect(vendorCanHold(null)).toBe(true);
    });
});

describe("takeOverAction", () => {
    it("is a host action the snapshot schema accepts, naming the program", () => {
        const action = pluginHostActionSchema.parse(takeOverAction("Hercules Stream Control"));
        expect(action).toMatchObject({ id: TAKE_OVER_ACTION, subject: "Hercules Stream Control", label: { "en-US": "Use it in Polaris", "es-ES": "Usarlo en Polaris" } });
        expect(action.detail?.["en-US"]).toBe("Hercules Stream Control is using the controller.");
    });
});

describe("createCollisionWatch", () => {
    function setup(list: () => Promise<readonly string[]>, driver: DriverState | null = { state: "needed", hercules: true }, watched: readonly string[] = [ID]) {
        const timer = manualTimer();
        const changed = vi.fn();
        const lister = vi.fn(list);
        const watch = createCollisionWatch({ watched: () => watched, list: lister, driver: () => driver, changed, setTimer: timer.setTimer, clearTimer: timer.clearTimer });
        return { watch, timer, changed, lister };
    }

    it("says when the vendor program starts holding the device and when it lets go", async () => {
        let running = ["explorer.exe"];
        const { watch, changed } = setup(async () => running);
        watch.start();
        await watch.tick();
        expect(watch.holding(ID)).toBe(false);
        expect(changed).not.toHaveBeenCalled();
        running = ["explorer.exe", "Stream-control.exe"];
        await watch.tick();
        expect(watch.holding(ID)).toBe(true);
        expect(watch.program(ID)).toBe("Hercules Stream Control");
        expect(changed).toHaveBeenCalledTimes(1);
        await watch.tick();
        expect(changed).toHaveBeenCalledTimes(1);
        running = ["explorer.exe"];
        await watch.tick();
        expect(watch.holding(ID)).toBe(false);
        expect(changed).toHaveBeenCalledTimes(2);
        watch.stop();
    });

    it("does not count the program while Polaris' driver runs on the device", async () => {
        const { watch } = setup(async () => ["Stream-control.exe"], { state: "installed" });
        watch.start();
        await watch.tick();
        expect(watch.holding(ID)).toBe(false);
        watch.stop();
    });

    it("does not list programs while no watched device is plugged in", async () => {
        const { watch, lister, timer } = setup(async () => ["Stream-control.exe"], null, []);
        watch.start();
        await watch.tick();
        expect(lister).not.toHaveBeenCalled();
        expect(timer.live()).toHaveLength(1);
        expect(timer.live()[0]?.ms).toBe(COLLISION_EVERY_MS);
        watch.stop();
        expect(timer.live()).toHaveLength(0);
    });

    it("ignores a plugin with no known vendor program", async () => {
        const { watch, lister } = setup(async () => ["Stream-control.exe"], null, ["other-plugin"]);
        watch.start();
        await watch.tick();
        expect(lister).not.toHaveBeenCalled();
        expect(watch.holding("other-plugin")).toBe(false);
        watch.stop();
    });

    it("keeps one timer every 2 s, and waits longer after a list that did not answer, keeping what it said", async () => {
        let fail = false;
        const { watch, timer } = setup(async () => {
            if (fail) throw new Error("no answer");
            return ["Stream-control.exe"];
        });
        watch.start();
        await watch.tick();
        await watch.tick();
        expect(timer.live()).toHaveLength(1);
        expect(timer.live()[0]?.ms).toBe(COLLISION_EVERY_MS);
        fail = true;
        await watch.tick();
        expect(watch.holding(ID)).toBe(true);
        expect(timer.live()).toHaveLength(1);
        expect(timer.live()[0]?.ms).toBe(COLLISION_BACKOFF_MS);
        watch.stop();
    });

    it("shares one list between looks asked at once", async () => {
        let answer: (list: readonly string[]) => void = () => undefined;
        const { watch, lister } = setup(() => new Promise((done) => (answer = done)));
        watch.start();
        const second = watch.tick();
        answer(["Stream-control.exe"]);
        await second;
        expect(lister).toHaveBeenCalledTimes(1);
        expect(watch.holding(ID)).toBe(true);
        watch.stop();
    });
});

describe("createLastKnown", () => {
    it("looks once when nothing is known, then answers from what it kept until told to look again", async () => {
        const kept = createLastKnown<number>();
        let value = 1;
        const look = vi.fn(async () => value);
        expect(kept.known("a")).toBeNull();
        expect(await Promise.all([kept.read("a", look), kept.read("a", look)])).toEqual([1, 1]);
        expect(look).toHaveBeenCalledTimes(1);
        value = 2;
        expect(await kept.read("a", look)).toBe(1);
        expect(look).toHaveBeenCalledTimes(1);
        expect(await kept.fresh("a", look)).toBe(2);
        expect(kept.known("a")).toBe(2);
        kept.forget("a");
        expect(kept.known("a")).toBeNull();
    });

    it("keeps nothing from a look that failed", async () => {
        const kept = createLastKnown<number>();
        await expect(kept.read("a", async () => Promise.reject(new Error("gone")))).rejects.toThrow("gone");
        expect(kept.known("a")).toBeNull();
        expect(await kept.read("a", async () => 3)).toBe(3);
    });
});

describe("the driver line a page reads", () => {
    it("answers from the last look, and looks again only on a change", async () => {
        let state: DriverState = { state: "needed", hercules: true };
        const look = vi.fn(async () => state);
        const runner = { state: look, installed: async () => false, install: async () => ({ ok: true }), remove: async () => ({ ok: true }) } as unknown as DriverRunner;
        const driver = keptDriver(runner, ID, createLastKnown<DriverState>());
        // The app starting (or a plug) looks.
        await driver.state();
        expect(look).toHaveBeenCalledTimes(1);
        state = { state: "installed" };
        // Opening the page, again and again, never looks.
        expect(await lookDriver(driver, null)).toEqual({ state: "needed", hercules: true, failure: null });
        expect(await lookDriver(driver, "declined")).toEqual({ state: "needed", hercules: true, failure: "declined" });
        expect(look).toHaveBeenCalledTimes(1);
        // A setup (a requirement change) looks again, and the page reads that.
        await driver.state();
        expect(look).toHaveBeenCalledTimes(2);
        expect(await lookDriver(driver, null)).toEqual({ state: "installed", failure: null });
        expect(driver.knownState()).toEqual({ state: "installed" });
    });

    it("looks once when the app has not looked yet", async () => {
        const look = vi.fn(async (): Promise<DriverState> => ({ state: "repair" }));
        const driver = keptDriver({ state: look } as unknown as DriverRunner, ID, createLastKnown<DriverState>());
        expect(driver.knownState()).toBeNull();
        await Promise.all([lookDriver(driver, null), lookDriver(driver, null)]);
        expect(look).toHaveBeenCalledTimes(1);
    });
});
