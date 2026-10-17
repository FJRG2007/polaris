/**
 * The automation engine, run against a clock and a store it does not own.
 *
 * Each trigger fires once for what it is about and never twice; conditions
 * decide; a delay is a row, so a process that stops in the middle of one and a
 * new one that starts later finishes the job; automations that start each other
 * stop; an owner who lost the right to operate the house operates nothing; and a
 * device that refuses is written down in words, not as a stack.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as auto from "@polaris-app/places/src/lib/automation-kinds";
import type { DeviceAction } from "@polaris-app/places/src/lib/device-kinds";
import {
    MAX_DEPTH,
    RATE_MAX,
    StepRefusal,
    createEngine,
    type AutomationEngine,
    type AutomationRecord,
    type AutomationStore,
    type DeviceReadout,
    type Observation,
    type RunRecord,
    lastSunOccurrence
} from "@polaris-app/places/src/lib/automation-engine";

const INSTALL = "install-1";
const MINUTE = 60 * 1000;

/** The rows, in memory, with the same promises the database store makes: one
 *  run per firing key, and claims and swaps that only succeed against what was
 *  read. */
class MemoryStore implements AutomationStore {
    readonly automations = new Map<string, AutomationRecord>();
    readonly runs = new Map<string, RunRecord>();
    readonly observations = new Map<string, Observation>();
    private sequence = 0;

    async enabledAutomations(installedAppId: string) {
        return [...this.automations.values()].filter(
            (automation) => automation.enabled && automation.installedAppId === installedAppId
        );
    }

    async automation(id: string) {
        return this.automations.get(id) ?? null;
    }

    async createRun(input: Parameters<AutomationStore["createRun"]>[0]) {
        const taken = [...this.runs.values()].some(
            (run) => run.automationId === input.automationId && run.firingKey === input.firingKey
        );
        if (taken) return null;
        this.sequence += 1;
        const run: RunRecord = {
            id: `run-${this.sequence}`,
            automationId: input.automationId,
            firingKey: input.firingKey,
            cause: input.cause,
            depth: input.depth,
            status: input.status,
            step: 0,
            dueAt: input.dueAt,
            waitUntil: null,
            waitDeviceId: null,
            lockedUntil: null,
            steps: input.steps ?? [],
            reason: input.reason ?? null,
            startedAt: input.startedAt,
            finishedAt: input.finishedAt ?? null
        };
        this.runs.set(run.id, run);
        return run;
    }

    async countRunsSince(automationId: string, since: Date) {
        return [...this.runs.values()].filter(
            (run) =>
                run.automationId === automationId &&
                run.startedAt.getTime() >= since.getTime() &&
                run.status !== "skipped" &&
                run.status !== "limited"
        ).length;
    }

    async claimDueRuns(now: Date, lockUntil: Date, limit: number) {
        const free = (run: RunRecord) =>
            !run.lockedUntil || run.lockedUntil.getTime() < now.getTime();
        const due = [...this.runs.values()]
            .filter(
                (run) =>
                    ((run.status === "queued" || run.status === "waiting") &&
                        run.dueAt !== null &&
                        run.dueAt.getTime() <= now.getTime() &&
                        free(run)) ||
                    (run.status === "running" && run.lockedUntil !== null && free(run))
            )
            .slice(0, limit);
        for (const run of due) this.runs.set(run.id, { ...run, lockedUntil: lockUntil });
        return due;
    }

    async saveRun(id: string, patch: Partial<RunRecord>) {
        const run = this.runs.get(id);
        if (!run || auto.runFinished(run.status)) return false;
        this.runs.set(id, { ...run, ...patch });
        return true;
    }

    async wakeWaiting(deviceId: string, now: Date) {
        for (const run of this.runs.values()) {
            if (run.waitDeviceId === deviceId && run.status === "waiting")
                this.runs.set(run.id, { ...run, dueAt: now });
        }
    }

    async markAutomation() {}

    async observation(deviceId: string) {
        return this.observations.get(deviceId) ?? null;
    }

    async swapObservation(deviceId: string, previous: Observation | null, next: Observation) {
        const current = this.observations.get(deviceId) ?? null;
        if (JSON.stringify(current) !== JSON.stringify(previous)) return false;
        this.observations.set(deviceId, next);
        return true;
    }

    async pruneRuns() {}

    runsOf(automationId: string): RunRecord[] {
        return [...this.runs.values()].filter((run) => run.automationId === automationId);
    }
}

let now: Date;
let store: MemoryStore;
let devices: Map<string, DeviceReadout>;
let acted: { deviceId: string; action: DeviceAction; setting?: unknown }[];
let notified: string[];
let faults: string[];
let woken: number[];
/** Firings handed to the central engine. */
let centralFired: { automationId: string; key: string; triggerId?: string; depth: number }[];
let mayOperate: boolean;
let refuse: Map<string, Error>;
let engine: AutomationEngine;
/** Which room each device is in and which floor each room is on. */
let scope: auto.TargetScope;

/** A new engine on the same store: what a restarted dashboard is. */
function boot(): AutomationEngine {
    const made = createEngine({
        now: () => now,
        store,
        devices: {
            async read(_install, deviceId) {
                return devices.get(deviceId) ?? null;
            },
            async act(_install, deviceId, action, _by, setting) {
                const refusal = refuse.get(deviceId);
                if (refusal) throw refusal;
                acted.push({ deviceId, action, ...(setting ? { setting } : {}) });
                const device = devices.get(deviceId);
                if (!device) throw new StepRefusal("That device is not here");
                if (setting) {
                    if (setting.action === "set-mode")
                        devices.set(deviceId, { ...device, mode: setting.mode });
                    await made.observe(INSTALL, devices.get(deviceId)!);
                    return;
                }
                const state =
                    action === "turn-on"
                        ? "on"
                        : action === "turn-off"
                          ? "off"
                          : action === "lock"
                            ? "locked"
                            : "unlocked";
                devices.set(deviceId, { ...device, state });
                // What devices.ts does after every press: tells the automations.
                await made.observe(INSTALL, devices.get(deviceId)!);
            }
        },
        places: async () => scope,
        mayOperate: async () => mayOperate,
        notify: async (_automation, message) => {
            notified.push(message);
        },
        wake: (ms) => woken.push(ms),
        log: (message) => faults.push(message),
        central: async (record, key, cause, depth) => {
            centralFired.push({
                automationId: record.central!.automationId,
                key,
                ...(cause.triggerId ? { triggerId: cause.triggerId } : {}),
                depth
            });
            return true;
        }
    });
    return made;
}

function readout(
    id: string,
    kind: string,
    state: string,
    extra: Partial<DeviceReadout> = {}
): DeviceReadout {
    return {
        id,
        kind,
        name: `Fixture ${id}`,
        state,
        door: "none",
        reading: "",
        mode: "",
        online: true,
        ...extra
    };
}

function automation(
    id: string,
    definition: Partial<auto.AutomationDefinition>,
    extra: Partial<AutomationRecord> = {}
) {
    const record: AutomationRecord = {
        id,
        installedAppId: INSTALL,
        placeId: "place-1",
        ownerId: "owner-1",
        name: `Fixture ${id}`,
        enabled: true,
        armedAt: new Date(now.getTime() - 24 * 60 * MINUTE),
        definition: {
            timeZone: "UTC",
            triggers: [{ id: "trigmanual", kind: "manual" }],
            conditions: { match: "all", groups: [] },
            actions: [],
            ...definition
        },
        ...extra
    };
    store.automations.set(id, record);
    return record;
}

function at(iso: string): void {
    now = new Date(iso);
}

function later(ms: number): void {
    now = new Date(now.getTime() + ms);
}

/** Tell the engine what a device reads now, as a sync would. */
async function reads(device: DeviceReadout): Promise<void> {
    devices.set(device.id, device);
    await engine.observe(INSTALL, device);
}

beforeEach(() => {
    at("2026-09-30T06:00:00.000Z"); // a Wednesday
    store = new MemoryStore();
    devices = new Map();
    acted = [];
    notified = [];
    faults = [];
    woken = [];
    centralFired = [];
    mayOperate = true;
    refuse = new Map();
    scope = { devices: [], rooms: [] };
    engine = boot();
});

describe("a time of day", () => {
    beforeEach(() => {
        devices.set("plug", readout("plug", "outlet", "off"));
        automation("morning", {
            triggers: [{ id: "trigtime", kind: "time", at: "07:00", days: [1, 2, 3, 4, 5] }],
            actions: [{ id: "stepon", kind: "device", deviceId: "plug", do: "turn-on" }]
        });
    });

    it("fires at its minute, once, however many passes look", async () => {
        at("2026-09-30T06:59:30.000Z");
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("morning")).toHaveLength(0);

        at("2026-09-30T07:00:20.000Z");
        await engine.evaluateSchedules(INSTALL);
        at("2026-09-30T07:01:20.000Z");
        await engine.evaluateSchedules(INSTALL);
        // A second process looking at the same minute.
        await boot().evaluateSchedules(INSTALL);
        expect(store.runsOf("morning")).toHaveLength(1);

        await engine.drain();
        expect(acted).toEqual([{ deviceId: "plug", action: "turn-on" }]);
        expect(store.runsOf("morning")[0]?.status).toBe("succeeded");
    });

    it("still fires a few minutes late, and not an hour late", async () => {
        at("2026-09-30T07:06:00.000Z");
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("morning")).toHaveLength(1);

        store.runs.clear();
        at("2026-09-30T08:00:00.000Z");
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("morning")).toHaveLength(0);
    });

    it("keeps to its days", async () => {
        at("2026-10-03T07:00:10.000Z"); // a Saturday
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("morning")).toHaveLength(0);
    });

    it("does not fire for a time that passed before it was switched on", async () => {
        const record = store.automations.get("morning")!;
        store.automations.set("morning", {
            ...record,
            armedAt: new Date("2026-09-30T07:02:00.000Z")
        });
        at("2026-09-30T07:03:00.000Z");
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("morning")).toHaveLength(0);
    });

    it("reads the time in the automation's own zone", async () => {
        const record = store.automations.get("morning")!;
        store.automations.set("morning", {
            ...record,
            definition: { ...record.definition, timeZone: "Europe/Madrid" }
        });
        // 07:00 in Madrid in September is 05:00 UTC.
        at("2026-09-30T05:00:30.000Z");
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("morning")).toHaveLength(1);
    });
});

describe("an interval", () => {
    it("fires once per period from when it was armed", async () => {
        automation(
            "every15",
            {
                triggers: [{ id: "triginterval", kind: "interval", minutes: 15 }],
                actions: [{ id: "stepnote", kind: "notify", message: "tick" }]
            },
            { armedAt: new Date("2026-09-30T06:00:00.000Z") }
        );
        later(14 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("every15")).toHaveLength(0);
        later(1 * MINUTE + 10_000);
        await engine.evaluateSchedules(INSTALL);
        later(MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("every15")).toHaveLength(1);
        later(15 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("every15")).toHaveLength(2);
    });
});

describe("a device changing", () => {
    beforeEach(() => {
        automation("follow", {
            triggers: [
                {
                    id: "trigchange",
                    kind: "change",
                    deviceId: "switch",
                    attribute: "state",
                    from: "",
                    to: "on"
                }
            ],
            actions: [{ id: "stepon", kind: "device", deviceId: "lamp", do: "turn-on" }]
        });
        devices.set("lamp", readout("lamp", "light", "off"));
    });

    it("does not count the first sight of a device as a change", async () => {
        await reads(readout("switch", "switch", "on"));
        expect(store.runsOf("follow")).toHaveLength(0);
    });

    it("fires on the change it names, once, however many syncs see it", async () => {
        await reads(readout("switch", "switch", "off"));
        later(MINUTE);
        await reads(readout("switch", "switch", "on"));
        await reads(readout("switch", "switch", "on"));
        await boot().observe(INSTALL, readout("switch", "switch", "on"));
        expect(store.runsOf("follow")).toHaveLength(1);
        expect(woken).toContain(0);
        await engine.drain();
        expect(acted).toEqual([{ deviceId: "lamp", action: "turn-on" }]);
    });

    it("still fires the others when one of them cannot", async () => {
        automation("broken", {
            triggers: [
                {
                    id: "trigchange",
                    kind: "change",
                    deviceId: "plug",
                    attribute: "state",
                    from: "",
                    to: "on"
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "broken" }]
        });
        automation("fine", {
            triggers: [
                {
                    id: "trigchange",
                    kind: "change",
                    deviceId: "plug",
                    attribute: "state",
                    from: "",
                    to: "on"
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "fine" }]
        });
        const count = store.countRunsSince.bind(store);
        store.countRunsSince = async (automationId, since) => {
            if (automationId === "broken") throw new Error("fixture database fault");
            return count(automationId, since);
        };
        await reads(readout("plug", "outlet", "off"));
        later(MINUTE);
        await reads(readout("plug", "outlet", "on"));
        await engine.drain();
        expect(notified).toEqual(["fine"]);
        expect(faults.length).toBeGreaterThan(0);
    });

    it("ignores the change it does not name", async () => {
        await reads(readout("switch", "switch", "on"));
        later(MINUTE);
        await reads(readout("switch", "switch", "off"));
        expect(store.runsOf("follow")).toHaveLength(0);
    });

    it("reads a lock passing through 'moving' as going straight to where it lands", async () => {
        automation("unlocked", {
            triggers: [
                {
                    id: "triglock",
                    kind: "change",
                    deviceId: "door",
                    attribute: "state",
                    from: "locked",
                    to: "unlocked"
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "unlocked" }]
        });
        await reads(readout("door", "lock", "locked"));
        later(MINUTE);
        await reads(readout("door", "lock", "moving"));
        later(MINUTE);
        await reads(readout("door", "lock", "unlocked"));
        expect(store.runsOf("unlocked")).toHaveLength(1);
    });

    it("hears a door sensor opening apart from the lock", async () => {
        automation("door", {
            triggers: [
                {
                    id: "trigdoor",
                    kind: "change",
                    deviceId: "door",
                    attribute: "door",
                    from: "",
                    to: "open"
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "door open" }]
        });
        await reads(readout("door", "lock", "locked", { door: "closed" }));
        later(MINUTE);
        await reads(readout("door", "lock", "locked", { door: "open" }));
        await engine.drain();
        expect(notified).toEqual(["door open"]);
    });
});

describe("a device staying in a state", () => {
    beforeEach(() => {
        automation("autooff", auto.autoOffDefinition({ id: "plug", kind: "outlet" }, 30, "UTC")!);
    });

    it("turns a switch off once it has been on for the time, and only once", async () => {
        await reads(readout("plug", "outlet", "off"));
        later(MINUTE);
        await reads(readout("plug", "outlet", "on"));
        later(29 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("autooff")).toHaveLength(0);

        later(MINUTE);
        await engine.evaluateSchedules(INSTALL);
        await engine.drain();
        expect(acted).toEqual([{ deviceId: "plug", action: "turn-off" }]);

        later(MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("autooff")).toHaveLength(1);
    });

    it("starts counting again when it is switched on again", async () => {
        await reads(readout("plug", "outlet", "on"));
        later(30 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        await engine.drain();
        await reads(readout("plug", "outlet", "on"));
        later(30 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        await engine.drain();
        expect(acted).toHaveLength(2);
    });

    it("counts a light already on from when the automation was switched on", async () => {
        await reads(readout("plug", "outlet", "on"));
        later(3 * 60 * MINUTE);
        const record = store.automations.get("autooff")!;
        store.automations.set("autooff", { ...record, armedAt: now });
        later(10 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("autooff")).toHaveLength(0);
        later(20 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("autooff")).toHaveLength(1);
    });
});

describe("a reading crossing a line", () => {
    it("fires on the way over, not while it stays over", async () => {
        automation("hot", {
            triggers: [
                {
                    id: "trighot",
                    kind: "threshold",
                    deviceId: "temp",
                    direction: "above",
                    value: 25
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "hot" }]
        });
        await reads(readout("temp", "sensor", "unknown", { reading: "20.5" }));
        later(MINUTE);
        await reads(readout("temp", "sensor", "unknown", { reading: "26" }));
        later(MINUTE);
        await reads(readout("temp", "sensor", "unknown", { reading: "27.5" }));
        expect(store.runsOf("hot")).toHaveLength(1);
        later(MINUTE);
        await reads(readout("temp", "sensor", "unknown", { reading: "24" }));
        later(MINUTE);
        await reads(readout("temp", "sensor", "unknown", { reading: "25.1" }));
        expect(store.runsOf("hot")).toHaveLength(2);
    });
});

describe("a change or a crossing that has to last", () => {
    const sensor = (reading: string) => readout("temp", "sensor", "unknown", { reading });

    it("fires a change only once it has lasted, and only for the change it names", async () => {
        automation("held", {
            triggers: [
                {
                    id: "trigheld",
                    kind: "change",
                    deviceId: "door",
                    attribute: "state",
                    from: "locked",
                    to: "unlocked",
                    forMinutes: 10
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "left open" }]
        });
        await reads(readout("door", "lock", "locked"));
        later(MINUTE);
        await reads(readout("door", "lock", "unlocked"));
        // Not the moment it happens.
        expect(store.runsOf("held")).toHaveLength(0);
        later(9 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("held")).toHaveLength(0);
        later(MINUTE);
        await engine.evaluateSchedules(INSTALL);
        later(MINUTE);
        await engine.evaluateSchedules(INSTALL);
        await engine.drain();
        expect(notified).toEqual(["left open"]);
        expect(store.runsOf("held")[0]?.cause).toMatchObject({
            kind: "change",
            from: "locked",
            to: "unlocked",
            minutes: 10
        });
    });

    it("does not fire a change that was undone in time, or that came from elsewhere", async () => {
        automation("held", {
            triggers: [
                {
                    id: "trigheld",
                    kind: "change",
                    deviceId: "door",
                    attribute: "state",
                    from: "locked",
                    to: "unlocked",
                    forMinutes: 10
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "left open" }]
        });
        // Already unlocked when first seen: no change was seen at all.
        await reads(readout("door", "lock", "unlocked"));
        later(30 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        await reads(readout("door", "lock", "locked"));
        later(MINUTE);
        await reads(readout("door", "lock", "unlocked"));
        later(5 * MINUTE);
        await reads(readout("door", "lock", "locked"));
        later(30 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("held")).toHaveLength(0);
    });

    it("fires a crossing that stayed over the line while the figure kept moving", async () => {
        automation("hot", {
            triggers: [
                {
                    id: "trighot",
                    kind: "threshold",
                    deviceId: "temp",
                    direction: "above",
                    value: 25,
                    forMinutes: 5
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "hot" }]
        });
        await reads(sensor("24"));
        later(MINUTE);
        await reads(sensor("26"));
        for (const next of ["27", "26.5", "28"]) {
            later(MINUTE);
            await reads(sensor(next));
            await engine.evaluateSchedules(INSTALL);
        }
        expect(store.runsOf("hot")).toHaveLength(0);
        later(2 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        later(MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("hot")).toHaveLength(1);
        expect(store.runsOf("hot")[0]?.cause).toMatchObject({ from: "24", to: "28", minutes: 5 });
    });

    it("starts the wait again when the figure dips back under", async () => {
        automation("hot", {
            triggers: [
                {
                    id: "trighot",
                    kind: "threshold",
                    deviceId: "temp",
                    direction: "above",
                    value: 25,
                    forMinutes: 5
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "hot" }]
        });
        await reads(sensor("24"));
        later(MINUTE);
        await reads(sensor("26"));
        later(4 * MINUTE);
        await reads(sensor("25"));
        later(MINUTE);
        await reads(sensor("26"));
        later(4 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("hot")).toHaveLength(0);
        later(MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("hot")).toHaveLength(1);
    });

    it("never fires for a figure past the line since it was first seen", async () => {
        automation("hot", {
            triggers: [
                {
                    id: "trighot",
                    kind: "threshold",
                    deviceId: "temp",
                    direction: "above",
                    value: 25,
                    forMinutes: 5
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "hot" }]
        });
        await reads(sensor("30"));
        later(MINUTE);
        await reads(sensor("31"));
        later(30 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("hot")).toHaveLength(0);
    });

    it("holds a reading condition only once every value for that long passed", async () => {
        automation("muggy", {
            conditions: {
                match: "all",
                groups: [
                    {
                        id: "group1",
                        match: "all",
                        items: [
                            {
                                id: "cond01",
                                kind: "reading",
                                deviceId: "temp",
                                op: "gt",
                                value: 25,
                                forMinutes: 10
                            }
                        ]
                    }
                ]
            },
            actions: [{ id: "stepnote", kind: "notify", message: "went" }]
        });
        const press = async (name: string) => {
            await engine.runNow(store.automations.get("muggy")!, "Fixture person", name);
            await engine.drain();
        };
        await reads(sensor("20"));
        later(MINUTE);
        await reads(sensor("26"));
        later(5 * MINUTE);
        await reads(sensor("27"));
        later(4 * MINUTE);
        await press("press-1");
        expect(notified).toEqual([]);
        later(MINUTE);
        await press("press-2");
        expect(notified).toEqual(["went"]);
    });

    it("fires a crossing held for hours while the figure moved every minute", async () => {
        automation("hot", {
            triggers: [
                {
                    id: "trighot",
                    kind: "threshold",
                    deviceId: "temp",
                    direction: "above",
                    value: 25,
                    forMinutes: 120
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "hot" }]
        });
        await reads(sensor("24"));
        later(MINUTE);
        await reads(sensor("26"));
        for (let index = 1; index < 120; index += 1) {
            later(MINUTE);
            await reads(sensor(index % 2 ? "27" : "26"));
            await engine.evaluateSchedules(INSTALL);
        }
        expect(store.runsOf("hot")).toHaveLength(0);
        later(MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("hot")).toHaveLength(1);
        expect(store.runsOf("hot")[0]?.cause).toMatchObject({ from: "24", minutes: 120 });
    });

    it("holds a reading condition for hours while the figure moved every minute", async () => {
        automation("muggy", {
            conditions: {
                match: "all",
                groups: [
                    {
                        id: "group1",
                        match: "all",
                        items: [
                            {
                                id: "cond01",
                                kind: "reading",
                                deviceId: "temp",
                                op: "gt",
                                value: 25,
                                forMinutes: 180
                            }
                        ]
                    }
                ]
            },
            actions: [{ id: "stepnote", kind: "notify", message: "went" }]
        });
        await reads(sensor("20"));
        later(MINUTE);
        await reads(sensor("26"));
        for (let index = 1; index <= 180; index += 1) {
            later(MINUTE);
            await reads(sensor(index % 2 ? "27" : "26"));
        }
        await engine.runNow(store.automations.get("muggy")!, "Fixture person", "press-1");
        await engine.drain();
        expect(notified).toEqual(["went"]);
    });

    it("keeps only the lines an automation waits on, and only while they pass", async () => {
        automation("hot", {
            triggers: [
                {
                    id: "trighot",
                    kind: "threshold",
                    deviceId: "temp",
                    direction: "above",
                    value: 25,
                    forMinutes: 5
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "hot" }]
        });
        await reads(sensor("24"));
        for (let index = 0; index < 150; index += 1) {
            later(MINUTE);
            await reads(sensor(String(26 + (index % 3))));
        }
        expect(store.observations.get("temp")?.held).toEqual({
            reading: { "gt:25": { since: expect.any(Date), from: "24" } }
        });
        later(MINUTE);
        await reads(sensor("20"));
        expect(store.observations.get("temp")?.held).toEqual({});
        await reads(readout("other", "sensor", "unknown", { reading: "30" }));
        later(MINUTE);
        await reads(readout("other", "sensor", "unknown", { reading: "31" }));
        expect(store.observations.get("other")?.held).toEqual({});
    });
});

describe("a reading coming into or leaving a range", () => {
    function ranged(direction: "between" | "outside") {
        automation("range", {
            triggers: [
                {
                    id: "trigrange",
                    kind: "threshold",
                    deviceId: "temp",
                    direction,
                    value: 18,
                    upper: 22
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "range" }]
        });
    }
    const figure = async (reading: string) => {
        later(MINUTE);
        await reads(readout("temp", "sensor", "unknown", { reading }));
    };

    it("fires on coming into the range, ends included, and not while it stays in", async () => {
        ranged("between");
        await figure("15");
        await figure("18");
        await figure("21");
        expect(store.runsOf("range")).toHaveLength(1);
        await figure("23");
        await figure("22");
        expect(store.runsOf("range")).toHaveLength(2);
    });

    it("fires on leaving the range, either way out", async () => {
        ranged("outside");
        await figure("20");
        await figure("17");
        await figure("16");
        expect(store.runsOf("range")).toHaveLength(1);
        await figure("20");
        await figure("25");
        expect(store.runsOf("range")).toHaveLength(2);
    });
});

describe("conditions", () => {
    function guarded(conditions: auto.AutomationDefinition["conditions"]) {
        automation("guarded", {
            conditions,
            actions: [{ id: "stepnote", kind: "notify", message: "went" }]
        });
    }

    it("skip a run when a device is not where they say, and say so", async () => {
        devices.set("door", readout("door", "lock", "unlocked"));
        guarded({
            match: "all",
            groups: [
                {
                    id: "group1",
                    match: "all",
                    items: [
                        {
                            id: "cond01",
                            kind: "device",
                            deviceId: "door",
                            attribute: "state",
                            is: "locked",
                            negate: false
                        }
                    ]
                }
            ]
        });
        await engine.runNow(store.automations.get("guarded")!, "Fixture person", "press-1");
        await engine.drain();
        const [run] = store.runsOf("guarded");
        expect(run?.status).toBe("skipped");
        expect(run?.reason).toBe("conditions");
        expect(notified).toEqual([]);
    });

    it("read a night window across midnight in the automation's zone", async () => {
        guarded({
            match: "all",
            groups: [
                {
                    id: "group1",
                    match: "all",
                    items: [{ id: "cond01", kind: "time", from: "22:00", to: "07:00" }]
                }
            ]
        });
        at("2026-09-30T12:00:00.000Z");
        await engine.runNow(store.automations.get("guarded")!, "Fixture person", "press-1");
        await engine.drain();
        expect(notified).toEqual([]);
        at("2026-09-30T23:30:00.000Z");
        await engine.runNow(store.automations.get("guarded")!, "Fixture person", "press-2");
        await engine.drain();
        at("2026-10-01T06:59:00.000Z");
        await engine.runNow(store.automations.get("guarded")!, "Fixture person", "press-3");
        await engine.drain();
        expect(notified).toEqual(["went", "went"]);
    });

    it("combine groups with all and any", async () => {
        devices.set("temp", readout("temp", "sensor", "unknown", { reading: "30 C" }));
        guarded({
            match: "any",
            groups: [
                {
                    id: "group1",
                    match: "all",
                    items: [{ id: "cond01", kind: "weekday", days: [0, 6] }]
                },
                {
                    id: "group2",
                    match: "any",
                    items: [
                        { id: "cond02", kind: "reading", deviceId: "temp", op: "gt", value: 28 },
                        { id: "cond03", kind: "reading", deviceId: "temp", op: "lt", value: 0 }
                    ]
                }
            ]
        });
        // A Wednesday: the first group fails, the second holds.
        await engine.runNow(store.automations.get("guarded")!, "Fixture person", "press-1");
        await engine.drain();
        expect(notified).toEqual(["went"]);
    });
});

describe("a reading condition over a range", () => {
    function within(op: "between" | "outside") {
        automation("ranged", {
            conditions: {
                match: "all",
                groups: [
                    {
                        id: "group1",
                        match: "all",
                        items: [
                            {
                                id: "cond01",
                                kind: "reading",
                                deviceId: "temp",
                                op,
                                value: 18,
                                upper: 24
                            }
                        ]
                    }
                ]
            },
            actions: [{ id: "stepnote", kind: "notify", message: "went" }]
        });
    }

    async function pressAt(reading: string, press: string) {
        devices.set("temp", readout("temp", "sensor", "unknown", { reading }));
        await engine.runNow(store.automations.get("ranged")!, "Fixture person", press);
        await engine.drain();
    }

    it("passes inside the range, both ends included", async () => {
        within("between");
        await pressAt("18 C", "press-1");
        await pressAt("24 C", "press-2");
        await pressAt("17.9 C", "press-3");
        await pressAt("30 C", "press-4");
        expect(notified).toEqual(["went", "went"]);
    });

    it("passes outside the range only", async () => {
        within("outside");
        await pressAt("21 C", "press-1");
        await pressAt("12 C", "press-2");
        await pressAt("25 C", "press-3");
        expect(notified).toEqual(["went", "went"]);
    });
});

describe("a delay", () => {
    beforeEach(() => {
        devices.set("plug", readout("plug", "outlet", "off"));
        automation("pulse", {
            actions: [
                { id: "stepon", kind: "device", deviceId: "plug", do: "turn-on" },
                { id: "stepwait", kind: "delay", seconds: 2 * 60 * 60 },
                { id: "stepoff", kind: "device", deviceId: "plug", do: "turn-off" }
            ]
        });
    });

    it("is a row with a due time, and a restarted engine finishes it", async () => {
        await engine.runNow(store.automations.get("pulse")!, "Fixture person", "press-1");
        await engine.drain();
        expect(acted.map((entry) => entry.action)).toEqual(["turn-on"]);
        const waiting = store.runsOf("pulse")[0]!;
        expect(waiting.status).toBe("waiting");
        expect(waiting.dueAt?.toISOString()).toBe("2026-09-30T08:00:00.000Z");
        // A delay longer than a tick sets no timer: the row is what counts.
        expect(woken.filter((ms) => ms > 0)).toEqual([]);

        // The dashboard restarts in the middle of it.
        engine = boot();
        later(60 * MINUTE);
        await engine.drain();
        expect(acted).toHaveLength(1);
        later(60 * MINUTE);
        await engine.drain();
        expect(acted.map((entry) => entry.action)).toEqual(["turn-on", "turn-off"]);
        expect(store.runsOf("pulse")[0]?.status).toBe("succeeded");
    });

    it("is taken over from a runner that died mid-step once its hold runs out", async () => {
        await engine.runNow(store.automations.get("pulse")!, "Fixture person", "press-1");
        const [claimed] = await store.claimDueRuns(now, new Date(now.getTime() + 2 * MINUTE), 5);
        await store.saveRun(claimed!.id, { status: "running" });
        // Nothing else may take it while it is held.
        expect(await store.claimDueRuns(now, new Date(now.getTime() + 2 * MINUTE), 5)).toHaveLength(
            0
        );
        later(3 * MINUTE);
        await boot().drain();
        expect(acted.map((entry) => entry.action)).toEqual(["turn-on"]);
    });

    it("comes back early by itself when it is short", async () => {
        automation("short", {
            actions: [
                { id: "stepwait", kind: "delay", seconds: 20 },
                { id: "stepnote", kind: "notify", message: "later" }
            ]
        });
        await engine.runNow(store.automations.get("short")!, "Fixture person", "press-1");
        await engine.drain();
        expect(woken).toContain(20_000);
        later(20_000);
        await engine.drain();
        expect(notified).toEqual(["later"]);
    });

    it("ends when the automation is switched off while it waits", async () => {
        await engine.runNow(store.automations.get("pulse")!, "Fixture person", "press-1");
        await engine.drain();
        const record = store.automations.get("pulse")!;
        store.automations.set("pulse", { ...record, enabled: false });
        later(2 * 60 * MINUTE);
        await engine.drain();
        expect(acted).toHaveLength(1);
        expect(store.runsOf("pulse")[0]).toMatchObject({ status: "stopped", reason: "disabled" });
    });

    it("does nothing more once its run was stopped from outside", async () => {
        await engine.runNow(store.automations.get("pulse")!, "Fixture person", "press-1");
        await engine.drain();
        const run = store.runsOf("pulse")[0]!;
        store.runs.set(run.id, { ...run, status: "stopped", reason: "edited" });
        later(2 * 60 * MINUTE);
        await engine.drain();
        expect(acted.map((entry) => entry.action)).toEqual(["turn-on"]);
        expect(store.runsOf("pulse")[0]).toMatchObject({ status: "stopped", reason: "edited" });
    });
});

describe("an automation that cannot be read", () => {
    it("ends its run instead of leaving it to be claimed again", async () => {
        automation("gone", { actions: [{ id: "stepnote", kind: "notify", message: "never" }] });
        await engine.runNow(store.automations.get("gone")!, "Fixture person", "press-1");
        store.automations.delete("gone");
        await engine.drain();
        expect(store.runsOf("gone")[0]).toMatchObject({ status: "failed", reason: "unreadable" });
        later(5 * MINUTE);
        expect(await store.claimDueRuns(now, new Date(now.getTime() + 2 * MINUTE), 5)).toHaveLength(
            0
        );
        expect(notified).toEqual([]);
    });
});

describe("waiting for a device", () => {
    function waiter(onTimeout: "stop" | "continue") {
        automation("waiter", {
            actions: [
                {
                    id: "stepwait",
                    kind: "wait",
                    deviceId: "door",
                    attribute: "door",
                    is: "closed",
                    timeoutMinutes: 10,
                    onTimeout
                },
                { id: "stepnote", kind: "notify", message: "closed" }
            ]
        });
    }

    it("carries on the moment the device gets there", async () => {
        waiter("stop");
        await reads(readout("door", "lock", "unlocked", { door: "open" }));
        await engine.runNow(store.automations.get("waiter")!, "Fixture person", "press-1");
        await engine.drain();
        expect(store.runsOf("waiter")[0]?.status).toBe("waiting");
        later(2 * MINUTE);
        await reads(readout("door", "lock", "unlocked", { door: "closed" }));
        await engine.drain();
        expect(notified).toEqual(["closed"]);
    });

    it("stops, or carries on, when it never does", async () => {
        waiter("stop");
        await reads(readout("door", "lock", "unlocked", { door: "open" }));
        await engine.runNow(store.automations.get("waiter")!, "Fixture person", "press-1");
        await engine.drain();
        later(11 * MINUTE);
        await engine.drain();
        expect(store.runsOf("waiter")[0]).toMatchObject({ status: "stopped", reason: "timedOut" });
        expect(notified).toEqual([]);

        waiter("continue");
        await engine.runNow(store.automations.get("waiter")!, "Fixture person", "press-2");
        await engine.drain();
        later(11 * MINUTE);
        await engine.drain();
        expect(notified).toEqual(["closed"]);
    });
});

describe("loops", () => {
    it("stops automations that start each other", async () => {
        automation("ping", { actions: [{ id: "steprun", kind: "run", automationId: "pong" }] });
        automation("pong", { actions: [{ id: "steprun", kind: "run", automationId: "ping" }] });
        await engine.runNow(store.automations.get("ping")!, "Fixture person", "press-1");
        await engine.drain();
        const all = [...store.runs.values()];
        expect(all.length).toBeLessThanOrEqual(MAX_DEPTH + 2);
        expect(all.some((run) => run.status === "refused" && run.reason === "loop")).toBe(true);
    });

    it("stops an automation that flips the device that fires it", async () => {
        automation("flip", {
            triggers: [
                {
                    id: "trigchange",
                    kind: "change",
                    deviceId: "plug",
                    attribute: "state",
                    from: "",
                    to: ""
                }
            ],
            actions: [{ id: "steptoggle", kind: "device", deviceId: "plug", do: "toggle" }]
        });
        await reads(readout("plug", "outlet", "off"));
        later(MINUTE);
        await reads(readout("plug", "outlet", "on"));
        await engine.drain();
        expect(acted.length).toBeLessThanOrEqual(MAX_DEPTH + 1);
        expect([...store.runs.values()].some((run) => run.reason === "loop")).toBe(true);
    });

    it("writes a step that could not start another automation as skipped", async () => {
        automation("starter", { actions: [{ id: "steprun", kind: "run", automationId: "busy" }] });
        automation("busy", { actions: [{ id: "stepnote", kind: "notify", message: "busy" }] });
        const count = store.countRunsSince.bind(store);
        store.countRunsSince = async (automationId, since) =>
            automationId === "busy" ? RATE_MAX : count(automationId, since);
        await engine.runNow(store.automations.get("starter")!, "Fixture person", "press-1");
        await engine.drain();
        expect(store.runsOf("starter")[0]?.steps[0]).toMatchObject({
            outcome: "skipped",
            code: "automationHeld"
        });
        expect(notified).toEqual([]);
    });

    it("holds back an automation that fires too often, and says so once", async () => {
        automation("chatty", { actions: [{ id: "stepnote", kind: "notify", message: "again" }] });
        for (let press = 0; press < RATE_MAX + 5; press += 1) {
            await engine.runNow(
                store.automations.get("chatty")!,
                "Fixture person",
                `press-${press}`
            );
        }
        const runs = store.runsOf("chatty");
        expect(runs.filter((run) => run.status === "queued")).toHaveLength(RATE_MAX);
        expect(runs.filter((run) => run.status === "limited")).toHaveLength(1);
    });
});

describe("the owner's rights", () => {
    beforeEach(() => {
        devices.set("plug", readout("plug", "outlet", "off"));
    });

    it("refuse a run whose owner can no longer operate the house", async () => {
        automation("owned", {
            actions: [{ id: "stepon", kind: "device", deviceId: "plug", do: "turn-on" }]
        });
        mayOperate = false;
        await engine.runNow(store.automations.get("owned")!, "Fixture person", "press-1");
        await engine.drain();
        expect(acted).toEqual([]);
        expect(store.runsOf("owned")[0]).toMatchObject({ status: "refused", reason: "owner" });
    });

    it("are asked again after a delay", async () => {
        automation("owned", {
            actions: [
                { id: "stepwait", kind: "delay", seconds: 3600 },
                { id: "stepon", kind: "device", deviceId: "plug", do: "turn-on" }
            ]
        });
        await engine.runNow(store.automations.get("owned")!, "Fixture person", "press-1");
        await engine.drain();
        mayOperate = false;
        later(61 * MINUTE);
        await engine.drain();
        expect(acted).toEqual([]);
        const run = store.runsOf("owned")[0]!;
        expect(run.status).toBe("refused");
        expect(run.steps.at(-1)).toMatchObject({
            stepId: "stepon",
            outcome: "refused",
            code: "owner"
        });
    });
});

describe("a device that refuses", () => {
    beforeEach(() => {
        devices.set("plug", readout("plug", "outlet", "off"));
        automation("failing", {
            actions: [
                { id: "stepon", kind: "device", deviceId: "plug", do: "turn-on" },
                { id: "stepnote", kind: "notify", message: "never" }
            ]
        });
    });

    it("is written down in the words the device service used, and stops the run", async () => {
        refuse.set(
            "plug",
            new StepRefusal("Fixture plug was not answering when it was last checked")
        );
        await engine.runNow(store.automations.get("failing")!, "Fixture person", "press-1");
        await engine.drain();
        const run = store.runsOf("failing")[0]!;
        expect(run.status).toBe("failed");
        expect(run.steps).toEqual([
            expect.objectContaining({
                stepId: "stepon",
                outcome: "failed",
                said: "Fixture plug was not answering when it was last checked"
            })
        ]);
        expect(notified).toEqual([]);
    });

    it("keeps a fault's own words out of the log and in the server's", async () => {
        refuse.set("plug", new Error("ECONNRESET 10.0.0.9:443 at tuya-cloud.ts:88"));
        await engine.runNow(store.automations.get("failing")!, "Fixture person", "press-1");
        await engine.drain();
        const run = store.runsOf("failing")[0]!;
        expect(JSON.stringify(run.steps)).not.toContain("ECONNRESET");
        expect(run.steps[0]).toMatchObject({ outcome: "failed", code: "failed" });
        expect(faults.length).toBeGreaterThan(0);
    });
});

describe("an air conditioner", () => {
    const unit = (extra: Partial<DeviceReadout> = {}) =>
        readout("ac", "climate", "on", { mode: "cool", reading: "24", ...extra });

    it("fires on a change of mode, and not on the power with the mode unchanged", async () => {
        automation("heating", {
            triggers: [
                {
                    id: "trigmode",
                    kind: "change",
                    deviceId: "ac",
                    attribute: "mode",
                    from: "",
                    to: "heat"
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "heating" }]
        });
        await reads(unit());
        later(MINUTE);
        await reads(unit({ state: "off" }));
        later(MINUTE);
        // Off reports no mode; on again in the same one is not a change of mode.
        await reads(unit({ state: "off", mode: "" }));
        later(MINUTE);
        await reads(unit());
        expect(store.runsOf("heating")).toHaveLength(0);
        later(MINUTE);
        await reads(unit({ mode: "heat" }));
        expect(store.runsOf("heating")).toHaveLength(1);
    });

    it("fires when the room crosses a temperature", async () => {
        automation("warm", {
            triggers: [
                { id: "trigwarm", kind: "threshold", deviceId: "ac", direction: "above", value: 26 }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "warm" }]
        });
        await reads(unit({ reading: "25" }));
        later(MINUTE);
        await reads(unit({ reading: "26.5" }));
        expect(store.runsOf("warm")).toHaveLength(1);
    });

    it("counts how long it has been in a mode from when the mode began", async () => {
        automation("long", {
            triggers: [
                {
                    id: "triglong",
                    kind: "stays",
                    deviceId: "ac",
                    attribute: "mode",
                    is: "heat",
                    minutes: 30
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "long" }]
        });
        await reads(unit());
        later(10 * MINUTE);
        await reads(unit({ mode: "heat" }));
        later(20 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("long")).toHaveLength(0);
        later(11 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("long")).toHaveLength(1);
    });

    it("holds a condition on its mode and on its room temperature", async () => {
        devices.set("ac", unit({ mode: "heat", reading: "19" }));
        automation("guarded", {
            conditions: {
                match: "all",
                groups: [
                    {
                        id: "groupone",
                        match: "all",
                        items: [
                            {
                                id: "condmode",
                                kind: "device",
                                deviceId: "ac",
                                attribute: "mode",
                                is: "heat",
                                negate: false
                            },
                            { id: "condtemp", kind: "reading", deviceId: "ac", op: "lt", value: 20 }
                        ]
                    }
                ]
            }
        });
        const record = store.automations.get("guarded")!;
        expect(await engine.conditionsHold(record, now)).toBe(true);
        devices.set("ac", unit({ mode: "cool", reading: "19" }));
        expect(await engine.conditionsHold(record, now)).toBe(false);
    });

    it("is set by a step, with what the step says to set", async () => {
        devices.set("ac", unit());
        automation("evening", {
            actions: [
                { id: "stepon", kind: "device", deviceId: "ac", do: "turn-on" },
                {
                    id: "stepmode",
                    kind: "device",
                    deviceId: "ac",
                    do: "set-mode",
                    setting: { action: "set-mode", mode: "heat" }
                },
                {
                    id: "steptemp",
                    kind: "device",
                    deviceId: "ac",
                    do: "set-temperature",
                    setting: { action: "set-temperature", target: 22 }
                }
            ]
        });
        await engine.runNow(store.automations.get("evening")!, "Fixture user", "press-1");
        await engine.drain();
        expect(acted).toEqual([
            { deviceId: "ac", action: "turn-on" },
            { deviceId: "ac", action: "set-mode", setting: { action: "set-mode", mode: "heat" } },
            {
                deviceId: "ac",
                action: "set-temperature",
                setting: { action: "set-temperature", target: 22 }
            }
        ]);
    });
});
describe("an air purifier", () => {
    const purifier = (figures: Record<string, string> = {}, extra: Partial<DeviceReadout> = {}) =>
        readout("air", "air", "on", {
            mode: "auto",
            reading: figures.pm25 ?? "8",
            filter: "ok",
            figures: { pm25: "8", humidity: "45", filter: "40", ...figures },
            ...extra
        });

    it("fires when the dust crosses a line, and not when the humidity does", async () => {
        automation("dusty", {
            triggers: [
                {
                    id: "trigdust",
                    kind: "threshold",
                    deviceId: "air",
                    direction: "above",
                    value: 35,
                    measure: "pm25"
                }
            ],
            actions: [
                {
                    id: "stepturbo",
                    kind: "device",
                    deviceId: "air",
                    do: "set-mode",
                    setting: { action: "set-mode", mode: "turbo" }
                }
            ]
        });
        await reads(purifier());
        later(MINUTE);
        await reads(purifier({ humidity: "80" }));
        expect(store.runsOf("dusty")).toHaveLength(0);
        later(MINUTE);
        await reads(purifier({ pm25: "41", humidity: "80" }));
        expect(store.runsOf("dusty")).toHaveLength(1);
        expect(store.runsOf("dusty")[0]?.cause).toMatchObject({
            measure: "pm25",
            from: "8",
            to: "41"
        });
        // Staying above is not crossing again.
        later(MINUTE);
        await reads(purifier({ pm25: "52", humidity: "80" }));
        expect(store.runsOf("dusty")).toHaveLength(1);
        await engine.drain();
        expect(acted).toEqual([
            { deviceId: "air", action: "set-mode", setting: { action: "set-mode", mode: "turbo" } }
        ]);
    });

    it("fires when the humidity drops below a line", async () => {
        automation("dry", {
            triggers: [
                {
                    id: "trigdry",
                    kind: "threshold",
                    deviceId: "air",
                    direction: "below",
                    value: 40,
                    measure: "humidity"
                }
            ],
            actions: [
                {
                    id: "stepon",
                    kind: "device",
                    deviceId: "air",
                    do: "set-humidity",
                    setting: { action: "set-humidity", target: 50 }
                }
            ]
        });
        await reads(purifier());
        later(MINUTE);
        await reads(purifier({ humidity: "38" }));
        expect(store.runsOf("dry")).toHaveLength(1);
    });

    it("fires when a filter's life runs low, and when a filter needs changing", async () => {
        automation("worn", {
            triggers: [
                {
                    id: "triglife",
                    kind: "threshold",
                    deviceId: "air",
                    direction: "below",
                    value: 10,
                    measure: "filter"
                },
                {
                    id: "trigstate",
                    kind: "change",
                    deviceId: "air",
                    attribute: "filter",
                    from: "",
                    to: "now"
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "Change the filter" }]
        });
        await reads(purifier());
        later(MINUTE);
        await reads(purifier({ filter: "12" }, { filter: "soon" }));
        expect(store.runsOf("worn")).toHaveLength(0);
        later(MINUTE);
        await reads(purifier({ filter: "4" }, { filter: "now" }));
        expect(
            store
                .runsOf("worn")
                .map((run) => run.cause.triggerId)
                .sort()
        ).toEqual(["triglife", "trigstate"]);
    });

    it("does not take a figure it has just learned of for a change", async () => {
        automation("dusty", {
            triggers: [
                {
                    id: "trigdust",
                    kind: "threshold",
                    deviceId: "air",
                    direction: "above",
                    value: 35,
                    measure: "pm25"
                }
            ]
        });
        await reads(readout("air", "air", "on", { mode: "auto", figures: { humidity: "45" } }));
        later(MINUTE);
        await reads(
            readout("air", "air", "on", { mode: "auto", figures: { humidity: "45", pm25: "60" } })
        );
        expect(store.runsOf("dusty")).toHaveLength(0);
        later(MINUTE);
        await reads(
            readout("air", "air", "on", { mode: "auto", figures: { humidity: "45", pm25: "20" } })
        );
        later(MINUTE);
        await reads(
            readout("air", "air", "on", { mode: "auto", figures: { humidity: "45", pm25: "40" } })
        );
        expect(store.runsOf("dusty")).toHaveLength(1);
    });

    it("holds a condition on one of its figures", async () => {
        devices.set("air", purifier({ humidity: "65" }));
        automation("humid", {
            conditions: {
                match: "all",
                groups: [
                    {
                        id: "groupone",
                        match: "all",
                        items: [
                            {
                                id: "condhum",
                                kind: "reading",
                                deviceId: "air",
                                op: "gt",
                                value: 60,
                                measure: "humidity"
                            }
                        ]
                    }
                ]
            }
        });
        const record = store.automations.get("humid")!;
        expect(await engine.conditionsHold(record, now)).toBe(true);
        devices.set("air", purifier({ humidity: "55" }));
        expect(await engine.conditionsHold(record, now)).toBe(false);
    });

    it("is switched, put on a preset and on a speed by steps", async () => {
        devices.set("air", purifier());
        automation("night", {
            actions: [
                { id: "stepon", kind: "device", deviceId: "air", do: "turn-on" },
                {
                    id: "stepmode",
                    kind: "device",
                    deviceId: "air",
                    do: "set-mode",
                    setting: { action: "set-mode", mode: "sleep" }
                },
                {
                    id: "stepfan",
                    kind: "device",
                    deviceId: "air",
                    do: "set-fan",
                    setting: { action: "set-fan", speed: "speed_1" }
                }
            ]
        });
        await engine.runNow(store.automations.get("night")!, "Fixture user", "press-1");
        await engine.drain();
        expect(acted).toEqual([
            { deviceId: "air", action: "turn-on" },
            { deviceId: "air", action: "set-mode", setting: { action: "set-mode", mode: "sleep" } },
            { deviceId: "air", action: "set-fan", setting: { action: "set-fan", speed: "speed_1" } }
        ]);
    });
});

describe("a condition held for a while", () => {
    function held(forMinutes: number, negate = false) {
        automation("held", {
            conditions: {
                match: "all",
                groups: [
                    {
                        id: "group1",
                        match: "all",
                        items: [
                            {
                                id: "cond01",
                                kind: "device",
                                deviceId: "door",
                                attribute: "state",
                                is: "unlocked",
                                negate,
                                forMinutes
                            }
                        ]
                    }
                ]
            },
            actions: [{ id: "stepnote", kind: "notify", message: "held" }]
        });
    }
    const press = async (key: string) => {
        await engine.runNow(store.automations.get("held")!, "Fixture person", key);
        await engine.drain();
        return store.runsOf("held").at(-1)?.status;
    };

    it("passes only once the device has been that way for long enough", async () => {
        await reads(readout("door", "lock", "unlocked"));
        held(10);
        later(5 * MINUTE);
        expect(await press("press-1")).toBe("skipped");
        later(6 * MINUTE);
        expect(await press("press-2")).not.toBe("skipped");
    });

    it("starts counting again when the device changes", async () => {
        await reads(readout("door", "lock", "unlocked"));
        later(30 * MINUTE);
        await reads(readout("door", "lock", "locked"));
        later(MINUTE);
        await reads(readout("door", "lock", "unlocked"));
        held(10);
        later(2 * MINUTE);
        expect(await press("press-1")).toBe("skipped");
    });

    it("counts how long it has not been so, for is not", async () => {
        await reads(readout("door", "lock", "locked"));
        held(10, true);
        later(11 * MINUTE);
        expect(await press("press-1")).not.toBe("skipped");
    });

    it("does not count from an observation that has not caught up with the device", async () => {
        await reads(readout("door", "lock", "locked"));
        later(2 * 60 * MINUTE);
        devices.set("door", readout("door", "lock", "unlocked"));
        held(10);
        expect(await press("press-1")).toBe("skipped");
    });
});

describe("a device that stops answering", () => {
    function silence(id: string, extra: Partial<auto.Trigger> = {}) {
        automation("silent", {
            triggers: [
                {
                    id: "trigsilent",
                    kind: "change",
                    deviceId: id,
                    attribute: "online",
                    from: "",
                    to: "offline",
                    ...extra
                } as auto.Trigger
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "gone quiet" }]
        });
    }

    it("is a change of its own, fired once", async () => {
        silence("plug");
        await reads(readout("plug", "outlet", "on"));
        later(MINUTE);
        await reads(readout("plug", "outlet", "on", { online: false }));
        await reads(readout("plug", "outlet", "on", { online: false }));
        expect(store.runsOf("silent")).toHaveLength(1);
        expect(store.runsOf("silent")[0]?.cause).toMatchObject({
            attribute: "online",
            from: "online",
            to: "offline"
        });
    });

    it("keeps its last state while silent, and fires nothing it says on the way back", async () => {
        automation("door", {
            triggers: [
                {
                    id: "trigopen",
                    kind: "change",
                    deviceId: "lock",
                    attribute: "door",
                    from: "",
                    to: "open"
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "opened" }]
        });
        await reads(readout("lock", "lock", "locked", { door: "closed" }));
        later(MINUTE);
        await reads(readout("lock", "lock", "locked", { door: "unknown", online: false }));
        expect((await store.observation("lock"))?.door).toBe("closed");
        later(MINUTE);
        await reads(readout("lock", "lock", "locked", { door: "open" }));
        expect(store.runsOf("door")).toHaveLength(0);
        expect((await store.observation("lock"))?.door).toBe("open");
        // From there on, a change is a change again.
        later(MINUTE);
        await reads(readout("lock", "lock", "locked", { door: "closed" }));
        later(MINUTE);
        await reads(readout("lock", "lock", "locked", { door: "open" }));
        expect(store.runsOf("door")).toHaveLength(1);
    });

    it("fires its return to whatever waits for it", async () => {
        silence("plug", { to: "online" });
        await reads(readout("plug", "outlet", "on", { online: false }));
        later(MINUTE);
        await reads(readout("plug", "outlet", "on"));
        expect(store.runsOf("silent")).toHaveLength(1);
    });

    it("counts a row kept before this was as answering", async () => {
        silence("plug");
        await reads(readout("plug", "outlet", "on"));
        const seen = await store.observation("plug");
        const { online: _online, onlineSince: _since, ...older } = seen!;
        store.observations.set("plug", older);
        later(MINUTE);
        await reads(readout("plug", "outlet", "on", { online: false }));
        expect(store.runsOf("silent")).toHaveLength(1);
    });

    it("can be a condition, which silence passes rather than fails", async () => {
        automation("check", {
            conditions: {
                match: "all",
                groups: [
                    {
                        id: "group1",
                        match: "all",
                        items: [
                            {
                                id: "cond01",
                                kind: "device",
                                deviceId: "plug",
                                attribute: "online",
                                is: "offline",
                                negate: false
                            }
                        ]
                    }
                ]
            },
            actions: [{ id: "stepnote", kind: "notify", message: "still quiet" }]
        });
        devices.set("plug", readout("plug", "outlet", "on", { online: false }));
        await engine.runNow(store.automations.get("check")!, "Fixture person", "press-1");
        await engine.drain();
        expect(notified).toEqual(["still quiet"]);
        devices.set("plug", readout("plug", "outlet", "on"));
        await engine.runNow(store.automations.get("check")!, "Fixture person", "press-2");
        await engine.drain();
        expect(store.runsOf("check").map((run) => run.status)).toContain("skipped");
    });

    it("can have to stay silent for a while", async () => {
        automation("long", {
            triggers: [
                {
                    id: "trigstays",
                    kind: "stays",
                    deviceId: "plug",
                    attribute: "online",
                    is: "offline",
                    minutes: 10
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "down a while" }]
        });
        await reads(readout("plug", "outlet", "on"));
        later(MINUTE);
        await reads(readout("plug", "outlet", "on", { online: false }));
        later(9 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("long")).toHaveLength(0);
        later(MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("long")).toHaveLength(1);
    });
});

describe("a battery running low", () => {
    beforeEach(() => {
        automation("battery", {
            triggers: [
                {
                    id: "trigbattery",
                    kind: "change",
                    deviceId: "lock",
                    attribute: "battery",
                    from: "",
                    to: "low"
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "battery low" }]
        });
    });

    it("fires once when it turns low, and not on the first sight of one already low", async () => {
        await reads(readout("lock", "lock", "locked", { battery: "low" }));
        expect(store.runsOf("battery")).toHaveLength(0);
        later(MINUTE);
        await reads(readout("lock", "lock", "locked", { battery: "ok" }));
        later(MINUTE);
        await reads(readout("lock", "lock", "locked", { battery: "low" }));
        await reads(readout("lock", "lock", "locked", { battery: "low" }));
        expect(store.runsOf("battery")).toHaveLength(1);
    });

    it("learns a battery first reported later without calling it a change", async () => {
        await reads(readout("lock", "lock", "locked"));
        later(MINUTE);
        await reads(readout("lock", "lock", "locked", { battery: "low" }));
        expect(store.runsOf("battery")).toHaveLength(0);
        expect((await store.observation("lock"))?.battery).toBe("low");
    });

    it("keeps its last word when the battery stops being reported", async () => {
        await reads(readout("lock", "lock", "locked", { battery: "ok" }));
        later(MINUTE);
        await reads(readout("lock", "lock", "locked"));
        expect((await store.observation("lock"))?.battery).toBe("ok");
    });
});

describe("a set of devices", () => {
    const LAMPS = ["lamp1", "lamp2", "lamp3"];

    function onAny(behaviour?: auto.Behaviour, extra: Record<string, unknown> = {}) {
        automation("set", {
            triggers: [
                {
                    id: "trigset",
                    kind: "change",
                    deviceId: "lamp1",
                    targets: LAMPS.map((id) => ({ kind: "device" as const, id })),
                    ...(behaviour ? { behaviour } : {}),
                    attribute: "state",
                    from: "",
                    to: "on",
                    ...extra
                } as auto.Trigger
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "set" }]
        });
    }

    async function allOff() {
        for (const id of LAMPS) await reads(readout(id, "light", "off"));
        later(MINUTE);
    }

    it("fires for each of them by default, each change once", async () => {
        onAny();
        await allOff();
        await reads(readout("lamp1", "light", "on"));
        await reads(readout("lamp2", "light", "on"));
        await reads(readout("lamp2", "light", "on"));
        expect(store.runsOf("set").map((run) => run.cause.deviceId)).toEqual(["lamp1", "lamp2"]);
    });

    it("fires for the first of them only, and again once all were off", async () => {
        onAny("first");
        await allOff();
        await reads(readout("lamp2", "light", "on"));
        await reads(readout("lamp3", "light", "on"));
        expect(store.runsOf("set")).toHaveLength(1);
        later(MINUTE);
        await allOff();
        await reads(readout("lamp1", "light", "on"));
        expect(store.runsOf("set")).toHaveLength(2);
    });

    it("fires for all of them once the last gets there, leaving out one not answering", async () => {
        onAny("all");
        await allOff();
        await reads(readout("lamp3", "light", "off", { online: false }));
        await reads(readout("lamp1", "light", "on"));
        expect(store.runsOf("set")).toHaveLength(0);
        await reads(readout("lamp2", "light", "on"));
        expect(store.runsOf("set")).toHaveLength(1);
    });

    it("waits for all of them to have lasted, counted from the last", async () => {
        onAny("all", { forMinutes: 5 });
        await allOff();
        for (const id of LAMPS) {
            await reads(readout(id, "light", "on"));
            later(2 * MINUTE);
        }
        // The last came on two minutes ago.
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("set")).toHaveLength(0);
        later(3 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("set")).toHaveLength(1);
        expect(store.runsOf("set")[0]?.cause.deviceId).toBe("lamp3");
    });

    it("does not count one gone quiet towards all of them having lasted", async () => {
        onAny("all", { forMinutes: 5 });
        await allOff();
        await reads(readout("lamp1", "light", "on"));
        await reads(readout("lamp2", "light", "on"));
        later(MINUTE);
        await reads(readout("lamp1", "light", "on", { online: false }));
        later(30 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("set")).toHaveLength(0);
    });

    function quietSet(behaviour: auto.Behaviour, extra: Record<string, unknown> = {}) {
        onAny(behaviour, { attribute: "online", to: "offline", ...extra });
    }

    it("fires for the first of them to go quiet only", async () => {
        quietSet("first");
        await allOff();
        await reads(readout("lamp1", "light", "off", { online: false }));
        await reads(readout("lamp2", "light", "off", { online: false }));
        expect(store.runsOf("set").map((run) => run.cause.deviceId)).toEqual(["lamp1"]);
    });

    it("fires for all of them gone quiet only once the last has", async () => {
        quietSet("all");
        await allOff();
        await reads(readout("lamp1", "light", "off", { online: false }));
        await reads(readout("lamp2", "light", "off", { online: false }));
        expect(store.runsOf("set")).toHaveLength(0);
        await reads(readout("lamp3", "light", "off", { online: false }));
        expect(store.runsOf("set").map((run) => run.cause.deviceId)).toEqual(["lamp3"]);
    });

    it("waits for all of them to have been quiet for long enough", async () => {
        quietSet("all", { forMinutes: 5 });
        await allOff();
        await reads(readout("lamp1", "light", "off", { online: false }));
        await reads(readout("lamp2", "light", "off", { online: false }));
        later(30 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("set")).toHaveLength(0);
        await reads(readout("lamp3", "light", "off", { online: false }));
        later(5 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("set").map((run) => run.cause.deviceId)).toEqual(["lamp3"]);
    });

    it("keeps a single device's firing named as it always was", async () => {
        automation("one", {
            triggers: [
                {
                    id: "trigone",
                    kind: "change",
                    deviceId: "lamp1",
                    attribute: "state",
                    from: "",
                    to: "on"
                }
            ],
            actions: []
        });
        await allOff();
        await reads(readout("lamp1", "light", "on"));
        expect(store.runsOf("one")[0]?.firingKey).toMatch(/^change:trigone:state:\d+$/);
    });

    function setCondition(quantifier?: auto.Quantifier) {
        automation("cond", {
            conditions: {
                match: "all",
                groups: [
                    {
                        id: "group1",
                        match: "all",
                        items: [
                            {
                                id: "cond01",
                                kind: "device",
                                deviceId: "lamp1",
                                targets: LAMPS.map((id) => ({ kind: "device" as const, id })),
                                ...(quantifier ? { quantifier } : {}),
                                attribute: "state",
                                is: "on",
                                negate: false
                            }
                        ]
                    }
                ]
            },
            actions: [{ id: "stepnote", kind: "notify", message: "passed" }]
        });
    }

    async function passes(): Promise<boolean> {
        notified = [];
        await engine.runNow(
            store.automations.get("cond")!,
            "Fixture person",
            `press-${now.getTime()}`
        );
        await engine.drain();
        later(MINUTE);
        return notified.length === 1;
    }

    it("passes a condition when any of them is, or only when all are", async () => {
        setCondition();
        devices.set("lamp1", readout("lamp1", "light", "off"));
        devices.set("lamp2", readout("lamp2", "light", "on"));
        devices.set("lamp3", readout("lamp3", "light", "off"));
        expect(await passes()).toBe(true);
        setCondition("all");
        expect(await passes()).toBe(false);
        devices.set("lamp1", readout("lamp1", "light", "on"));
        devices.set("lamp3", readout("lamp3", "light", "on", { online: false }));
        expect(await passes()).toBe(true);
    });

    it("fails any and passes all when none of them answers", async () => {
        for (const id of LAMPS) devices.set(id, readout(id, "light", "on", { online: false }));
        setCondition("any");
        expect(await passes()).toBe(false);
        setCondition("all");
        expect(await passes()).toBe(true);
    });

    const SENSORS = ["temp1", "temp2"];
    const sensor = (id: string, reading: string) => readout(id, "sensor", "unknown", { reading });

    function hotSet(behaviour: auto.Behaviour) {
        automation("hot", {
            triggers: [
                {
                    id: "trighot",
                    kind: "threshold",
                    deviceId: "temp1",
                    targets: SENSORS.map((id) => ({ kind: "device" as const, id })),
                    behaviour,
                    direction: "above",
                    value: 25,
                    forMinutes: 5
                }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "hot" }]
        });
    }

    async function allCool() {
        for (const id of SENSORS) await reads(sensor(id, "20"));
        later(MINUTE);
    }

    it("fires a crossing held on any of them, once it lasted, from the device that held it", async () => {
        hotSet("each");
        await allCool();
        await reads(sensor("temp2", "26"));
        later(MINUTE);
        await reads(sensor("temp2", "27"));
        // Every device of the set has its line kept, not only the block's first.
        expect(store.observations.get("temp2")?.held).toEqual({
            reading: { "gt:25": { since: expect.any(Date), from: "20" } }
        });
        expect(store.observations.get("temp1")?.held ?? {}).toEqual({});
        later(3 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("hot")).toHaveLength(0);
        later(MINUTE);
        await engine.evaluateSchedules(INSTALL);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("hot")).toHaveLength(1);
        expect(store.runsOf("hot")[0]?.cause).toMatchObject({
            kind: "threshold",
            deviceId: "temp2",
            from: "20",
            to: "27",
            minutes: 5
        });
    });

    it("fires a crossing held on all of them once the last has lasted", async () => {
        hotSet("all");
        await allCool();
        await reads(sensor("temp1", "26"));
        later(2 * MINUTE);
        await reads(sensor("temp2", "26"));
        for (const id of SENSORS) {
            expect(store.observations.get(id)?.held).toEqual({
                reading: { "gt:25": { since: expect.any(Date), from: "20" } }
            });
        }
        // The first has lasted, the last only three minutes.
        later(3 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("hot")).toHaveLength(0);
        later(2 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("hot")).toHaveLength(1);
        expect(store.runsOf("hot")[0]?.cause.deviceId).toBe("temp2");
    });

    it("does not fire a crossing on all of them while one of them never crossed", async () => {
        hotSet("all");
        await allCool();
        await reads(sensor("temp1", "26"));
        later(MINUTE);
        await reads(sensor("temp2", "24"));
        later(30 * MINUTE);
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("hot")).toHaveLength(0);
    });

    function warmCondition(quantifier: auto.Quantifier) {
        automation("warm", {
            conditions: {
                match: "all",
                groups: [
                    {
                        id: "group1",
                        match: "all",
                        items: [
                            {
                                id: "cond01",
                                kind: "reading",
                                deviceId: "temp1",
                                targets: SENSORS.map((id) => ({ kind: "device" as const, id })),
                                quantifier,
                                op: "gt",
                                value: 25,
                                forMinutes: 10
                            }
                        ]
                    }
                ]
            },
            actions: [{ id: "stepnote", kind: "notify", message: "warm" }]
        });
    }

    async function warmPasses(): Promise<boolean> {
        notified = [];
        await engine.runNow(
            store.automations.get("warm")!,
            "Fixture person",
            `press-${now.getTime()}`
        );
        await engine.drain();
        return notified.length === 1;
    }

    it("holds a reading condition on any of them once one has been over for long enough", async () => {
        warmCondition("any");
        await allCool();
        await reads(sensor("temp2", "26"));
        // Still over, but moved: counted from the crossing, not the last value.
        later(5 * MINUTE);
        await reads(sensor("temp2", "27"));
        later(4 * MINUTE);
        expect(await warmPasses()).toBe(false);
        later(MINUTE);
        expect(await warmPasses()).toBe(true);
    });

    it("holds a reading condition on all of them only once each has been over for long enough", async () => {
        warmCondition("all");
        await allCool();
        await reads(sensor("temp1", "26"));
        later(5 * MINUTE);
        await reads(sensor("temp2", "26"));
        later(2 * MINUTE);
        await reads(sensor("temp2", "27"));
        later(3 * MINUTE);
        // temp1 has lasted, temp2 only five minutes.
        expect(await warmPasses()).toBe(false);
        later(5 * MINUTE);
        expect(await warmPasses()).toBe(true);
        await reads(sensor("temp1", "24"));
        expect(await warmPasses()).toBe(false);
    });
});

describe("a room or a floor", () => {
    function inRooms(entries: [string, string, string][]) {
        scope = {
            devices: entries.map(([id, kind, roomId]) => ({ id, kind, roomId })),
            rooms: [
                { id: "kitchen", floorId: "ground" },
                { id: "hall", floorId: "ground" },
                { id: "bedroom", floorId: "upstairs" }
            ]
        };
    }

    function whenOn(target: { kind: "room" | "floor"; id: string }, behaviour?: auto.Behaviour) {
        automation("where", {
            triggers: [
                {
                    id: "trigwhere",
                    kind: "change",
                    deviceId: "lamp1",
                    targets: [target],
                    ...(behaviour ? { behaviour } : {}),
                    attribute: "state",
                    from: "",
                    to: "on"
                } as auto.Trigger
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "where" }]
        });
    }

    it("fires for whatever is in the room now, not for the device it was saved with", async () => {
        inRooms([
            ["lamp1", "light", "bedroom"],
            ["lamp2", "light", "kitchen"]
        ]);
        whenOn({ kind: "room", id: "kitchen" });
        await reads(readout("lamp1", "light", "off"));
        await reads(readout("lamp2", "light", "off"));
        later(MINUTE);
        await reads(readout("lamp1", "light", "on"));
        expect(store.runsOf("where")).toHaveLength(0);
        await reads(readout("lamp2", "light", "on"));
        expect(store.runsOf("where").map((run) => run.cause.deviceId)).toEqual(["lamp2"]);
    });

    it("counts a device moved into the room from then on", async () => {
        inRooms([["lamp1", "light", "bedroom"]]);
        whenOn({ kind: "room", id: "kitchen" });
        await reads(readout("lamp1", "light", "off"));
        later(MINUTE);
        inRooms([["lamp1", "light", "kitchen"]]);
        await reads(readout("lamp1", "light", "on"));
        expect(store.runsOf("where")).toHaveLength(1);
    });

    it("reads a floor as every room on it, and the set counts as one", async () => {
        inRooms([
            ["lamp1", "light", "kitchen"],
            ["lamp2", "light", "hall"],
            ["lamp3", "light", "bedroom"]
        ]);
        whenOn({ kind: "floor", id: "ground" }, "all");
        for (const id of ["lamp1", "lamp2", "lamp3"]) await reads(readout(id, "light", "off"));
        later(MINUTE);
        await reads(readout("lamp1", "light", "on"));
        await reads(readout("lamp3", "light", "on"));
        expect(store.runsOf("where")).toHaveLength(0);
        await reads(readout("lamp2", "light", "on"));
        expect(store.runsOf("where")).toHaveLength(1);
    });

    it("leaves out what in the room cannot answer, and holds nothing where it is empty", async () => {
        inRooms([
            ["lamp1", "light", "kitchen"],
            ["temp1", "sensor", "kitchen"]
        ]);
        automation("warm", {
            triggers: [{ id: "trigmanual", kind: "manual" }],
            conditions: {
                match: "all",
                groups: [
                    {
                        id: "grpwhere",
                        match: "all",
                        items: [
                            {
                                id: "condwhere",
                                kind: "device",
                                deviceId: "lamp1",
                                targets: [{ kind: "room", id: "kitchen" }],
                                quantifier: "all",
                                attribute: "state",
                                is: "on",
                                negate: false
                            }
                        ]
                    }
                ]
            },
            actions: [{ id: "stepnote", kind: "notify", message: "warm" }]
        });
        const resolved = auto.resolveDefinition(store.automations.get("warm")!.definition, scope);
        const condition = resolved.conditions.groups[0]!.items[0]!;
        expect(auto.deviceTargets(condition as { deviceId: string })).toEqual(["lamp1"]);
        scope = { devices: [], rooms: scope.rooms };
        const empty = auto.resolveDefinition(store.automations.get("warm")!.definition, scope);
        expect((empty.conditions.groups[0]!.items[0] as { deviceId: string }).deviceId).toBe("");
    });
});

describe("a step on a set of devices", () => {
    it("tells every device of the set, and fails with the one that refused", async () => {
        for (const id of ["lamp1", "lamp2", "lamp3"]) await reads(readout(id, "light", "off"));
        refuse.set("lamp2", new StepRefusal("That device is not answering"));
        automation("lights", {
            actions: [
                {
                    id: "stepon",
                    kind: "device",
                    deviceId: "lamp1",
                    targets: ["lamp1", "lamp2", "lamp3"].map((id) => ({
                        kind: "device" as const,
                        id
                    })),
                    do: "turn-on"
                }
            ]
        });
        await engine.runNow(store.automations.get("lights")!, "Fixture person", "press-1");
        await engine.drain();
        expect(acted.map((each) => each.deviceId)).toEqual(["lamp1", "lamp3"]);
        expect(store.runsOf("lights")[0]?.status).toBe("failed");
    });

    it("tells whatever is in the room when the step runs", async () => {
        await reads(readout("lamp1", "light", "off"));
        await reads(readout("lamp2", "light", "off"));
        scope = {
            devices: [
                { id: "lamp1", kind: "light", roomId: "kitchen" },
                { id: "lamp2", kind: "light", roomId: "hall" }
            ],
            rooms: [
                { id: "kitchen", floorId: "" },
                { id: "hall", floorId: "" }
            ]
        };
        automation("kitchen", {
            actions: [
                {
                    id: "stepon",
                    kind: "device",
                    deviceId: "lamp2",
                    targets: [{ kind: "room", id: "kitchen" }],
                    do: "turn-on"
                }
            ]
        });
        await engine.runNow(store.automations.get("kitchen")!, "Fixture person", "press-1");
        await engine.drain();
        expect(acted.map((each) => each.deviceId)).toEqual(["lamp1"]);
    });

    it("waits for any of them by default, or for all of them", async () => {
        const doors = ["door1", "door2"];
        for (const quantifier of ["any", "all"] as const) {
            for (const id of doors) await reads(readout(id, "lock", "unlocked", { door: "open" }));
            notified = [];
            automation(`wait-${quantifier}`, {
                actions: [
                    {
                        id: "stepwait",
                        kind: "wait",
                        deviceId: "door1",
                        targets: doors.map((id) => ({ kind: "device" as const, id })),
                        quantifier,
                        attribute: "door",
                        is: "closed",
                        timeoutMinutes: 10,
                        onTimeout: "stop"
                    },
                    { id: "stepnote", kind: "notify", message: quantifier }
                ]
            });
            await engine.runNow(
                store.automations.get(`wait-${quantifier}`)!,
                "Fixture person",
                `press-${quantifier}`
            );
            await engine.drain();
            later(MINUTE);
            await reads(readout("door2", "lock", "unlocked", { door: "closed" }));
            later(2 * MINUTE);
            await engine.drain();
            expect(notified).toEqual(quantifier === "any" ? ["any"] : []);
            if (quantifier === "all") {
                await reads(readout("door1", "lock", "unlocked", { door: "closed" }));
                later(2 * MINUTE);
                await engine.drain();
                expect(notified).toEqual(["all"]);
            }
        }
    });
});
describe("the sun", () => {
    const LONDON = { latitude: 51.51, longitude: -0.13 };
    const sunset = {
        id: "trigsun",
        kind: "sun" as const,
        event: "sunset" as const,
        offset: { amount: 15, unit: "minutes" as const, direction: "before" as const }
    };

    it("fires once on the day at its offset, and once across a restart", async () => {
        at("2024-06-21T12:00:00.000Z");
        automation("dusk", { timeZone: "Europe/London", triggers: [sunset] }, { location: LONDON });
        // Sunset in London that day is 20:21 UTC; 15 minutes before is 20:06.
        at("2024-06-21T20:05:00.000Z");
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("dusk")).toHaveLength(0);

        at("2024-06-21T20:06:40.000Z");
        await engine.evaluateSchedules(INSTALL);
        at("2024-06-21T20:08:00.000Z");
        await engine.evaluateSchedules(INSTALL);
        // A restarted process looking at the same minutes.
        await boot().evaluateSchedules(INSTALL);
        const runs = store.runsOf("dusk");
        expect(runs).toHaveLength(1);
        expect(runs[0]?.firingKey).toBe("sun:trigsun:sunset:2024-06-21");
        expect(runs[0]?.cause).toMatchObject({
            kind: "sun",
            triggerId: "trigsun",
            event: "sunset"
        });

        // Down past the catch-up window: that one is missed, never fired late.
        at("2024-06-22T21:00:00.000Z");
        await engine.evaluateSchedules(INSTALL);
        expect(store.runsOf("dusk")).toHaveLength(1);
    });

    it("never fires with no location, nor where the event does not happen", async () => {
        at("2024-06-21T12:00:00.000Z");
        automation("nowhere", { timeZone: "Europe/London", triggers: [sunset] });
        automation(
            "arctic",
            {
                timeZone: "Europe/Oslo",
                triggers: [{ id: "trigsun", kind: "sun", event: "sunset" }]
            },
            { location: { latitude: 69.65, longitude: 18.96 } }
        );
        for (const iso of [
            "2024-06-21T20:07:00.000Z",
            "2024-06-21T22:00:00.000Z",
            "2024-06-21T23:30:00.000Z"
        ]) {
            at(iso);
            await engine.evaluateSchedules(INSTALL);
        }
        expect(store.runsOf("nowhere")).toHaveLength(0);
        expect(store.runsOf("arctic")).toHaveLength(0);
        expect(
            lastSunOccurrence(
                { id: "x1x1", kind: "sun", event: "sunset" },
                { latitude: 69.65, longitude: 18.96 },
                "Europe/Oslo",
                new Date("2024-06-21T23:00:00.000Z")
            )
        ).toBeNull();
    });
});

describe("triggered by", () => {
    it("passes only for the trigger that started the run", async () => {
        devices.set("plug", readout("plug", "outlet", "off"));
        const record = automation("which", {
            triggers: [
                { id: "trigtime", kind: "time", at: "07:00", days: [0, 1, 2, 3, 4, 5, 6] },
                { id: "trigmanual", kind: "manual" }
            ],
            conditions: {
                match: "all",
                groups: [
                    {
                        id: "groupone",
                        match: "all",
                        items: [{ id: "condby", kind: "triggeredBy", triggerIds: ["trigtime"] }]
                    }
                ]
            },
            actions: [{ id: "stepon", kind: "device", deviceId: "plug", do: "turn-on" }]
        });
        const time = { kind: "time" as const, triggerId: "trigtime", at: "" };
        const hand = { kind: "manual" as const, triggerId: "trigmanual", at: "" };
        expect(await engine.conditionsHold(record, now, time)).toBe(true);
        expect(await engine.conditionsHold(record, now, hand)).toBe(false);
        expect(await engine.conditionsHold(record, now)).toBe(false);

        // Run now counts as its "Run by hand" trigger, which is not picked.
        await engine.runNow(record, "Ana", "press-1");
        await engine.drain();
        expect(store.runsOf("which")[0]?.cause.triggerId).toBe("trigmanual");
        expect(store.runsOf("which")[0]?.status).toBe("skipped");

        at("2026-09-30T07:00:30.000Z");
        await engine.evaluateSchedules(INSTALL);
        await engine.drain();
        expect(acted).toEqual([{ deviceId: "plug", action: "turn-on" }]);
    });
});

describe("an automation that moved to the central engine", () => {
    const CENTRAL = { automationId: "central-1", legacyId: null };

    it("has its held-for trigger decided here, and starts a central run instead of its own", async () => {
        await reads(readout("door", "contact", "off", { door: "closed" }));
        automation(
            "moved",
            {
                triggers: [
                    { id: "trigdoor", kind: "change", deviceId: "door", attribute: "door", from: "closed", to: "open", forMinutes: 5 }
                ],
                actions: []
            },
            { central: CENTRAL }
        );
        await reads(readout("door", "contact", "off", { door: "open" }));
        await engine.evaluateSchedules(INSTALL);
        expect(centralFired).toEqual([]);
        later(5 * MINUTE + 1000);
        await engine.evaluateSchedules(INSTALL);
        expect(centralFired).toEqual([
            expect.objectContaining({ automationId: "central-1", triggerId: "trigdoor", depth: 0 })
        ]);
        await engine.evaluateSchedules(INSTALL);
        // Asked again, it hands over the same firing key: the central engine starts one run per key.
        expect(new Set(centralFired.map((each) => each.key)).size).toBe(1);
        expect(store.runsOf("moved")).toEqual([]);
    });

    it("fires its time of day once, as the central automation", async () => {
        automation(
            "moved",
            { triggers: [{ id: "trigtime", kind: "time", at: "07:00", days: [3] }], actions: [] },
            { central: CENTRAL }
        );
        at("2026-09-30T07:00:20.000Z");
        await engine.evaluateSchedules(INSTALL);
        await boot().evaluateSchedules(INSTALL);
        expect(new Set(centralFired.map((each) => `${each.triggerId}:${each.key}`)).size).toBe(1);
        expect(store.runsOf("moved")).toEqual([]);
    });

    it("Run now on a moved automation starts its central twin", async () => {
        const record = automation("moved", {}, { central: { automationId: "central-1", legacyId: "moved" } });
        expect(await engine.runNow(record, "owner-1", "k1")).toBe(true);
        expect(centralFired).toEqual([
            expect.objectContaining({ automationId: "central-1", key: "manual:k1", triggerId: "trigmanual" })
        ]);
        expect(store.runsOf("moved")).toEqual([]);
    });

    it("a run that was already waiting before the move still finishes here", async () => {
        devices.set("plug", readout("plug", "outlet", "off"));
        const record = automation("old", {
            actions: [
                { id: "stepwait", kind: "delay", seconds: 60 },
                { id: "stepon", kind: "device", deviceId: "plug", do: "turn-on" }
            ]
        });
        await engine.runNow(record, "owner-1", "k1");
        await engine.drain();
        expect(store.runsOf("old")[0]?.status).toBe("waiting");
        // The move: the row now answers as its central twin.
        store.automations.set("old", { ...record, central: { automationId: "central-1", legacyId: "old" } });
        later(61_000);
        await engine.drain();
        expect(store.runsOf("old")[0]?.status).toBe("succeeded");
        expect(acted).toEqual([{ deviceId: "plug", action: "turn-on" }]);
        expect(centralFired).toEqual([]);
    });
});
