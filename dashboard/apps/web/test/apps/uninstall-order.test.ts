/**
 * The order an uninstall works in, what a stopped one still has left, and which
 * shared resources it may take with it.
 */

import { describe, expect, it } from "vitest";
import { POLARIS_APP_CATALOG, findApp } from "@/lib/apps/catalog";
import {
    UNINSTALL_PHASES,
    freedShared,
    installFootprint,
    leftAfterFailure,
    phaseOf,
    uninstallSteps,
    type InstallResource
} from "@/lib/apps/uninstall-plan";

const containerApp = POLARIS_APP_CATALOG.find(
    (app) => app.installMethod !== "builtin" && (app.template?.volumes?.length ?? 0) > 0
);

function indexOf(steps: ReturnType<typeof uninstallSteps>, resource: InstallResource): number {
    return steps.findIndex((one) => one.resource === resource);
}

describe("uninstall order", () => {
    it.each(POLARIS_APP_CATALOG.map((app) => [app.id, app] as const))(
        "%s: steps run phase by phase and cover the whole footprint",
        (_id, app) => {
            for (const deleteData of [false, true]) {
                const steps = uninstallSteps(app, { deleteData });
                const phases = steps.map((one) => UNINSTALL_PHASES.indexOf(one.phase));
                expect(phases).toEqual([...phases].sort((a, b) => a - b));
                expect(steps.map((one) => one.resource).sort()).toEqual(
                    [...installFootprint(app)].sort()
                );
            }
        }
    );

    it("stops, unroutes, removes containers, then networks, then data, then rows", () => {
        expect(containerApp).toBeDefined();
        const steps = uninstallSteps(containerApp!, { deleteData: true });
        const order: InstallResource[] = [
            "quick-tunnel",
            "edge-routes",
            "containers",
            "network",
            "volume-data",
            "install-row"
        ];
        const at = order.map((resource) => indexOf(steps, resource));
        expect(at.every((index) => index >= 0)).toBe(true);
        expect(at).toEqual([...at].sort((a, b) => a - b));
    });

    it("deletes files before the rows that find them", () => {
        const home = findApp("home");
        if (!home) return;
        const steps = uninstallSteps(home, { deleteData: true });
        expect(indexOf(steps, "install-files")).toBeLessThan(indexOf(steps, "install-data"));
        expect(indexOf(steps, "install-data")).toBeLessThan(indexOf(steps, "install-row"));
    });

    it("gives every resource a phase", () => {
        for (const app of POLARIS_APP_CATALOG) {
            for (const resource of installFootprint(app)) {
                expect(UNINSTALL_PHASES).toContain(phaseOf(resource));
            }
        }
    });
});

describe("a stopped uninstall", () => {
    it("still has everything from the failed phase on, and nothing before it", () => {
        const steps = uninstallSteps(containerApp!, { deleteData: true });
        const left = leftAfterFailure(steps, "containers");
        expect(left).toContain("containers");
        expect(left).toContain("volume-data");
        expect(left).toContain("install-row");
        expect(left).not.toContain("quick-tunnel");
        expect(left).not.toContain("edge-routes");
    });

    it("never calls what it keeps on purpose left", () => {
        const steps = uninstallSteps(containerApp!, { deleteData: false });
        const left = leftAfterFailure(steps, "files");
        expect(left).not.toContain("volume-data");
        expect(left).not.toContain("marketplace-project");
        expect(left).not.toContain("audit");
    });

    it("is retried from the same plan, so a second attempt asks for the same thing", () => {
        const first = uninstallSteps(containerApp!, { deleteData: true });
        const second = uninstallSteps(containerApp!, { deleteData: true });
        expect(second).toEqual(first);
        expect(leftAfterFailure(second, "data")).toEqual(leftAfterFailure(first, "data"));
    });
});

describe("shared resources", () => {
    it("frees only what nobody but the leaving app uses", () => {
        const users = new Map([
            ["image-only-mine", ["app-a"]],
            ["image-shared", ["app-a", "app-b"]],
            ["network-of-two-leaving", ["app-a", "app-c"]],
            ["unused", []]
        ]);
        expect(freedShared(users, new Set(["app-a"]))).toEqual(["image-only-mine", "unused"]);
        expect(freedShared(users, new Set(["app-a", "app-c"]))).toEqual([
            "image-only-mine",
            "network-of-two-leaving",
            "unused"
        ]);
    });

    it("frees nothing when nobody leaves", () => {
        const users = new Map([["image-shared", ["app-a", "app-b"]]]);
        expect(freedShared(users, new Set())).toEqual([]);
    });
});
