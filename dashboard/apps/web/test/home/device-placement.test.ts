/**
 * A device that has not been put anywhere is still on the screen.
 *
 * An account is asked what it holds, not where any of it is, so every device
 * arrives with no place. The list was filtered to one place, which meant those
 * were filtered out of all of them - and the empty state that came up told the
 * reader to open one and say where it was, with nothing on it to open. Somebody
 * whose locks were visibly working in the maker's own app saw a screen saying
 * their account had none.
 *
 * So this is about the where clause and nothing else: an unplaced device belongs
 * to every place's list until somebody says which one it is at.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface DeviceRow {
    id: string;
    placeId: string | null;
    name: string;
}

const ROWS: DeviceRow[] = [
    { id: "a", placeId: "place-1", name: "Front door" },
    { id: "b", placeId: null, name: "Warehouse side door" },
    { id: "c", placeId: "place-2", name: "Other building" }
];

let deviceQuery: Record<string, unknown> | null = null;
let eventQuery: Record<string, unknown> | null = null;

/** What the recorded `where` would actually match, applied to the rows above.
 *  Only the two shapes this file produces: a plain `placeId`, or the `OR` of a
 *  place and the unplaced. */
function matching(where: Record<string, unknown>): DeviceRow[] {
    const clause = where as { placeId?: string | null; OR?: { placeId: string | null }[] };
    return ROWS.filter((row) => {
        if (clause.OR) return clause.OR.some((option) => option.placeId === row.placeId);
        if ("placeId" in clause) return row.placeId === clause.placeId;
        return true;
    });
}

vi.mock("@polaris/db", () => ({
    prisma: {
        placeDevice: {
            findMany: async (args: Record<string, unknown>) => {
                deviceQuery = args.where as Record<string, unknown>;
                return matching(deviceQuery).map((row) => ({
                    ...row,
                    vendor: "nuki",
                    kind: "lock",
                    zone: null,
                    model: null,
                    firmware: null,
                    state: "locked",
                    doorState: "none",
                    batteryPercent: null,
                    batteryCritical: false,
                    online: true,
                    controllable: true,
                    stateAt: null
                }));
            }
        },
        placeDeviceEvent: {
            findMany: async (args: Record<string, unknown>) => {
                eventQuery = (args.where as { device: Record<string, unknown> }).device;
                return [];
            }
        }
    }
}));

const { listDeviceEvents, listDevices } = await import("@/lib/home/devices");

describe("the devices of a place", () => {
    beforeEach(() => {
        deviceQuery = null;
        eventQuery = null;
    });

    it("lists the ones at this place and the ones not placed yet", async () => {
        const found = await listDevices("install-1", "place-1");
        expect(found.map((device) => device.id)).toEqual(["a", "b"]);
    });

    it("says which are not placed, so the row can offer to place them", async () => {
        const found = await listDevices("install-1", "place-1");
        expect(found.find((device) => device.id === "b")?.placeId).toBeNull();
    });

    it("leaves out the ones that are somewhere else", async () => {
        const found = await listDevices("install-1", "place-1");
        expect(found.some((device) => device.id === "c")).toBe(false);
    });

    it("asks for everything when no place is named", async () => {
        const found = await listDevices("install-1", null);
        expect(found).toHaveLength(ROWS.length);
        expect(deviceQuery).toEqual({ installedAppId: "install-1" });
    });

    it("reads the history of the unplaced ones too", async () => {
        await listDeviceEvents("install-1", { placeId: "place-1" });
        expect(eventQuery).toEqual({
            installedAppId: "install-1",
            OR: [{ placeId: "place-1" }, { placeId: null }]
        });
    });
});
