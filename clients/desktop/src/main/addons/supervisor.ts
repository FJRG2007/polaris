/**
 * Runs each wanted add-on in a process of its own and keeps it running.
 *
 * The process is an Electron utility process in the app (VS Code runs its
 * extensions the same way, out of the main process), so an add-on that crashes
 * or hangs never takes the app down. One that exits on its own is started again
 * after 1 s, 2 s, 4 s... up to a minute; a run of a minute counts as healthy and
 * forgets the crashes, and five crashes in a row stop it as failed until it is
 * wanted again (re-enabled, updated, or its device plugged in again).
 *
 * Every message from it is checked (`addon-protocol.ts`) and every call answered
 * only when granted. The process itself is given by `fork`, so this is tested
 * without Electron.
 */

import { addonMessageSchema, judgeCall, type AddonMethod, type AppMessage } from "@/shared/addon-protocol";
import type { AddonManifest, AddonPermission, AddonSettingValue, UsbDevice } from "@polaris/core/device-addons";

export interface AddonChild {
    postMessage(message: AppMessage): void;
    kill(): void;
    onMessage(listener: (message: unknown) => void): void;
    onExit(listener: (code: number) => void): void;
}

export interface WantedAddon {
    readonly manifest: AddonManifest;
    readonly granted: readonly AddonPermission[];
    readonly entryPath: string;
    readonly settings: Record<string, AddonSettingValue>;
}

export type RunState = "starting" | "running" | "restarting" | "failed";

export interface AddonRun {
    readonly state: RunState;
    readonly crashes: number;
    /** What the add-on last said about its device. */
    readonly status: { readonly state: "connected" | "sleeping" | "busy" | "error"; readonly detail?: string; readonly code?: string; } | null;
}

export interface SupervisorOptions {
    readonly fork: (wanted: WantedAddon) => AddonChild;
    readonly call: (id: string, method: AddonMethod, params: unknown) => Promise<unknown>;
    readonly onChange?: () => void;
    readonly log?: (id: string, level: "info" | "warn" | "error", text: string) => void;
    readonly now?: () => number;
    readonly setTimer?: (run: () => void, ms: number) => unknown;
    readonly clearTimer?: (timer: unknown) => void;
}

export const HEALTHY_MS = 60_000;
export const MAX_CRASHES = 5;

export function restartDelay(crashes: number): number {
    return Math.min(1_000 * 2 ** Math.max(0, crashes - 1), 60_000);
}

interface Slot {
    wanted: WantedAddon;
    child: AddonChild | null;
    state: RunState;
    crashes: number;
    startedAt: number;
    timer: unknown;
    status: AddonRun["status"];
    /** Bumped on every start, so an old process's late messages and exit are ignored. */
    generation: number;
}

export function createSupervisor(options: SupervisorOptions) {
    const now = options.now ?? Date.now;
    const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    const slots = new Map<string, Slot>();
    let devices: readonly UsbDevice[] = [];

    const changed = () => options.onChange?.();

    function start(slot: Slot): void {
        const generation = ++slot.generation;
        const { manifest } = slot.wanted;
        slot.state = "starting";
        slot.startedAt = now();
        let child: AddonChild;
        try {
            child = options.fork(slot.wanted);
        } catch {
            crashed(slot, generation);
            return;
        }
        slot.child = child;
        child.onMessage((raw) => {
            if (slot.generation !== generation) return;
            const parsed = addonMessageSchema.safeParse(raw);
            if (!parsed.success) {
                options.log?.(manifest.id, "warn", "ignored a message of the wrong shape");
                return;
            }
            const message = parsed.data;
            if (message.type === "ready") {
                slot.state = "running";
                changed();
            } else if (message.type === "log") options.log?.(manifest.id, message.level, message.text);
            else if (message.type === "status") {
                slot.status = { state: message.state, ...(message.detail === undefined ? {} : { detail: message.detail }), ...(message.code === undefined ? {} : { code: message.code }) };
                changed();
            } else {
                const verdict = judgeCall(slot.wanted.granted, message.method, message.params);
                if (!verdict.ok) {
                    child.postMessage({ type: "reply", id: message.id, ok: false, error: verdict.error });
                    return;
                }
                options.call(manifest.id, verdict.method, verdict.params).then(
                    (value) => slot.generation === generation && child.postMessage({ type: "reply", id: message.id, ok: true, value }),
                    () => slot.generation === generation && child.postMessage({ type: "reply", id: message.id, ok: false, error: "failed" })
                );
            }
        });
        child.onExit(() => crashed(slot, generation));
        child.postMessage({ type: "start", id: manifest.id, version: manifest.version, permissions: slot.wanted.granted, devices, settings: slot.wanted.settings });
        changed();
    }

    function crashed(slot: Slot, generation: number): void {
        if (slot.generation !== generation || slots.get(slot.wanted.manifest.id) !== slot) return;
        slot.child = null;
        slot.crashes = now() - slot.startedAt >= HEALTHY_MS ? 1 : slot.crashes + 1;
        if (slot.crashes >= MAX_CRASHES) {
            slot.state = "failed";
            options.log?.(slot.wanted.manifest.id, "error", `stopped after ${slot.crashes} crashes in a row`);
        } else {
            slot.state = "restarting";
            slot.timer = setTimer(() => {
                slot.timer = null;
                if (slots.get(slot.wanted.manifest.id) === slot) start(slot);
            }, restartDelay(slot.crashes));
        }
        changed();
    }

    function stopSlot(slot: Slot): void {
        slot.generation++;
        if (slot.timer) clearTimer(slot.timer);
        slot.timer = null;
        if (slot.child) {
            try {
                slot.child.postMessage({ type: "stop" });
            } catch {
                // Already gone.
            }
            slot.child.kill();
        }
        slot.child = null;
    }

    return {
        /** Run it (a failed one starts afresh); one already running at this version is left as it is. */
        want(wanted: WantedAddon): void {
            const id = wanted.manifest.id;
            const slot = slots.get(id);
            if (slot && slot.state !== "failed" && slot.wanted.manifest.version === wanted.manifest.version && slot.wanted.entryPath === wanted.entryPath) return;
            if (slot) stopSlot(slot);
            const fresh: Slot = { wanted, child: null, state: "starting", crashes: 0, startedAt: 0, timer: null, status: null, generation: 0 };
            slots.set(id, fresh);
            start(fresh);
        },
        /** Stop it and forget it: no restart. */
        drop(id: string): void {
            const slot = slots.get(id);
            if (!slot) return;
            stopSlot(slot);
            slots.delete(id);
            changed();
        },
        devices(next: readonly UsbDevice[]): void {
            devices = next;
            for (const slot of slots.values()) slot.child?.postMessage({ type: "devices", devices });
        },
        settings(id: string, settings: Record<string, AddonSettingValue>): void {
            const slot = slots.get(id);
            if (!slot) return;
            slot.wanted = { ...slot.wanted, settings };
            slot.child?.postMessage({ type: "settings", settings });
        },
        running(): string[] {
            return [...slots.keys()];
        },
        snapshot(): Record<string, AddonRun> {
            const out: Record<string, AddonRun> = {};
            for (const [id, slot] of slots) out[id] = { state: slot.state, crashes: slot.crashes, status: slot.status };
            return out;
        },
        stopAll(): void {
            for (const id of [...slots.keys()]) this.drop(id);
        }
    };
}

export type Supervisor = ReturnType<typeof createSupervisor>;
