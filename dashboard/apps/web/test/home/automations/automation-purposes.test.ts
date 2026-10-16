/**
 * Blocks named for what they are for: each is an ordinary change trigger or
 * device condition on the device it is pointed at, offered only where that
 * device can answer it, and saved as the schema already takes it.
 */

import { describe, expect, it } from "vitest";
import * as auto from "@polaris-app/places/src/lib/automation-kinds";
import * as purposes from "@polaris-app/places/src/lib/automation-purposes";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";

function device(id: string, kind: string, extra: Partial<DeviceView> = {}): DeviceView {
    return {
        id,
        vendor: "fixture",
        kind,
        name: `Fixture ${id}`,
        zone: "",
        placeId: "place-1",
        model: "",
        firmware: "",
        state: "off",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: null,
        ...extra
    };
}

const lock = device("lock", "lock", { state: "locked", doorState: "closed" });
const bareLock = device("bare", "lock", { state: "locked" });
const doorSensor = device("contact", "sensor", { reading: { value: "Closed", unit: "" } });
const motion = device("hall", "sensor", { reading: { value: "Still", unit: "" } });
const thermometer = device("temp", "sensor", { reading: { value: "21", unit: "C" } });
const plug = device("plug", "outlet");

describe("purpose blocks", () => {
    it("are a change on a lock's door sensor, or on a door sensor's reading", () => {
        expect(purposes.purposeTrigger("opened", lock)).toMatchObject({
            kind: "change",
            deviceId: "lock",
            attribute: "door",
            from: "",
            to: "open"
        });
        expect(purposes.purposeTrigger("closed", doorSensor)).toMatchObject({
            attribute: "reading",
            to: "Closed"
        });
    });

    it("are offered only where the device can answer them", () => {
        expect(purposes.triggerFits("opened", bareLock)).toBe(false);
        expect(purposes.triggerFits("locked", bareLock)).toBe(true);
        expect(purposes.triggerFits("motion", motion)).toBe(true);
        expect(purposes.triggerFits("motion", thermometer)).toBe(false);
        expect(purposes.conditionFits("isLocked", plug)).toBe(false);
        expect(purposes.purposeCondition("moving", doorSensor)).toBeNull();
    });

    it("make conditions that pass the schema as they are", () => {
        const condition = purposes.purposeCondition("isUnlocked", lock)!;
        expect(condition).toMatchObject({ kind: "device", attribute: "state", is: "unlocked" });
        const trigger = purposes.purposeTrigger("motion", motion)!;
        const parsed = auto.automationInputSchema.safeParse({
            placeId: "place-1",
            name: "Hall light",
            enabled: true,
            definition: {
                timeZone: "UTC",
                triggers: [trigger],
                conditions: {
                    match: "all",
                    groups: [{ id: "group1", match: "all", items: [condition] }]
                },
                actions: [{ id: "stepnote", kind: "notify", message: "seen" }]
            }
        });
        expect(parsed.success).toBe(true);
    });

    it("watch a battery only where a device reports one, and silence on any device", () => {
        const lowLock = device("low", "lock", { batteryPercent: 12 });
        const fineLock = device("fine", "lock", { batteryPercent: 80 });
        const critical = device("crit", "sensor", { batteryCritical: true });
        expect(purposes.triggerFits("batteryLow", plug)).toBe(false);
        expect(purposes.triggerFits("batteryLow", fineLock)).toBe(true);
        expect(purposes.conditionFits("batteryIsLow", critical)).toBe(true);
        expect(purposes.purposeTrigger("batteryLow", lowLock)).toMatchObject({
            kind: "change",
            attribute: "battery",
            from: "",
            to: "low"
        });
        expect(purposes.triggerFits("unavailable", plug)).toBe(true);
        expect(purposes.purposeCondition("isUnavailable", thermometer)).toMatchObject({
            kind: "device",
            attribute: "online",
            is: "offline",
            negate: false
        });
        const parsed = auto.automationInputSchema.safeParse({
            placeId: "place-1",
            name: "Battery",
            enabled: true,
            definition: {
                timeZone: "UTC",
                triggers: [purposes.purposeTrigger("batteryLow", lowLock)],
                conditions: {
                    match: "all",
                    groups: [
                        {
                            id: "group1",
                            match: "all",
                            items: [purposes.purposeCondition("isUnavailable", plug)]
                        }
                    ]
                },
                actions: [{ id: "stepnote", kind: "notify", message: "seen" }]
            }
        });
        expect(parsed.success).toBe(true);
    });

    it("read a battery at or under the line as low, and none as none", () => {
        expect(auto.batteryWord({ batteryPercent: auto.BATTERY_LOW_PERCENT })).toBe("low");
        expect(auto.batteryWord({ batteryPercent: auto.BATTERY_LOW_PERCENT + 1 })).toBe("ok");
        expect(auto.batteryWord({ batteryPercent: null, batteryCritical: false })).toBe("");
        expect(auto.attributesFor("outlet", { batteryPercent: null })).toEqual(["state", "online"]);
        expect(auto.attributesFor("outlet")).toContain("battery");
    });
});

describe("a block's set of devices", () => {
    it("is its device alone when it has no set, as every stored block is read", () => {
        expect(auto.deviceTargets({ deviceId: "lamp1" })).toEqual(["lamp1"]);
    });

    it("keeps its first as its device, once each, and drops the set at one", () => {
        const trigger = auto.withTargets(
            { id: "t1", kind: "change", deviceId: "", attribute: "state", from: "", to: "on" },
            ["lamp2", "lamp1", "lamp2"]
        );
        expect(trigger.deviceId).toBe("lamp2");
        expect(auto.deviceTargets(trigger)).toEqual(["lamp2", "lamp1"]);
        expect("targets" in auto.withTargets(trigger, ["lamp1"])).toBe(false);
    });

    it("names a device gone from the set where it is", () => {
        const issues = auto.deviceIssues(
            {
                timeZone: "UTC",
                triggers: [
                    {
                        id: "trigset",
                        kind: "change",
                        deviceId: "plug",
                        targets: [
                            { kind: "device", id: "plug" },
                            { kind: "device", id: "gone" }
                        ],
                        attribute: "state",
                        from: "",
                        to: "on"
                    }
                ],
                conditions: { match: "all", groups: [] },
                actions: []
            },
            [plug],
            { automationIds: [], selfId: null }
        );
        expect(issues).toEqual([
            {
                path: ["definition", "triggers", 0, "targets", 1, "id"],
                message: "automations.errors.deviceGone"
            }
        ]);
    });
});

describe("a stored block read back as its purpose", () => {
    it("names the purpose each one was made from", () => {
        for (const id of purposes.TRIGGER_PURPOSES) {
            const on = [lock, doorSensor, motion, plug].find((each) =>
                purposes.triggerFits(id, { ...each, batteryPercent: 50 })
            )!;
            const made = purposes.purposeTrigger(id, { ...on, batteryPercent: 50 })!;
            expect(purposes.triggerPurposeOf(made)).toBe(id);
        }
        for (const id of purposes.CONDITION_PURPOSES) {
            const on = [lock, doorSensor, motion, plug].find((each) =>
                purposes.conditionFits(id, { ...each, batteryPercent: 50 })
            )!;
            const made = purposes.purposeCondition(id, { ...on, batteryPercent: 50 })!;
            expect(purposes.conditionPurposeOf(made)).toBe(id);
        }
    });

    it("is none for a block that is no purpose's, or one turned around", () => {
        const reading: auto.Trigger = {
            id: "trig01",
            kind: "change",
            deviceId: "temp",
            attribute: "reading",
            from: "",
            to: "21"
        };
        expect(purposes.triggerPurposeOf(reading)).toBeNull();
        expect(purposes.triggerPurposeOf({ ...reading, to: "" })).toBeNull();
        const locked = purposes.purposeCondition("isLocked", lock)!;
        expect(
            purposes.conditionPurposeOf({ ...locked, negate: true } as auto.Condition)
        ).toBeNull();
    });
});
