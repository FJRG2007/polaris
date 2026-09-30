/**
 * What runs the automations: deciding when one fires, whether it may, and
 * walking its steps.
 *
 * Everything it touches comes in through `EnginePorts` - the clock, the rows,
 * the devices, the owner's rights, the bell - so the whole of it can be run
 * against a fake clock and an in-memory store, and the one wired to the database
 * (`automation-runtime.ts`) is only plumbing.
 *
 * The rules it keeps:
 *
 * - **A firing happens once.** Every run carries a key naming what fired it (this
 *   07:00, this change of this device, this press of Run now) and the store
 *   refuses a second row with the same key. Two passes, two processes or a pass
 *   that ran twice all come out as one run.
 * - **Nothing waits in memory.** A delay or a wait is a due time on the run's row,
 *   and the minute tick resumes whatever is due. A short delay also sets a timer
 *   to come back sooner, but the row is what counts: a restart in the middle of a
 *   two-hour delay loses nothing.
 * - **Loops end.** An automation started by another carries a depth, and so does
 *   one fired by a device a run just moved; past `MAX_DEPTH` it is refused. And
 *   however it is fired, one automation runs at most `RATE_MAX` times in
 *   `RATE_WINDOW_MS`.
 * - **It acts as its owner, every time.** The owner's right to operate the house
 *   is asked again at the start of each run, and a device step goes through the
 *   same service as the button on the screen.
 *
 * Server-only.
 */

import * as auto from "./automation-kinds";
import type { DeviceAction } from "./device-kinds";
import { AsyncLocalStorage } from "node:async_hooks";
import { wallClock, zonedInstant } from "@polaris/core";

/** How far into a chain of automations starting one another a run may be. */
export const MAX_DEPTH = 4;
/** How many runs one automation may start in a window, whatever fires it. */
export const RATE_MAX = 20;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
/** How late a time of day or an interval may still be honoured - a tick that ran
 *  late, or a restart. Longer than this and it was missed, not late. */
export const CATCH_UP_MS = 10 * 60 * 1000;
/** How long a runner holds a run before another may take it over. */
export const LEASE_MS = 2 * 60 * 1000;
/** How often a waiting step looks again when nothing wakes it sooner. */
export const RECHECK_MS = 60 * 1000;
/** The longest delay kept as a timer in memory as well as on the row. */
export const TIMER_MS = 60 * 1000;
/** How many runs of one automation the log keeps. */
export const KEEP_RUNS = 100;

// --- what the engine is given ---------------------------------------------------

export interface AutomationRecord {
    readonly id: string;
    readonly installedAppId: string;
    readonly placeId: string;
    readonly ownerId: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly definition: auto.AutomationDefinition;
    readonly armedAt: Date;
}

export interface RunRecord {
    readonly id: string;
    readonly automationId: string;
    readonly firingKey: string;
    readonly cause: auto.RunCause;
    readonly depth: number;
    readonly status: auto.RunStatus;
    readonly step: number;
    readonly dueAt: Date | null;
    readonly waitUntil: Date | null;
    readonly waitDeviceId: string | null;
    readonly lockedUntil: Date | null;
    readonly steps: readonly auto.StepLog[];
    readonly reason: string | null;
    readonly startedAt: Date;
    readonly finishedAt: Date | null;
}

export type RunPatch = Partial<Omit<RunRecord, "id" | "automationId" | "firingKey">>;

/** What a device was last seen doing, and since when. */
export interface Observation {
    readonly state: string;
    readonly stateSince: Date;
    readonly door: string;
    readonly doorSince: Date;
    readonly reading: string;
    readonly readingSince: Date;
    /** Counts every change, so each one has a name of its own even when two
     *  land in the same millisecond - and so the swap has one field to compare. */
    readonly version: number;
}

/** A device as the engine reads it. */
export interface DeviceReadout {
    readonly id: string;
    readonly kind: string;
    readonly name: string;
    readonly state: string;
    readonly door: string;
    readonly reading: string;
    readonly online: boolean;
}

export interface AutomationStore {
    enabledAutomations(installedAppId: string): Promise<AutomationRecord[]>;
    automation(id: string): Promise<AutomationRecord | null>;
    /** A new run, or null when one with this key already exists. */
    createRun(input: {
        automationId: string;
        firingKey: string;
        cause: auto.RunCause;
        depth: number;
        status: auto.RunStatus;
        dueAt: Date | null;
        startedAt: Date;
        steps?: readonly auto.StepLog[];
        reason?: string | null;
        finishedAt?: Date | null;
    }): Promise<RunRecord | null>;
    /** How many runs that actually ran started since then. */
    countRunsSince(automationId: string, since: Date): Promise<number>;
    /** Take the queued and waiting runs that are due and free, marking each held
     *  until `lockUntil`. A run another runner holds is not returned. */
    claimDueRuns(now: Date, lockUntil: Date, limit: number): Promise<RunRecord[]>;
    saveRun(id: string, patch: RunPatch): Promise<void>;
    /** Bring forward every run waiting on this device, so it looks now. */
    wakeWaiting(deviceId: string, now: Date): Promise<void>;
    markAutomation(id: string, at: Date, status: auto.RunStatus): Promise<void>;
    observation(deviceId: string): Promise<Observation | null>;
    /** Replace what a device was seen doing, only if it is still `previous`. */
    swapObservation(deviceId: string, previous: Observation | null, next: Observation): Promise<boolean>;
    pruneRuns(automationId: string, keep: number): Promise<void>;
}

/** Why a device step did not happen, as the device service refuses. */
export class StepRefusal extends Error {}

export interface EnginePorts {
    readonly now: () => Date;
    readonly store: AutomationStore;
    readonly devices: {
        read(installedAppId: string, deviceId: string): Promise<DeviceReadout | null>;
        /** Throws a `StepRefusal` with a sentence Places wrote, or anything else
         *  for a fault. */
        act(
            installedAppId: string,
            deviceId: string,
            action: DeviceAction,
            by: { ownerId: string; automationId: string; automationName: string }
        ): Promise<void>;
    };
    /** Whether the owner still holds a right: "run" is keeping automations at
     *  all, "control" is operating the devices a step names. */
    readonly mayOperate: (ownerId: string, right: "run" | "control") => Promise<boolean>;
    readonly notify: (automation: AutomationRecord, message: string, runId: string) => Promise<void>;
    /** Come back and drain in this many milliseconds. */
    readonly wake?: (ms: number) => void;
    /** Where a fault that is not a refusal is written. */
    readonly log?: (message: string, error: unknown) => void;
}

/** Which run, if any, the current work is being done on behalf of - so a device
 *  it moves passes its depth on to whatever that change fires. */
const causeContext = new AsyncLocalStorage<{ readonly depth: number }>();

function iso(date: Date): string {
    return date.toISOString();
}

// --- reading devices ------------------------------------------------------------

/** The value of one attribute, as triggers and conditions compare it. */
function attributeOf(
    source: { state: string; door: string; reading: string },
    attribute: auto.AutomationAttribute
): string {
    if (attribute === "door") return source.door;
    if (attribute === "reading") return source.reading;
    return source.state;
}

/** Two words for the same thing. A reading is whatever the sensor sends, in
 *  whatever case; a state is one of ours. */
function same(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function numberOf(text: string): number | null {
    const match = /-?\d+(?:[.,]\d+)?/.exec(text);
    if (!match) return null;
    const value = Number(match[0].replace(",", "."));
    return Number.isFinite(value) ? value : null;
}

function compare(value: number, op: auto.Comparison, against: number): boolean {
    switch (op) {
        case "gt":
            return value > against;
        case "gte":
            return value >= against;
        case "lt":
            return value < against;
        case "lte":
            return value <= against;
        case "eq":
            return value === against;
        case "ne":
            return value !== against;
    }
}

function minutesOf(clock: string): number {
    const [hours, minutes] = clock.split(":").map(Number);
    return (hours ?? 0) * 60 + (minutes ?? 0);
}

// --- the engine -------------------------------------------------------------------

export interface Transition {
    readonly deviceId: string;
    readonly attribute: auto.AutomationAttribute;
    readonly from: string;
    readonly to: string;
    readonly at: Date;
    /** The observation this change made, which is what names the firing. */
    readonly version: number;
}

export function createEngine(ports: EnginePorts) {
    const { store } = ports;
    let draining: Promise<void> | null = null;
    let again = false;

    const fault = (message: string, error: unknown) =>
        (ports.log ?? ((said, caught) => console.error(`places: ${said}`, caught)))(message, error);

    /**
     * Start a run, unless this firing already has one or the automation has run
     * too often lately. Returns whether a run was queued.
     */
    async function fire(
        automation: AutomationRecord,
        firingKey: string,
        cause: auto.RunCause,
        depth: number
    ): Promise<boolean> {
        const now = ports.now();
        if (depth > MAX_DEPTH) {
            // Written once per firing, so the log says why a chain stopped rather
            // than going quiet.
            await store.createRun({
                automationId: automation.id,
                firingKey,
                cause,
                depth,
                status: "refused",
                dueAt: null,
                startedAt: now,
                finishedAt: now,
                reason: "loop"
            });
            await store.markAutomation(automation.id, now, "refused");
            return false;
        }
        const recent = await store.countRunsSince(automation.id, new Date(now.getTime() - RATE_WINDOW_MS));
        if (recent >= RATE_MAX) {
            // One row per window, not one per firing: a device flapping twice a
            // second would otherwise fill the log with the same sentence.
            const window = Math.floor(now.getTime() / RATE_WINDOW_MS);
            const written = await store.createRun({
                automationId: automation.id,
                firingKey: `limited:${window}`,
                cause,
                depth,
                status: "limited",
                dueAt: null,
                startedAt: now,
                finishedAt: now,
                reason: "limited"
            });
            if (written) await store.markAutomation(automation.id, now, "limited");
            return false;
        }
        const run = await store.createRun({
            automationId: automation.id,
            firingKey,
            cause,
            depth,
            status: "queued",
            dueAt: now,
            startedAt: now
        });
        if (!run) return false;
        await store.pruneRuns(automation.id, KEEP_RUNS);
        return true;
    }

    /**
     * What a device is doing now, compared with what it was last seen doing.
     *
     * The comparison is a swap on the stored row that only succeeds against the
     * row that was read, so however many syncs see the same change at once, one
     * of them fires the automations and the rest find nothing new. The first time
     * a device is seen is not a change.
     */
    async function observe(installedAppId: string, device: DeviceReadout): Promise<Transition[]> {
        // A device that is not answering is not doing anything we know of, and a
        // lock on its way somewhere is not anywhere yet.
        if (!device.online) return [];
        const now = ports.now();
        const previous = await store.observation(device.id);
        const passing = device.state === "moving" || device.state === "unknown";
        const state = passing ? (previous?.state ?? device.state) : device.state;
        if (!previous) {
            await store.swapObservation(device.id, null, {
                state,
                stateSince: now,
                door: device.door,
                doorSince: now,
                reading: device.reading,
                readingSince: now,
                version: 0
            });
            return [];
        }
        const changed: Transition[] = [];
        const next = {
            state: previous.state,
            stateSince: previous.stateSince,
            door: previous.door,
            doorSince: previous.doorSince,
            reading: previous.reading,
            readingSince: previous.readingSince,
            version: previous.version + 1
        };
        const version = next.version;
        if (state !== previous.state) {
            changed.push({ deviceId: device.id, attribute: "state", from: previous.state, to: state, at: now, version });
            next.state = state;
            next.stateSince = now;
        }
        if (device.door !== previous.door) {
            changed.push({ deviceId: device.id, attribute: "door", from: previous.door, to: device.door, at: now, version });
            next.door = device.door;
            next.doorSince = now;
        }
        if (device.reading !== previous.reading) {
            changed.push({
                deviceId: device.id,
                attribute: "reading",
                from: previous.reading,
                to: device.reading,
                at: now,
                version
            });
            next.reading = device.reading;
            next.readingSince = now;
        }
        if (changed.length === 0) return [];
        if (!(await store.swapObservation(device.id, previous, next))) return [];

        const depth = (causeContext.getStore()?.depth ?? -1) + 1;
        const automations = await store.enabledAutomations(installedAppId);
        for (const change of changed) {
            for (const automation of automations) {
                for (const trigger of automation.definition.triggers) {
                    if (!matchesChange(trigger, change)) continue;
                    const cause: auto.RunCause = {
                        kind: trigger.kind,
                        triggerId: trigger.id,
                        deviceId: change.deviceId,
                        attribute: change.attribute,
                        from: change.from,
                        to: change.to,
                        at: iso(change.at)
                    };
                    const key = `${trigger.kind}:${trigger.id}:${change.attribute}:${change.version}`;
                    await fire(automation, key, cause, depth);
                }
            }
        }
        await store.wakeWaiting(device.id, now);
        // Whatever was queued, and whatever was waiting on this device, is looked
        // at now rather than on the next tick.
        ports.wake?.(0);
        return changed;
    }

    function matchesChange(trigger: auto.Trigger, change: Transition): boolean {
        if (trigger.kind === "change") {
            if (trigger.deviceId !== change.deviceId || trigger.attribute !== change.attribute) return false;
            if (trigger.from && !same(trigger.from, change.from)) return false;
            if (trigger.to && !same(trigger.to, change.to)) return false;
            return true;
        }
        if (trigger.kind === "threshold") {
            if (trigger.deviceId !== change.deviceId || change.attribute !== "reading") return false;
            const before = numberOf(change.from);
            const after = numberOf(change.to);
            if (before === null || after === null) return false;
            return trigger.direction === "above"
                ? before <= trigger.value && after > trigger.value
                : before >= trigger.value && after < trigger.value;
        }
        return false;
    }

    /**
     * The triggers that are about the clock rather than a change: a time of day,
     * an interval, and a device that has been in one state for long enough. Each
     * names the occurrence it fires for, so a second pass over the same minute
     * finds its run already there.
     */
    async function evaluateSchedules(installedAppId: string): Promise<void> {
        const now = ports.now();
        const automations = await store.enabledAutomations(installedAppId);
        for (const automation of automations) {
            for (const trigger of automation.definition.triggers) {
                try {
                    await scheduled(automation, trigger, now);
                } catch (error) {
                    fault(`automation ${automation.id} could not check a trigger`, error);
                }
            }
        }
    }

    async function scheduled(automation: AutomationRecord, trigger: auto.Trigger, now: Date): Promise<void> {
        const armed = automation.armedAt.getTime();
        if (trigger.kind === "time") {
            const occurrence = lastOccurrence(trigger, automation.definition.timeZone, now);
            if (!occurrence) return;
            const late = now.getTime() - occurrence.getTime();
            if (late < 0 || late > CATCH_UP_MS || occurrence.getTime() < armed) return;
            await fire(
                automation,
                `time:${trigger.id}:${iso(occurrence)}`,
                { kind: "time", triggerId: trigger.id, at: iso(occurrence) },
                0
            );
            return;
        }
        if (trigger.kind === "interval") {
            const period = trigger.minutes * 60 * 1000;
            const slot = Math.floor((now.getTime() - armed) / period);
            if (slot < 1) return;
            const at = new Date(armed + slot * period);
            if (now.getTime() - at.getTime() > CATCH_UP_MS) return;
            await fire(
                automation,
                `interval:${trigger.id}:${trigger.minutes}:${slot}`,
                { kind: "interval", triggerId: trigger.id, minutes: trigger.minutes, at: iso(at) },
                0
            );
            return;
        }
        if (trigger.kind === "stays") {
            const seen = await store.observation(trigger.deviceId);
            if (!seen) return;
            const value = attributeOf(seen, trigger.attribute);
            if (!same(value, trigger.is)) return;
            const since =
                trigger.attribute === "door"
                    ? seen.doorSince
                    : trigger.attribute === "reading"
                      ? seen.readingSince
                      : seen.stateSince;
            // Measured from when it was switched on here, not from when the
            // device got there: a light already on for three hours when "off
            // after 30 minutes" is written goes off 30 minutes later, not now.
            const from = Math.max(since.getTime(), armed);
            if (now.getTime() - from < trigger.minutes * 60 * 1000) return;
            await fire(
                automation,
                `stays:${trigger.id}:${trigger.attribute}:${iso(since)}`,
                {
                    kind: "stays",
                    triggerId: trigger.id,
                    deviceId: trigger.deviceId,
                    attribute: trigger.attribute,
                    to: value,
                    minutes: trigger.minutes,
                    at: iso(now)
                },
                0
            );
        }
    }

    /** Somebody pressed Run now. */
    async function runNow(automation: AutomationRecord, byUser: string, key: string): Promise<boolean> {
        const now = ports.now();
        const queued = await fire(automation, `manual:${key}`, { kind: "manual", byUser, at: iso(now) }, 0);
        if (queued) ports.wake?.(0);
        return queued;
    }

    /**
     * Work through every run that is due, until none are.
     *
     * One drain at a time in a process; a second call while one is going asks it
     * to go round once more rather than starting beside it. Across processes the
     * claim on each run is what keeps two runners off the same steps.
     */
    function drain(): Promise<void> {
        if (draining) {
            again = true;
            return draining;
        }
        draining = (async () => {
            try {
                do {
                    again = false;
                    for (;;) {
                        const now = ports.now();
                        const due = await store.claimDueRuns(now, new Date(now.getTime() + LEASE_MS), 20);
                        if (due.length === 0) break;
                        for (const run of due) {
                            try {
                                await execute(run);
                            } catch (error) {
                                fault(`automation run ${run.id} failed`, error);
                                await finish(run, "failed", run.steps, "fault");
                            }
                        }
                    }
                } while (again);
            } finally {
                draining = null;
            }
        })();
        return draining;
    }

    async function finish(
        run: RunRecord,
        status: auto.RunStatus,
        steps: readonly auto.StepLog[],
        reason: string | null = null
    ): Promise<void> {
        const now = ports.now();
        await store.saveRun(run.id, {
            status,
            steps,
            reason,
            dueAt: null,
            waitUntil: null,
            waitDeviceId: null,
            lockedUntil: null,
            finishedAt: now
        });
        await store.markAutomation(run.automationId, now, status);
    }

    async function execute(run: RunRecord): Promise<void> {
        const automation = await store.automation(run.automationId);
        const steps: auto.StepLog[] = [...run.steps];
        if (!automation) return; // Removed with its runs; nothing to finish.
        if (!automation.enabled) {
            await finish(run, "stopped", steps, "disabled");
            return;
        }
        const definition = automation.definition;

        // A run starting for the first time checks its owner and its conditions.
        // One resuming after a delay has passed both already.
        if (run.status === "queued") {
            if (!(await ports.mayOperate(automation.ownerId, "run"))) {
                await finish(run, "refused", steps, "owner");
                return;
            }
            const held = await conditionsHold(automation, ports.now());
            if (!held) {
                await finish(run, "skipped", steps, "conditions");
                return;
            }
            await store.saveRun(run.id, { status: "running" });
        }

        let index = run.step;
        let waitUntil = run.waitUntil;
        while (index < definition.actions.length) {
            const step = definition.actions[index]!;
            const now = ports.now();
            const log = (outcome: auto.StepOutcome, extra: { code?: string; said?: string } = {}) =>
                steps.push({ stepId: step.id, kind: step.kind, outcome, ...extra, at: iso(ports.now()) });

            if (step.kind === "delay") {
                const due = new Date(now.getTime() + step.seconds * 1000);
                log("ok");
                await store.saveRun(run.id, {
                    status: "waiting",
                    step: index + 1,
                    steps,
                    dueAt: due,
                    lockedUntil: null
                });
                if (step.seconds * 1000 <= TIMER_MS) ports.wake?.(step.seconds * 1000);
                return;
            }

            if (step.kind === "wait") {
                const device = await ports.devices.read(automation.installedAppId, step.deviceId);
                if (!device) {
                    log("failed", { code: "deviceGone" });
                    await finish(run, "failed", steps, "step");
                    return;
                }
                if (device.online && same(attributeOf(device, step.attribute), step.is)) {
                    log("ok");
                    waitUntil = null;
                } else {
                    const deadline = waitUntil ?? new Date(now.getTime() + step.timeoutMinutes * 60 * 1000);
                    if (now.getTime() < deadline.getTime()) {
                        await store.saveRun(run.id, {
                            status: "waiting",
                            step: index,
                            steps,
                            waitUntil: deadline,
                            waitDeviceId: step.deviceId,
                            dueAt: new Date(Math.min(deadline.getTime(), now.getTime() + RECHECK_MS)),
                            lockedUntil: null
                        });
                        return;
                    }
                    log("timedOut");
                    waitUntil = null;
                    if (step.onTimeout === "stop") {
                        await finish(run, "stopped", steps, "timedOut");
                        return;
                    }
                }
            }

            if (step.kind === "device") {
                const outcome = await deviceStep(automation, run, step);
                if (outcome.outcome !== "ok") {
                    log(outcome.outcome, { code: outcome.code, said: outcome.said });
                    await finish(run, outcome.outcome === "refused" ? "refused" : "failed", steps, "step");
                    return;
                }
                log("ok");
            }

            if (step.kind === "notify") {
                try {
                    await ports.notify(automation, step.message, run.id);
                    log("ok");
                } catch (error) {
                    fault(`automation ${automation.id} could not notify`, error);
                    log("failed", { code: "notifyFailed" });
                    await finish(run, "failed", steps, "step");
                    return;
                }
            }

            if (step.kind === "run") {
                const target = await store.automation(step.automationId);
                if (!target || target.installedAppId !== automation.installedAppId) {
                    log("failed", { code: "automationGone" });
                    await finish(run, "failed", steps, "step");
                    return;
                }
                if (!target.enabled) {
                    log("skipped", { code: "automationOff" });
                } else if (run.depth + 1 > MAX_DEPTH) {
                    log("refused", { code: "loop" });
                    await finish(run, "refused", steps, "loop");
                    return;
                } else {
                    await fire(
                        target,
                        `chain:${run.id}:${step.id}`,
                        {
                            kind: "automation",
                            byAutomationId: automation.id,
                            byName: automation.name,
                            at: iso(now)
                        },
                        run.depth + 1
                    );
                    log("ok");
                    ports.wake?.(0);
                }
            }

            index += 1;
            // Saved after every step, so a restart resumes after the last one
            // that finished rather than doing it again.
            await store.saveRun(run.id, {
                step: index,
                steps,
                waitUntil: null,
                waitDeviceId: null,
                lockedUntil: new Date(ports.now().getTime() + LEASE_MS)
            });
        }
        await finish(run, "succeeded", steps);
    }

    async function deviceStep(
        automation: AutomationRecord,
        run: RunRecord,
        step: Extract<auto.Step, { kind: "device" }>
    ): Promise<{ outcome: auto.StepOutcome; code?: string; said?: string }> {
        // Asked again for every step, not once per run: a run that waited an
        // hour may have outlived its owner's right to open the door.
        if (!(await ports.mayOperate(automation.ownerId, "control"))) return { outcome: "refused", code: "owner" };
        let action: DeviceAction;
        if (step.do === auto.TOGGLE) {
            const device = await ports.devices.read(automation.installedAppId, step.deviceId);
            if (!device) return { outcome: "failed", code: "deviceGone" };
            if (device.state !== "on" && device.state !== "off") return { outcome: "failed", code: "toggleUnknown" };
            action = device.state === "on" ? "turn-off" : "turn-on";
        } else {
            action = step.do;
        }
        try {
            await causeContext.run({ depth: run.depth }, () =>
                ports.devices.act(automation.installedAppId, step.deviceId, action, {
                    ownerId: automation.ownerId,
                    automationId: automation.id,
                    automationName: automation.name
                })
            );
            return { outcome: "ok" };
        } catch (error) {
            if (error instanceof StepRefusal) return { outcome: "failed", said: error.message };
            fault(`automation ${automation.id} could not act on a device`, error);
            return { outcome: "failed", code: "failed" };
        }
    }

    async function conditionsHold(automation: AutomationRecord, now: Date): Promise<boolean> {
        const { conditions, timeZone } = automation.definition;
        if (conditions.groups.length === 0) return true;
        const results: boolean[] = [];
        for (const group of conditions.groups) {
            const items: boolean[] = [];
            for (const condition of group.items) {
                items.push(await conditionHolds(automation, condition, now, timeZone));
            }
            results.push(group.match === "all" ? items.every(Boolean) : items.some(Boolean));
        }
        return conditions.match === "all" ? results.every(Boolean) : results.some(Boolean);
    }

    async function conditionHolds(
        automation: AutomationRecord,
        condition: auto.Condition,
        now: Date,
        timeZone: string
    ): Promise<boolean> {
        if (condition.kind === "device") {
            const device = await ports.devices.read(automation.installedAppId, condition.deviceId);
            // A device that is gone or silent is not in any state, so "is" and
            // "is not" both fail rather than the second passing by default.
            if (!device || !device.online) return false;
            const matches = same(attributeOf(device, condition.attribute), condition.is);
            return condition.negate ? !matches : matches;
        }
        if (condition.kind === "reading") {
            const device = await ports.devices.read(automation.installedAppId, condition.deviceId);
            if (!device || !device.online) return false;
            const value = numberOf(device.reading);
            return value !== null && compare(value, condition.op, condition.value);
        }
        const clock = wallClock(now, timeZone);
        if (condition.kind === "weekday") {
            const day = new Date(Date.UTC(clock.year, clock.month - 1, clock.day)).getUTCDay();
            return condition.days.includes(day);
        }
        const minute = clock.hours * 60 + clock.minutes;
        const from = minutesOf(condition.from);
        const to = minutesOf(condition.to);
        // 22:00 to 07:00 is the night, across midnight.
        return from < to ? minute >= from && minute < to : minute >= from || minute < to;
    }

    return { observe, evaluateSchedules, runNow, drain, fire, conditionsHold };
}

export type AutomationEngine = ReturnType<typeof createEngine>;

/**
 * The most recent moment a time-of-day trigger was due, at or before now, on
 * one of its days - looking back as far as yesterday so a tick just after
 * midnight still finds 23:59.
 */
export function lastOccurrence(
    trigger: Extract<auto.Trigger, { kind: "time" }>,
    timeZone: string,
    now: Date
): Date | null {
    const [hours, minutes] = trigger.at.split(":").map(Number);
    const today = wallClock(now, timeZone);
    const cursor = new Date(Date.UTC(today.year, today.month - 1, today.day));
    for (let back = 0; back < 2; back += 1) {
        const day = cursor.getUTCDay();
        if (trigger.days.includes(day)) {
            const at = zonedInstant(
                {
                    year: cursor.getUTCFullYear(),
                    month: cursor.getUTCMonth() + 1,
                    day: cursor.getUTCDate(),
                    hours: hours ?? 0,
                    minutes: minutes ?? 0
                },
                timeZone
            );
            if (at.getTime() <= now.getTime()) return at;
        }
        cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return null;
}
