/**
 * Grouping the rows of Account > Sessions under the computer they run on: by a
 * device key, by a reported computer name on the same system, and by the
 * extension's approving browser - never by an address.
 */

import { describe, expect, it } from "vitest";
import {
    DEVICE_GROUP_KEY_PATTERN,
    deviceMembers,
    groupByDevice,
    type DeviceRowLists
} from "@/lib/device-sessions/device-groups";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

function session(id: string, extra: Partial<DeviceRowLists["sessions"][number]> = {}) {
    return {
        id,
        deviceKey: null,
        deviceName: null,
        os: "Windows 11",
        browser: "Brave 158",
        lastSeenAt: "2026-11-22T10:00:00.000Z",
        current: false,
        ...extra
    };
}

function app(id: string, extra: Partial<NonNullable<DeviceRowLists["deviceSessions"]>[number]> = {}) {
    return {
        id,
        deviceKey: null,
        hostname: null,
        os: "Windows",
        lastUsedAt: null,
        createdAt: "2026-11-01T10:00:00.000Z",
        ...extra
    };
}

function extension(id: string, extra: Partial<NonNullable<DeviceRowLists["extensions"]>[number]> = {}) {
    return {
        id,
        os: "Windows",
        browser: "Brave",
        lastSeenAt: "2026-11-22T11:00:00.000Z",
        approvedBySessionId: null,
        ...extra
    };
}

describe("groupByDevice", () => {
    it("puts the desktop app, an old terminal and an old deck on one computer by its name", () => {
        const groups = groupByDevice(
            deviceMembers({
                sessions: [session("desktop", { deviceKey: KEY, deviceName: "DRAGON", browser: "Polaris" })],
                deviceSessions: [
                    app("cli", { hostname: "DRAGON", lastUsedAt: "2026-11-08T10:00:00.000Z" }),
                    app("deck", { hostname: "dragon", os: "Windows 10" })
                ]
            })
        );
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({
            key: KEY,
            name: "DRAGON",
            memberIds: ["desktop", "cli", "deck"],
            deviceKeys: [KEY],
            lastSeenAt: "2026-11-22T10:00:00.000Z"
        });
    });

    it("joins rows that share a device key whatever they are named", () => {
        const groups = groupByDevice(
            deviceMembers({
                sessions: [session("desktop", { deviceKey: KEY, deviceName: "DRAGON" })],
                deviceSessions: [app("cli", { deviceKey: KEY, hostname: "renamed" })]
            })
        );
        expect(groups.map((group) => group.memberIds)).toEqual([["desktop", "cli"]]);
    });

    it("places the extension beside the browser that approved it, and that browser on the machine", () => {
        const groups = groupByDevice(
            deviceMembers({
                sessions: [session("brave", { current: true })],
                extensions: [extension("ext", { approvedBySessionId: "brave" })]
            })
        );
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({
            key: "row:brave",
            name: null,
            here: true,
            memberIds: ["brave", "ext"],
            deviceKeys: [],
            lastSeenAt: "2026-11-22T11:00:00.000Z"
        });
        expect(DEVICE_GROUP_KEY_PATTERN.test(groups[0]!.key)).toBe(true);
    });

    it("does not follow an approval made from another system or browser", () => {
        const fromPhone = groupByDevice(
            deviceMembers({
                sessions: [session("phone", { os: "Android 15", browser: "Chrome 140" })],
                extensions: [extension("ext", { approvedBySessionId: "phone" })]
            })
        );
        expect(fromPhone).toEqual([]);
        const otherBrowser = groupByDevice(
            deviceMembers({
                sessions: [session("edge", { browser: "Edge 140" })],
                extensions: [extension("ext", { approvedBySessionId: "edge" })]
            })
        );
        expect(otherBrowser).toEqual([]);
    });

    it("keeps two computers behind one address apart", () => {
        // The member shape has no address at all: two browsers on the same system
        // and the same network, with nothing else in common, stay on their own.
        const groups = groupByDevice(
            deviceMembers({
                sessions: [session("mine"), session("theirs")],
                deviceSessions: [app("cli-a", { hostname: "DRAGON" }), app("cli-b", { hostname: "WILLOW" })]
            })
        );
        expect(groups).toEqual([]);
    });

    it("keeps the same name on different systems apart", () => {
        const groups = groupByDevice(
            deviceMembers({
                sessions: [],
                deviceSessions: [
                    app("win", { hostname: "studio", os: "Windows" }),
                    app("mac", { hostname: "studio", os: "macOS 15" })
                ]
            })
        );
        expect(groups).toEqual([]);
    });

    it("does not join on an unknown system", () => {
        const groups = groupByDevice(
            deviceMembers({
                sessions: [],
                deviceSessions: [
                    app("a", { hostname: "DRAGON", os: "Unknown OS" }),
                    app("b", { hostname: "DRAGON", os: "Unknown OS" })
                ]
            })
        );
        expect(groups).toEqual([]);
    });

    it("lists a lone keyed row as its device, as before, and leaves a lone unkeyed one alone", () => {
        const groups = groupByDevice(
            deviceMembers({
                sessions: [session("desktop", { deviceKey: KEY, deviceName: "DRAGON" })],
                deviceSessions: [app("cli", { hostname: "LAPTOP" })]
            })
        );
        expect(groups.map((group) => group.memberIds)).toEqual([["desktop"]]);
    });

    it("carries every key of a machine whose id changed, and says where the reader is", () => {
        const groups = groupByDevice(
            deviceMembers({
                sessions: [
                    session("desktop", { deviceKey: KEY, deviceName: "DRAGON", current: true }),
                    session("desktop-old", { deviceKey: OTHER_KEY, deviceName: "DRAGON" })
                ]
            })
        );
        expect(groups).toHaveLength(1);
        expect(groups[0]!.deviceKeys).toEqual([KEY, OTHER_KEY]);
        expect(groups[0]!.here).toBe(true);
    });

    it("orders devices by their newest activity", () => {
        const groups = groupByDevice(
            deviceMembers({
                sessions: [
                    session("old", { deviceKey: OTHER_KEY, lastSeenAt: "2026-11-01T00:00:00.000Z" }),
                    session("new", { deviceKey: KEY, lastSeenAt: "2026-11-20T00:00:00.000Z" })
                ]
            })
        );
        expect(groups.map((group) => group.key)).toEqual([KEY, OTHER_KEY]);
    });
});
describe("an extension paired with Polaris Desktop", () => {
    const lists: DeviceRowLists = {
        sessions: [
            {
                id: "desktop",
                deviceKey: KEY,
                deviceName: "DRAGON",
                os: "Windows 11",
                browser: "Polaris Desktop",
                lastSeenAt: "2026-11-23T10:00:00Z",
                current: false
            },
            {
                id: "brave",
                deviceKey: null,
                deviceName: null,
                os: "Windows 11",
                browser: "Brave",
                lastSeenAt: "2026-11-23T10:01:00Z",
                current: true
            }
        ],
        extensions: [
            {
                id: "ext",
                os: "Windows",
                browser: "Brave",
                lastSeenAt: "2026-11-23T10:00:30Z",
                approvedBySessionId: "brave",
                deviceKey: KEY
            }
        ]
    };

    it("joins the desktop's device, and the browser that let it in comes along", () => {
        const groups = groupByDevice(deviceMembers(lists));
        expect(groups).toHaveLength(1);
        expect(groups[0]!.key).toBe(KEY);
        expect(groups[0]!.name).toBe("DRAGON");
        expect(groups[0]!.here).toBe(true);
        expect([...groups[0]!.memberIds].sort()).toEqual(["brave", "desktop", "ext"]);
    });

    it("stays apart from the desktop while it is not paired", () => {
        const unpaired = { ...lists, extensions: lists.extensions!.map((row) => ({ ...row, deviceKey: null })) };
        const desktop = groupByDevice(deviceMembers(unpaired)).find((group) => group.memberIds.includes("desktop"))!;
        expect(desktop.memberIds).not.toContain("ext");
        expect(desktop.memberIds).not.toContain("brave");
    });
});
