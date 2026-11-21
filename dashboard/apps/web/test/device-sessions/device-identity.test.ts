/**
 * The device id a client claims: how it is derived and read, how rows group by
 * it, and the per-account key it becomes.
 */

import { describe, expect, it } from "vitest";
import { readDeviceId, readDeviceName } from "@polaris/core";
import { groupByDevice } from "@/lib/device-sessions/device-groups";
import {
    deviceIdFrom,
    parseMacPlatformUuid,
    parseMachineIdFile,
    parseWindowsMachineGuid
} from "../../../../packages/core/src/device-identity-node";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("machine id readers", () => {
    it("reads Windows, macOS and machine-id output", () => {
        expect(
            parseWindowsMachineGuid(
                "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    3f2504e0-4f89-11d3-9a0c-0305e82c3301\r\n"
            )
        ).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
        expect(
            parseMacPlatformUuid('    "IOPlatformUUID" = "564D1A2B-0000-1111-2222-333344445555"')
        ).toBe("564D1A2B-0000-1111-2222-333344445555");
        expect(parseMachineIdFile("4c4c4544004d3510804bc4c04f4a4d32\n")).toBe(
            "4c4c4544004d3510804bc4c04f4a4d32"
        );
        expect(parseWindowsMachineGuid("ERROR: access denied")).toBeNull();
        expect(parseMachineIdFile("")).toBeNull();
    });

    it("hashes the id the same way whatever its case, and never sends it as-is", () => {
        const id = deviceIdFrom("3F2504E0-4F89-11D3-9A0C-0305E82C3301");
        expect(id).toBe(deviceIdFrom(" 3f2504e0-4f89-11d3-9a0c-0305e82c3301 "));
        expect(readDeviceId(id)).toBe(id);
        expect(id).not.toContain("3f2504e0");
    });
});

describe("readDeviceId / readDeviceName", () => {
    it("accepts only a SHA-256 shaped claim", () => {
        expect(readDeviceId(KEY_A.toUpperCase())).toBe(KEY_A);
        expect(readDeviceId("abc")).toBeNull();
        expect(readDeviceId(`${KEY_A}0`)).toBeNull();
        expect(readDeviceId(null)).toBeNull();
    });

    it("decodes, strips control characters and caps the name", () => {
        expect(readDeviceName("DRAGON%0A%20PC", true)).toBe("DRAGON PC");
        expect(readDeviceName("%E0%A4%A", true)).toBeNull();
        expect(readDeviceName("x".repeat(200))?.length).toBe(80);
        expect(readDeviceName("   ")).toBeNull();
    });
});

describe("groupByDevice", () => {
    it("groups only rows that share a reported key, never by name", () => {
        const groups = groupByDevice([
            {
                id: "desktop",
                deviceKey: KEY_A,
                name: "DRAGON",
                os: "Windows",
                lastSeenAt: "2026-11-21T10:00:00.000Z",
                current: true
            },
            { id: "cli", deviceKey: KEY_A, name: "DRAGON", os: "Windows", lastSeenAt: "2026-11-21T11:00:00.000Z" },
            // Same name, no key: an old client or a browser. Left on its own.
            { id: "brave", deviceKey: null, name: "DRAGON", os: "Windows", lastSeenAt: "2026-11-21T12:00:00.000Z" },
            { id: "laptop", deviceKey: KEY_B, name: null, os: "Unknown OS", lastSeenAt: null }
        ]);
        expect(groups).toHaveLength(2);
        expect(groups[0]).toMatchObject({
            key: KEY_A,
            name: "DRAGON",
            os: "Windows",
            here: true,
            lastSeenAt: "2026-11-21T11:00:00.000Z",
            memberIds: ["desktop", "cli"]
        });
        expect(groups[1]).toMatchObject({ key: KEY_B, name: null, os: null, here: false });
        expect(groups.flatMap((group) => group.memberIds)).not.toContain("brave");
    });

    it("leaves every row of an account with no reporting client ungrouped", () => {
        expect(
            groupByDevice([{ id: "s", deviceKey: null, name: null, os: "Windows", lastSeenAt: null }])
        ).toEqual([]);
    });
});
