/**
 * An automation is somebody waiting: the account holding a device an enabled
 * automation reads is read at the watched pace even with no screen open, and
 * every account is while an automation can wait on any device.
 */

import { describe, expect, it } from "vitest";
import {
    CLOUD_POLL_MS,
    UNWATCHED_FACTOR,
    dueAccounts
} from "@polaris-app/places/src/lib/device-watch";
import { devicesReadBy } from "@polaris-app/places/src/lib/automation-kinds";
import type { AutomationDefinition } from "@polaris-app/places/src/lib/automation-kinds";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

// Read 40 s ago: due at the watched pace (30 s), not at the unwatched one (60 s).
const LIST = [
    { id: "door", connection: "nuki-web", lastSyncedAt: ago(40_000) },
    { id: "other", connection: "tuya-cloud", lastSyncedAt: ago(40_000) }
];

describe("pacing for automations", () => {
    it("reads only the account an automation reads at the watched pace", () => {
        const plan = dueAccounts(LIST, new Map(), NOW, {
            watched: false,
            eager: new Set(["door"])
        });
        expect(plan.due).toEqual(["door"]);
        expect(plan.nextInMs).toBe(CLOUD_POLL_MS * UNWATCHED_FACTOR - 40_000);
    });

    it("reads every account at the watched pace while any device may be waited on", () => {
        const plan = dueAccounts(LIST, new Map(), NOW, { watched: false, eager: "all" });
        expect(plan.due).toEqual(["door", "other"]);
    });

    it("keeps the unwatched pace when nothing is waiting", () => {
        const plan = dueAccounts(LIST, new Map(), NOW, { watched: false, eager: new Set() });
        expect(plan.due).toEqual([]);
    });
});

describe("which devices an automation reads", () => {
    const base = {
        conditions: { mode: "all", groups: [] },
        actions: []
    } as unknown as AutomationDefinition;

    it("names the devices of its triggers and conditions", () => {
        const definition = {
            ...base,
            triggers: [
                { id: "t", kind: "device-changed", deviceId: "d1" },
                { id: "s", kind: "time" }
            ],
            conditions: { mode: "all", groups: [{ id: "g", items: [{ id: "c", deviceId: "d2" }] }] }
        } as unknown as AutomationDefinition;
        expect(devicesReadBy(definition).toString()).toBe(["d1", "d2"].toString());
    });

    it("is every device when a step waits", () => {
        const definition = {
            ...base,
            triggers: [],
            actions: [{ id: "w", kind: "wait" }]
        } as unknown as AutomationDefinition;
        expect(devicesReadBy(definition)).toBe("all");
    });
});
