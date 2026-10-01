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
    type RunRecord
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
let mayOperate: boolean;
let refuse: Map<string, Error>;
let engine: AutomationEngine;

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
        mayOperate: async () => mayOperate,
        notify: async (_automation, message) => {
            notified.push(message);
        },
        wake: (ms) => woken.push(ms),
        log: (message) => faults.push(message)
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
    mayOperate = true;
    refuse = new Map();
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
            triggers: [{ id: "trigdust", kind: "threshold", deviceId: "air", direction: "above", value: 35, measure: "pm25" }],
            actions: [{ id: "stepturbo", kind: "device", deviceId: "air", do: "set-mode", setting: { action: "set-mode", mode: "turbo" } }]
        });
        await reads(purifier());
        later(MINUTE);
        await reads(purifier({ humidity: "80" }));
        expect(store.runsOf("dusty")).toHaveLength(0);
        later(MINUTE);
        await reads(purifier({ pm25: "41", humidity: "80" }));
        expect(store.runsOf("dusty")).toHaveLength(1);
        expect(store.runsOf("dusty")[0]?.cause).toMatchObject({ measure: "pm25", from: "8", to: "41" });
        // Staying above is not crossing again.
        later(MINUTE);
        await reads(purifier({ pm25: "52", humidity: "80" }));
        expect(store.runsOf("dusty")).toHaveLength(1);
        await engine.drain();
        expect(acted).toEqual([{ deviceId: "air", action: "set-mode", setting: { action: "set-mode", mode: "turbo" } }]);
    });

    it("fires when the humidity drops below a line", async () => {
        automation("dry", {
            triggers: [{ id: "trigdry", kind: "threshold", deviceId: "air", direction: "below", value: 40, measure: "humidity" }],
            actions: [{ id: "stepon", kind: "device", deviceId: "air", do: "set-humidity", setting: { action: "set-humidity", target: 50 } }]
        });
        await reads(purifier());
        later(MINUTE);
        await reads(purifier({ humidity: "38" }));
        expect(store.runsOf("dry")).toHaveLength(1);
    });

    it("fires when a filter's life runs low, and when a filter needs changing", async () => {
        automation("worn", {
            triggers: [
                { id: "triglife", kind: "threshold", deviceId: "air", direction: "below", value: 10, measure: "filter" },
                { id: "trigstate", kind: "change", deviceId: "air", attribute: "filter", from: "", to: "now" }
            ],
            actions: [{ id: "stepnote", kind: "notify", message: "Change the filter" }]
        });
        await reads(purifier());
        later(MINUTE);
        await reads(purifier({ filter: "12" }, { filter: "soon" }));
        expect(store.runsOf("worn")).toHaveLength(0);
        later(MINUTE);
        await reads(purifier({ filter: "4" }, { filter: "now" }));
        expect(store.runsOf("worn").map((run) => run.cause.triggerId).sort()).toEqual(["triglife", "trigstate"]);
    });

    it("does not take a figure it has just learned of for a change", async () => {
        automation("dusty", {
            triggers: [{ id: "trigdust", kind: "threshold", deviceId: "air", direction: "above", value: 35, measure: "pm25" }]
        });
        await reads(readout("air", "air", "on", { mode: "auto", figures: { humidity: "45" } }));
        later(MINUTE);
        await reads(readout("air", "air", "on", { mode: "auto", figures: { humidity: "45", pm25: "60" } }));
        expect(store.runsOf("dusty")).toHaveLength(0);
        later(MINUTE);
        await reads(readout("air", "air", "on", { mode: "auto", figures: { humidity: "45", pm25: "20" } }));
        later(MINUTE);
        await reads(readout("air", "air", "on", { mode: "auto", figures: { humidity: "45", pm25: "40" } }));
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
                        items: [{ id: "condhum", kind: "reading", deviceId: "air", op: "gt", value: 60, measure: "humidity" }]
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
                { id: "stepmode", kind: "device", deviceId: "air", do: "set-mode", setting: { action: "set-mode", mode: "sleep" } },
                { id: "stepfan", kind: "device", deviceId: "air", do: "set-fan", setting: { action: "set-fan", speed: "speed_1" } }
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
