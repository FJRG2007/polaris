/**
 * Custom device actions (docs/device-plugins.md, "Custom actions"): what a
 * device button or knob press runs beyond the call actions - open a file,
 * folder or website, run a program with its arguments, press a hotkey, run a
 * Polaris launcher entry, or a macro of those with delays, optionally with two
 * states that alternate (Stream Deck's Multi Action and Multi Action Switch).
 *
 * The trust boundary is here, in the desktop's main process:
 * - Actions are kept in one file in this app's data folder, read back through
 *   `deviceActionSchema` every time (a damaged or edited entry is dropped).
 * - A plugin never sees what an action does: its button carries an opaque
 *   `custom:<id>` and the host looks it up here.
 * - The page can edit actions, but the first run of a new or changed one asks
 *   in a dialog of this app that lists exactly what it will do; the answer is
 *   kept against a fingerprint of its steps, so any change asks again.
 * - A program runs from its file with an argument list, never through a shell.
 *
 * Everything that touches the system is passed in, so it is tested with fakes.
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { deviceActionSchema, MAX_DEVICE_ACTIONS, readActionRef, type DeviceAction, type DeviceActionStep } from "@polaris/core/device-plugins";

/** What the store file holds. */
export interface ActionStore {
    actions: DeviceAction[];
    /** The fingerprint the owner said yes to, per action. */
    confirmed: Record<string, string>;
    /** Whether a two-state action is in its second state. */
    on: Record<string, boolean>;
}

const storeShape = z.object({
    actions: z.array(z.unknown()).max(MAX_DEVICE_ACTIONS).default([]),
    confirmed: z.record(z.string(), z.string().max(128)).default({}),
    on: z.record(z.string(), z.boolean()).default({})
});

export function emptyStore(): ActionStore {
    return { actions: [], confirmed: {}, on: {} };
}

/** A stored file, read: every action that still fits the schema, and the answers for those only. */
export function readActionStore(raw: unknown): ActionStore {
    const shape = storeShape.safeParse(raw);
    if (!shape.success) return emptyStore();
    const actions: DeviceAction[] = [];
    const seen = new Set<string>();
    for (const item of shape.data.actions) {
        const parsed = deviceActionSchema.safeParse(item);
        if (parsed.success && !seen.has(parsed.data.id)) {
            seen.add(parsed.data.id);
            actions.push(parsed.data);
        }
    }
    const keep = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([id]) => seen.has(id)));
    return { actions, confirmed: keep(shape.data.confirmed), on: keep(shape.data.on) };
}

/**
 * The names of this app's own actions that `values` (a plugin's settings)
 * hold, by the id a control keeps (`custom:<id>`, `launcher:<entry>`), for a
 * device that shows what its buttons do. Only the ones held, so the answer
 * stays as small as the device's controls; an id nothing names is left out.
 */
export function heldActionNames(values: Readonly<Record<string, unknown>>, actions: readonly Pick<DeviceAction, "id" | "name">[], launcherLabel: (entry: string) => string | undefined): Record<string, string> {
    const names: Record<string, string> = {};
    for (const value of Object.values(values)) {
        if (typeof value !== "string" || Object.hasOwn(names, value)) continue;
        const ref = readActionRef(value);
        const name = ref?.kind === "custom" ? actions.find((action) => action.id === ref.id)?.name : ref?.kind === "launcher" ? launcherLabel(ref.entry) : undefined;
        if (name) names[value] = name;
    }
    return names;
}

/** What the owner said yes to: the steps of both states, so a renamed action does not ask again and any other change does. */
export function actionFingerprint(action: DeviceAction): string {
    return createHash("sha256").update(JSON.stringify([action.steps, action.off ?? null])).digest("hex");
}

/** One step as the confirmation dialog lists it, word for word what will happen. */
export function describeStep(step: DeviceActionStep, launcherLabel: (entry: string) => string | undefined = () => undefined): string {
    switch (step.kind) {
        case "open":
            return `Open ${step.path}`;
        case "website":
            return `Open ${step.url} in the browser`;
        case "run":
            return step.args.length ? `Run ${step.file} with ${step.args.map((arg) => JSON.stringify(arg)).join(" ")}` : `Run ${step.file}`;
        case "hotkey":
            return `Press ${hotkeyText(step)}`;
        case "polaris":
            return `Polaris call: ${step.action.slice("call.".length)}`;
        case "launcher":
            return `Polaris: ${launcherLabel(step.entry) ?? step.entry}`;
        case "delay":
            return `Wait ${step.ms} ms`;
    }
}

export function hotkeyText(step: Extract<DeviceActionStep, { kind: "hotkey"; }>): string {
    const parts = [step.ctrl && "Ctrl", step.alt && "Alt", step.shift && "Shift", step.meta && "Win", step.key.length === 1 ? step.key.toUpperCase() : step.key];
    return parts.filter(Boolean).join("+");
}

/** Windows virtual-key codes (learn.microsoft.com, "Virtual-Key Codes"). */
const NAMED_KEYS: Record<string, number> = {
    enter: 0x0d, escape: 0x1b, tab: 0x09, space: 0x20, backspace: 0x08, delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
    pageUp: 0x21, pageDown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27, printScreen: 0x2c,
    volumeUp: 0xaf, volumeDown: 0xae, volumeMute: 0xad, mediaPlayPause: 0xb3, mediaNext: 0xb0, mediaPrevious: 0xb1, mediaStop: 0xb2
};

/** A hotkey step as the key codes to press, modifiers first (Ctrl, Alt, Shift, Win), or null for a key with no code. */
export function windowsKeyCodes(step: Extract<DeviceActionStep, { kind: "hotkey"; }>): number[] | null {
    const { key } = step;
    let code: number | undefined;
    if (/^[a-z0-9]$/.test(key)) code = key.toUpperCase().charCodeAt(0);
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) code = 0x6f + Number(key.slice(1));
    else code = NAMED_KEYS[key];
    if (code === undefined) return null;
    const modifiers = [step.ctrl && 0x11, step.alt && 0x12, step.shift && 0x10, step.meta && 0x5b].filter((value): value is number => typeof value === "number");
    return [...modifiers, code];
}

/** What runs each kind of step on this computer; each answers whether it went through. */
export interface StepRunner {
    open(path: string): Promise<boolean>;
    website(url: string): Promise<boolean>;
    run(file: string, args: readonly string[]): Promise<boolean>;
    hotkey(step: Extract<DeviceActionStep, { kind: "hotkey"; }>): Promise<boolean>;
    polaris(action: Extract<DeviceActionStep, { kind: "polaris"; }>["action"]): Promise<boolean>;
    launcher(entry: string): Promise<boolean>;
}

/**
 * Runs `steps` in order, waiting out each delay. A step that fails does not
 * stop the ones after it (Stream Deck's Multi Action goes on too); the answer
 * is whether every step went through.
 */
export async function runSteps(steps: readonly DeviceActionStep[], runner: StepRunner, sleep: (ms: number) => Promise<void>): Promise<boolean> {
    let all = true;
    for (const step of steps) {
        let ok: boolean;
        try {
            ok = await runStep(step, runner, sleep);
        } catch {
            ok = false;
        }
        all &&= ok;
    }
    return all;
}

async function runStep(step: DeviceActionStep, runner: StepRunner, sleep: (ms: number) => Promise<void>): Promise<boolean> {
    switch (step.kind) {
        case "open":
            return runner.open(step.path);
        case "website":
            return runner.website(step.url);
        case "run":
            return runner.run(step.file, step.args);
        case "hotkey":
            return runner.hotkey(step);
        case "polaris":
            return runner.polaris(step.action);
        case "launcher":
            return runner.launcher(step.entry);
        case "delay":
            await sleep(step.ms);
            return true;
    }
}

export interface DeviceActionsDeps {
    read(): Promise<unknown>;
    write(store: ActionStore): Promise<void>;
    /** Ask the owner, in this app, whether to run `action` (`lines` say what it does). */
    confirm(action: DeviceAction, lines: readonly string[]): Promise<boolean>;
    runner: StepRunner;
    sleep(ms: number): Promise<void>;
    launcherLabel?(entry: string): string | undefined;
}

export type RunOutcome = "ran" | "failed" | "declined" | "busy" | "unknown";

/** The actions on this computer: kept, edited and run with the owner's say-so. */
export class DeviceActions {
    private store: ActionStore | null = null;
    private readonly running = new Set<string>();
    private writes: Promise<void> = Promise.resolve();

    constructor(private readonly deps: DeviceActionsDeps) {}

    async list(): Promise<(DeviceAction & { confirmed: boolean; on: boolean; })[]> {
        const store = await this.load();
        return store.actions.map((action) => ({ ...action, confirmed: store.confirmed[action.id] === actionFingerprint(action), on: store.on[action.id] === true }));
    }

    /** Add or replace one (already checked by the caller's schema; checked again here). False when it does not fit or the list is full. */
    async save(given: unknown): Promise<boolean> {
        const parsed = deviceActionSchema.safeParse(given);
        if (!parsed.success) return false;
        const store = await this.load();
        const index = store.actions.findIndex((action) => action.id === parsed.data.id);
        if (index === -1 && store.actions.length >= MAX_DEVICE_ACTIONS) return false;
        if (index === -1) store.actions.push(parsed.data);
        else store.actions[index] = parsed.data;
        // A toggle that lost its second state starts from the first.
        if (!parsed.data.off) delete store.on[parsed.data.id];
        await this.persist(store);
        return true;
    }

    async remove(id: string): Promise<boolean> {
        const store = await this.load();
        const before = store.actions.length;
        store.actions = store.actions.filter((action) => action.id !== id);
        delete store.confirmed[id];
        delete store.on[id];
        if (store.actions.length === before) return false;
        await this.persist(store);
        return true;
    }

    /**
     * A press: the state the action is in runs, after the owner said yes to
     * these exact steps once. A second press while it runs is ignored, as a
     * macro is not started twice over itself.
     */
    async run(id: string): Promise<RunOutcome> {
        const store = await this.load();
        const action = store.actions.find((item) => item.id === id);
        if (!action) return "unknown";
        if (this.running.has(id)) return "busy";
        this.running.add(id);
        try {
            const fingerprint = actionFingerprint(action);
            if (store.confirmed[id] !== fingerprint) {
                const steps = [...action.steps, ...(action.off ?? [])];
                const lines = steps.map((step) => describeStep(step, this.deps.launcherLabel));
                if (!(await this.deps.confirm(action, lines))) return "declined";
                store.confirmed[id] = fingerprint;
                await this.persist(store);
            }
            const second = action.off !== undefined && store.on[id] === true;
            const ok = await runSteps(second ? action.off! : action.steps, this.deps.runner, this.deps.sleep);
            if (action.off) {
                store.on[id] = !second;
                await this.persist(store);
            }
            return ok ? "ran" : "failed";
        } finally {
            this.running.delete(id);
        }
    }

    private async load(): Promise<ActionStore> {
        if (this.store) return this.store;
        let raw: unknown = null;
        try {
            raw = await this.deps.read();
        } catch {
            raw = null;
        }
        this.store = readActionStore(raw);
        return this.store;
    }

    private persist(store: ActionStore): Promise<void> {
        const snapshot: ActionStore = structuredClone(store);
        this.writes = this.writes.then(() => this.deps.write(snapshot)).catch(() => undefined);
        return this.writes;
    }
}
