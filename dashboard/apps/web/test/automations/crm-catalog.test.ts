/**
 * The CRM's blocks in the node picker: there where the CRM is installed, and
 * nowhere - with every other group intact - where it is not.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import { CRM_NODE_TYPES } from "@polaris-app/crm/src/model/automation-nodes";
import { catalogGroups } from "@/app/(app)/automations/[id]/node-catalog";

const typesOf = (groups: ReturnType<typeof catalogGroups>) =>
    groups.flatMap((group) => group.items.map((item) => item.type));

describe("CRM in the picker", () => {
    it("offers its trigger, check and steps only while it is installed", () => {
        const without = catalogGroups({ triggers: true, apps: [] });
        expect(without.some((group) => group.id === "crm")).toBe(false);
        expect(typesOf(without).some((type) => type.startsWith("crm."))).toBe(false);

        const withCrm = catalogGroups({ triggers: true, apps: ["crm"] });
        const crm = withCrm.filter((group) => group.id === "crm");
        expect(crm).toHaveLength(1);
        expect(crm[0]!.items.map((item) => item.type).sort()).toEqual([...CRM_NODE_TYPES].sort());
        // Nothing else changes when it is there.
        expect(withCrm.filter((group) => group.id !== "crm")).toEqual(without);
    });

    it("offers only its steps where a trigger does not fit", () => {
        const steps = typesOf(catalogGroups({ triggers: false, apps: ["crm"] }));
        expect(steps).toContain("crm.action.notify");
        expect(steps).not.toContain("crm.trigger.record");
    });
});
