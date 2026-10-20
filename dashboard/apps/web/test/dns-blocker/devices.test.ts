import { describe, expect, it } from "vitest";
import { networkDevices } from "@/lib/dns-blocker/devices";
import type { SeenDevice } from "@/lib/dns-blocker/query-log";

function seen(address: string, name = ""): SeenDevice {
    return { address, name, queries: 1, blocked: 0, first: 1, last: 2 };
}

const groups = [
    { name: "Kids", clients: ["kids-*"], categories: [], services: [] },
    { name: "Upstairs", clients: ["192.168.1.64/26"], categories: [], services: [] },
    { name: "TV", clients: ["192.168.1.30"], categories: [], services: [] }
];

describe("network devices", () => {
    it("puts a device in every group an address, range or name matches", () => {
        const devices = networkDevices(
            [seen("192.168.1.70", "Kids-Tablet"), seen("192.168.1.30"), seen("10.0.0.5")],
            { devices: [{ name: "living-tv", address: "192.168.1.30" }], clientGroups: groups }
        );
        expect(devices.map((device) => [device.ownName, device.groups])).toEqual([
            ["", ["Kids", "Upstairs"]],
            ["living-tv", ["TV"]],
            ["", []]
        ]);
    });

    it("matches a group by a name given here, and never a pattern as a regex", () => {
        const [device] = networkDevices([seen("10.0.0.9")], {
            devices: [{ name: "kids-laptop", address: "10.0.0.9" }],
            clientGroups: [
                ...groups,
                { name: "Dots", clients: ["a.b"], categories: [], services: [] }
            ]
        });
        expect(device?.groups).toEqual(["Kids"]);
        expect(
            networkDevices([seen("10.0.0.8", "axb")], {
                devices: [],
                clientGroups: [{ name: "Dots", clients: ["a.b"], categories: [], services: [] }]
            })[0]?.groups
        ).toEqual([]);
    });
});
