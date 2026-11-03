/**
 * What a block can be about besides the devices it names: every device of a kind
 * in a room, on a floor, with a label or anywhere at the place, any mix of them,
 * less what it leaves out - read again on every run.
 */

import { describe, expect, it } from "vitest";
import { placesCatalogs } from "@polaris-app/places/messages";
import * as auto from "@polaris-app/places/src/lib/automation-kinds";
import { describeStep, lookupOf } from "@polaris-app/places/src/lib/automation-words";

const ROOMS = [
    { id: "kitchen", floorId: "ground" },
    { id: "living", floorId: "ground" },
    { id: "bedroom", floorId: "upstairs" }
];

const DEVICES = [
    { id: "ceiling", kind: "light", controllable: true, roomId: "kitchen", labelIds: ["top"] },
    { id: "counter", kind: "light", controllable: true, roomId: "kitchen", labelIds: [] },
    { id: "kettle", kind: "outlet", controllable: true, roomId: "kitchen" },
    { id: "sofa", kind: "light", controllable: true, roomId: "living", labelIds: ["night"] },
    { id: "reading", kind: "light", controllable: true, roomId: "bedroom", labelIds: ["night"] },
    { id: "door", kind: "lock", controllable: true, roomId: "living" },
    { id: "hall", kind: "light", controllable: true, roomId: null, labelIds: ["top"] },
    { id: "watched", kind: "light", controllable: false, roomId: "kitchen" }
];

const SCOPE: auto.TargetScope = { devices: DEVICES, rooms: ROOMS };

type Ref = { kind: auto.TargetKind; id: string };
type Left = { kind: auto.ExcludeKind; id: string };

function step(targets: Ref[], extra: { only?: string[]; exclude?: Left[] } = {}) {
    return {
        id: "stepon",
        kind: "device" as const,
        deviceId: "",
        do: "turn-on" as const,
        targets,
        ...extra
    };
}

const resolve = (block: auto.TargetBlock, scope = SCOPE) => auto.resolvedTargets(block, scope);

describe("a block's areas", () => {
    it("reads every device of a kind in a room", () => {
        expect(resolve(step([{ kind: "room", id: "kitchen" }], { only: ["light"] }))).toEqual([
            "ceiling",
            "counter"
        ]);
    });

    it("leaves out a device that cannot be told what the step does", () => {
        expect(resolve(step([{ kind: "room", id: "kitchen" }]))).toEqual([
            "ceiling",
            "counter",
            "kettle"
        ]);
    });

    it("reads a floor, a label and the whole place", () => {
        expect(resolve(step([{ kind: "floor", id: "ground" }], { only: ["light"] }))).toEqual([
            "ceiling",
            "counter",
            "sofa"
        ]);
        expect(resolve(step([{ kind: "label", id: "top" }]))).toEqual(["ceiling", "hall"]);
        expect(
            resolve(step([{ kind: "place", id: auto.PLACE_TARGET }], { only: ["light"] }))
        ).toEqual(["ceiling", "counter", "sofa", "reading", "hall"]);
    });

    it("reads any mix of them, each device once", () => {
        expect(
            resolve(
                step([
                    { kind: "room", id: "kitchen" },
                    { kind: "label", id: "night" },
                    { kind: "label", id: "top" },
                    { kind: "device", id: "door" }
                ])
            )
        ).toEqual(["door", "ceiling", "counter", "kettle", "sofa", "reading", "hall"]);
    });

    it("leaves out a device, a room, a floor or a label", () => {
        const all = [{ kind: "place" as const, id: auto.PLACE_TARGET }];
        const lights = { only: ["light"] };
        expect(
            resolve(step(all, { ...lights, exclude: [{ kind: "device", id: "hall" }] }))
        ).toEqual(["ceiling", "counter", "sofa", "reading"]);
        expect(
            resolve(step(all, { ...lights, exclude: [{ kind: "room", id: "kitchen" }] }))
        ).toEqual(["sofa", "reading", "hall"]);
        expect(
            resolve(step(all, { ...lights, exclude: [{ kind: "floor", id: "ground" }] }))
        ).toEqual(["reading", "hall"]);
        expect(
            resolve(step(all, { ...lights, exclude: [{ kind: "label", id: "night" }] }))
        ).toEqual(["ceiling", "counter", "hall"]);
    });

    it("counts what it leaves out, for the editor's line", () => {
        expect(
            auto.targetBreakdown(
                step([{ kind: "room", id: "kitchen" }], {
                    only: ["light"],
                    exclude: [{ kind: "label", id: "top" }]
                }),
                SCOPE
            )
        ).toEqual({ ids: ["counter"], excluded: ["ceiling"] });
    });

    it("counts a light added to the room later, on the next read", () => {
        const block = step([{ kind: "room", id: "bedroom" }], { only: ["light"] });
        expect(resolve(block)).toEqual(["reading"]);
        const later = {
            ...SCOPE,
            devices: [
                ...DEVICES,
                { id: "new", kind: "light", controllable: true, roomId: "bedroom" }
            ]
        };
        expect(resolve(block, later)).toEqual(["reading", "new"]);
    });

    it("is run as the devices it reads, the rest dropped", () => {
        const run = auto.resolveTargets(
            step([{ kind: "label", id: "night" }], { exclude: [{ kind: "device", id: "sofa" }] }),
            SCOPE
        );
        expect(run.deviceId).toBe("reading");
        expect("exclude" in run || "only" in run || "targets" in run).toBe(false);
    });
});

describe("a stored block", () => {
    it("from before areas is read by its devices alone", () => {
        const old = { id: "stepold", kind: "device", deviceId: "sofa", do: "turn-on" };
        expect(auto.actionSchema.safeParse(old).success).toBe(true);
        expect(resolve(old as auto.TargetBlock)).toEqual(["sofa"]);
        expect(auto.expands(old)).toBe(false);
    });

    it("from before labels keeps reading its room", () => {
        const noLabels = {
            ...SCOPE,
            devices: DEVICES.map(({ labelIds: _labels, ...device }) => device)
        };
        expect(resolve(step([{ kind: "room", id: "living" }]), noLabels)).toEqual(["sofa"]);
    });

    it("accepts the new fields, and refuses a kind it does not know", () => {
        const block = { ...step([{ kind: "label", id: "top" }], {
            only: ["light"],
            exclude: [{ kind: "room", id: "kitchen" }]
        }), deviceId: "ceiling" };
        expect(auto.actionSchema.safeParse(block).success).toBe(true);
        expect(auto.actionSchema.safeParse({ ...block, only: ["toaster"] }).success).toBe(false);
        expect(
            auto.actionSchema.safeParse({ ...block, exclude: [{ kind: "place", id: "all" }] }).success
        ).toBe(false);
    });
});

describe("an automation naming areas", () => {
    const definition = (block: object): auto.AutomationDefinition => ({
        timeZone: "UTC",
        triggers: [{ id: "trigtime", kind: "time", at: "07:30", days: [] } as auto.Trigger],
        conditions: { match: "all", groups: [] },
        actions: [block as auto.Step]
    });
    const devices = DEVICES.map((device) => ({ ...device, name: device.id }));
    const context = {
        automationIds: [],
        selfId: null,
        rooms: ROOMS,
        labels: [{ id: "top" }, { id: "night" }]
    };
    const messages = (block: object) =>
        auto.deviceIssues(definition(block), devices, context).map((issue) => issue.message);

    it("is refused where a label is gone, or everything is left out", () => {
        expect(messages(step([{ kind: "label", id: "gone" }]))).toEqual([
            "automations.errors.placeGone"
        ]);
        expect(
            messages(step([{ kind: "label", id: "top" }], { exclude: [{ kind: "label", id: "top" }] }))
        ).toEqual(["automations.errors.allExcluded"]);
        expect(messages(step([{ kind: "label", id: "night" }]))).toEqual([]);
    });
});

describe("how a block's set reads", () => {
    const t = placesCatalogs.translator("en-US", "places");
    const lookup = lookupOf([], [{ id: "kitchen", name: "Kitchen", floor: "" }], [], [
        { id: "top", name: "Ceiling" }
    ]);

    it("names its kinds, its areas and what it leaves out", () => {
        const said = describeStep(
            step([{ kind: "room", id: "kitchen" }, { kind: "label", id: "top" }], {
                    only: ["light"],
                    exclude: [{ kind: "device", id: "hall" }]
                }),
            lookup,
            () => undefined,
            t
        );
        expect(said).toContain("Lights in Kitchen, Ceiling, except one");
    });
});
