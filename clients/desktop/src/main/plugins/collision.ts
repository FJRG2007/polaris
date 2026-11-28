/**
 * A device's own vendor program holding the device a plugin drives: Hercules
 * Stream Control running while the Stream 100 is on Hercules' driver, so
 * Polaris cannot read it (or both act on every knob). Looked for every
 * `COLLISION_EVERY_MS` while a watched plugin's device is plugged in, from the
 * process list the app already keeps open for game detection (one line to an
 * open shell, never a new PowerShell per look). The page offers a host action
 * (`TAKE_OVER_ACTION`) that closes the program, on the person's click only.
 *
 * Pure apart from the timer, for the tests.
 */

import type { RunningProcess } from "../game-detect";
import type { DriverState } from "./hercules-driver";
import { STREAM_CONTROL_IMAGE } from "./hercules-official";
import type { PluginHostAction } from "@polaris/core/device-plugins";

export const COLLISION_EVERY_MS = 2_000;
/** After a list that did not answer: asking again at once would start another shell, so the watch waits this long. */
export const COLLISION_BACKOFF_MS = 30_000;

/** The host action's id (`plugins.runAction`): close the vendor program and give the device to Polaris. */
export const TAKE_OVER_ACTION = "useInPolaris";

/** The vendor program each plugin's device can be held by, as the page names it. */
export const VENDOR_PROGRAMS: Readonly<Record<string, { readonly image: string; readonly name: string; }>> = {
    "hercules-stream100": { image: STREAM_CONTROL_IMAGE, name: "Hercules Stream Control" }
};

/** `Stream-control.exe`, `Stream-control` and `stream-control.EXE` are one program. */
function imageKey(name: string): string {
    return name.trim().toLowerCase().replace(/\.exe$/, "");
}

/** Whether a process list (names, or names with paths) names the program `image`. */
export function listsProgram(list: readonly (string | RunningProcess)[], image: string): boolean {
    const wanted = imageKey(image);
    return list.some((entry) => imageKey(typeof entry === "string" ? entry : entry.name) === wanted);
}

/**
 * Whether the vendor program can hold the device on this driver. Not while
 * Polaris' WinUSB driver (or any WinUSB) is on it and running: the vendor's
 * program finds no device of its own then. Unknown counts as can.
 */
export function vendorCanHold(driver: DriverState | null): boolean {
    if (!driver) return true;
    switch (driver.state) {
        case "notNeeded":
        case "unplugged":
            return false;
        case "installed":
            return driver.pending === true;
        case "needed":
        case "repair":
            return true;
    }
}

/** The page's offer while the vendor program holds the device. The page says it in its own words for this id; these are for a page older than it. */
export function takeOverAction(program: string): PluginHostAction {
    return {
        id: TAKE_OVER_ACTION,
        label: { "en-US": "Use it in Polaris", "es-ES": "Usarlo en Polaris" },
        detail: { "en-US": `${program} is using the controller.`.slice(0, 120), "es-ES": `${program} está usando el controlador.`.slice(0, 120) },
        subject: program
    };
}

export interface CollisionWatchDeps {
    /** The plugins to look for now (installed, switched on, device plugged in). Asked on every tick, answered from memory. */
    watched(): readonly string[];
    /** The running programs; rejects when the list did not answer. */
    list(): Promise<readonly (string | RunningProcess)[]>;
    /** Polaris' driver state for a plugin as last looked at, or null. */
    driver(id: string): DriverState | null;
    /** The set of held plugins changed. */
    changed(): void;
    readonly every?: number;
    readonly backoff?: number;
    readonly setTimer?: (run: () => void, ms: number) => unknown;
    readonly clearTimer?: (handle: unknown) => void;
}

export function createCollisionWatch(deps: CollisionWatchDeps) {
    const every = deps.every ?? COLLISION_EVERY_MS;
    const backoff = deps.backoff ?? COLLISION_BACKOFF_MS;
    const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => {
        const timer = setTimeout(run, ms);
        timer.unref?.();
        return timer;
    });
    const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let held = new Set<string>();
    let timer: unknown = null;
    let running = false;
    let ticking: Promise<number> | null = null;

    function settle(next: Set<string>): void {
        const same = next.size === held.size && [...next].every((id) => held.has(id));
        held = next;
        if (!same) deps.changed();
    }

    /** One look; answers how long to wait before the next. */
    async function look(): Promise<number> {
        const ids = deps.watched().filter((id) => VENDOR_PROGRAMS[id]);
        if (ids.length === 0) {
            settle(new Set());
            return every;
        }
        let list: readonly (string | RunningProcess)[];
        try {
            list = await deps.list();
        } catch {
            // Not being able to look is not the program gone: what was said stays.
            return backoff;
        }
        settle(new Set(ids.filter((id) => listsProgram(list, VENDOR_PROGRAMS[id]!.image) && vendorCanHold(deps.driver(id)))));
        return every;
    }

    function schedule(ms: number): void {
        if (!running) return;
        if (timer !== null) clearTimer(timer);
        timer = setTimer(() => void tick(), ms);
    }

    /** Look now (the timer's tick, or after something changed); a look under way is shared. */
    function tick(): Promise<void> {
        if (timer !== null) clearTimer(timer);
        timer = null;
        ticking ??= look().finally(() => {
            ticking = null;
        });
        return ticking.then(schedule, () => schedule(backoff));
    }

    return {
        start(): void {
            if (running) return;
            running = true;
            void tick();
        },
        stop(): void {
            running = false;
            if (timer !== null) clearTimer(timer);
            timer = null;
        },
        tick,
        /** Whether the vendor program held this plugin's device at the last look. */
        holding: (id: string): boolean => held.has(id),
        /** The vendor program's name for a held plugin, or null. */
        program: (id: string): string | null => (held.has(id) ? (VENDOR_PROGRAMS[id]?.name ?? null) : null)
    };
}

export type CollisionWatch = ReturnType<typeof createCollisionWatch>;
