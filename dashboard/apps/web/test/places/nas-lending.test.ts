import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/access/grants", () => ({ liveGrants: vi.fn() }));

import * as core from "@polaris/core";
import { standingFromGrants } from "@/lib/nas/nas-access";

function grant(capability: string, actions: string[]) {
    return {
        id: `g-${capability}-${actions.join("-")}`,
        capability,
        actions: core.grantActions("place.nas", capability, actions),
        until: null,
        counted: true
    };
}

describe("a NAS lent per action", () => {
    it("offers watch, fan and backup, and only watch to a view grant", () => {
        expect(core.GRANT_ACTIONS["place.nas"]).toEqual(["watch", "fan", "backup"]);
        expect(core.grantActions("place.nas", "view", [])).toEqual(["watch"]);
        expect(core.grantActions("place.nas", "view", ["fan"])).toEqual([]);
    });

    it("lets a fan-only grant set the fan and not run a backup", () => {
        const standing = standingFromGrants([grant("control", ["fan"])]);
        expect(standing).toMatchObject({ manage: false, fan: true, backup: false });
        expect(standing?.grants.fan?.id).toBe("g-control-fan");
        expect(standing?.grants.backup).toBeUndefined();
    });

    it("lets a watch grant see it and drive nothing", () => {
        expect(standingFromGrants([grant("view", ["watch"])])).toMatchObject({
            fan: false,
            backup: false
        });
    });

    it("keeps a grant written before actions existed at everything it reached", () => {
        expect(standingFromGrants([grant("control", [])])).toMatchObject({
            fan: true,
            backup: true
        });
    });

    it("is nothing without a grant", () => {
        expect(standingFromGrants([])).toBeNull();
    });
});
