import { describe, expect, it } from "vitest";
import { prefilledDefinition } from "../../../places/src/lib/automation-prefill";
import {
    automationHref,
    filterEntries,
    listEntries,
    networksFor,
    type HardwareView
} from "../../../places/src/lib/device-list";

const t = ((key: string) => key) as never;
const device = (id: string, name: string, accountId: string | null = "a1") =>
    ({ id, name, kind: "lock", model: "", zone: "", roomId: null, accountId }) as never;
const ups: HardwareView = {
    id: "u1",
    kind: "ups",
    name: "Rack UPS",
    model: null,
    roomId: null,
    href: "/places/ups/u1",
    canArrange: false
};

describe("device list", () => {
    it("merges devices and hardware with unique keys", () => {
        const entries = listEntries([device("x", "Front door")], [ups, { ...ups, kind: "camera", id: "x" }]);
        expect(entries.map((entry) => entry.key)).toEqual(["device:x", "ups:u1", "camera:x"]);
    });

    it("filters by heading and by an accent-free search", () => {
        const entries = listEntries([device("d", "Puerta Jardín")], [ups]);
        expect(filterEntries(entries, { groups: new Set(), query: "jardin" }, t)).toHaveLength(1);
        expect(
            filterEntries(entries, { groups: new Set(["devicesView.kinds.ups"]), query: "" }, t)
        ).toHaveLength(1);
    });

    it("maps an account's address to its device and flags a shared one", () => {
        const network = { id: "n", accountId: "a1", label: "Gree", details: { address: "10.0.0.2", mac: null } };
        expect(networksFor(device("d", "AC"), [network], [device("d", "AC")])).toEqual({ networks: [network], shared: false });
        expect(networksFor(device("d", "AC"), [network], [device("d", "AC"), device("e", "AC2")]).shared).toBe(true);
        expect(networksFor(device("d", "AC", null), [network], []).networks).toEqual([]);
    });

    it("links automations only for what an automation can reach", () => {
        const [lock, box] = listEntries([device("d", "Door")], [ups]);
        expect(automationHref(lock!, "p")).toBe("/places/devices/automations/new?device=d&place=p");
        expect(automationHref(box!, "p")).toBeNull();
    });
});

describe("automation prefill", () => {
    it("starts a device as its trigger and a camera as a privacy step", () => {
        expect(prefilledDefinition({ deviceId: "d" }, "UTC").triggers[0]).toMatchObject({ kind: "change", deviceId: "d" });
        expect(prefilledDefinition({ cameraId: "c" }, "UTC").actions[0]).toMatchObject({ kind: "privacy", target: "camera:c" });
        expect(prefilledDefinition({}, "UTC").triggers).toEqual([]);
    });
});
