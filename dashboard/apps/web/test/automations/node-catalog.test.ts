/**
 * The node picker's catalog: every entry is a node the engine runs, nothing the
 * old flat palette offered is lost, presets carry settings the server accepts,
 * and Places shows up only where it is installed.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/app/(app)/automations/actions", () => ({}));
import * as core from "@polaris/core";
import * as nodes from "@polaris-app/places/src/lib/automation-nodes";
import * as catalog from "@/app/(app)/automations/[id]/node-catalog";
import { STEP_TYPES, TRIGGER_TYPES } from "@/app/(app)/automations/[id]/node-fields";

const types = (groups: catalog.CatalogGroup[]) =>
    groups.flatMap((group) => group.items.map((item) => item.type));

describe("the node catalog", () => {
    it("offers every core trigger and step the editor knows", () => {
        const offered = new Set(types(catalog.catalogGroups({ triggers: true, apps: [] })));
        for (const type of [...TRIGGER_TYPES, ...STEP_TYPES]) expect(offered).toContain(type);
    });

    it("offers only real node types", () => {
        const all = types(catalog.catalogGroups({ triggers: true, apps: [catalog.PLACES_APP] }));
        for (const type of all)
            expect(core.isCoreNodeType(type) || nodes.PLACES_NODE_TYPES.includes(type)).toBe(true);
    });

    it("leaves triggers out where only a step fits", () => {
        const steps = types(catalog.catalogGroups({ triggers: false, apps: [catalog.PLACES_APP] }));
        expect(steps.some((type) => catalog.isTriggerType(type))).toBe(false);
        expect(steps).toContain("core.run");
        expect(steps).toContain(nodes.CONDITION_NODE_TYPE);
    });

    it("shows Places only where it is installed, as one group", () => {
        const without = catalog.catalogGroups({ triggers: true, apps: [] });
        expect(without.some((group) => group.id === "places")).toBe(false);
        const withPlaces = catalog.catalogGroups({ triggers: true, apps: [catalog.PLACES_APP] });
        const places = withPlaces.filter((group) => group.id === "places");
        expect(places).toHaveLength(1);
        expect(places[0]!.items.map((item) => item.type).sort()).toEqual(
            [...nodes.PLACES_NODE_TYPES].sort()
        );
    });

    it("never lists a group id twice", () => {
        const ids = catalog
            .catalogGroups({ triggers: true, apps: [catalog.PLACES_APP] })
            .map((group) => group.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("hands back presets with settings the On event trigger accepts", () => {
        const presets = catalog
            .catalogGroups({ triggers: true, apps: [] })
            .flatMap((group) => group.items)
            .filter((item) => item.preset);
        expect(presets.length).toBe(Object.keys(catalog.EVENT_PRESETS).length);
        for (const item of presets) {
            const picked = catalog.pickedNode(item.value);
            expect(picked?.type).toBe("core.onEvent");
            expect(core.CORE_NODE_CONFIGS["core.onEvent"].safeParse(picked?.config).success).toBe(
                true
            );
        }
    });

    it("refuses a preset it does not know, and passes a plain type through", () => {
        expect(catalog.pickedNode("core.onEvent#nope")).toBeNull();
        expect(catalog.pickedNode("core.http#publicIpChanged")).toBeNull();
        expect(catalog.pickedNode("core.http")).toEqual({ type: "core.http" });
    });
});
