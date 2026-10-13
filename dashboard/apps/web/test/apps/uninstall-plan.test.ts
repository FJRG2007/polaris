/**
 * The uninstall plan covers everything an install creates.
 *
 * `installFootprint` is the inventory of what `installApp` makes for an app;
 * `uninstallPlan` says what uninstalling does with each piece. Every catalog
 * app is checked, so a manifest that grows a volume or a capability cannot
 * leave something behind unnoticed, and the list of install-scoped tables is
 * read against the Prisma schema itself.
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POLARIS_APP_CATALOG, findApp } from "@/lib/apps/catalog";
import {
    INSTALL_SCOPED_MODELS,
    installFootprint,
    keptResources,
    uninstallPlan,
    type InstallResource
} from "@/lib/apps/uninstall-plan";

/** Kept whatever the reader chose: shared with other apps, or the audit trail. */
const ALWAYS_KEPT: InstallResource[] = ["marketplace-project", "deploy-target", "audit"];

describe("uninstall plan", () => {
    it.each(POLARIS_APP_CATALOG.map((app) => [app.id, app] as const))(
        "%s: every resource the install creates has a step",
        (_id, app) => {
            for (const deleteData of [false, true]) {
                const plan = uninstallPlan(app, { deleteData });
                for (const resource of installFootprint(app)) {
                    expect(plan.has(resource), resource).toBe(true);
                }
            }
        }
    );

    it.each(POLARIS_APP_CATALOG.map((app) => [app.id, app] as const))(
        "%s: deleting the data keeps only what is shared or audited",
        (_id, app) => {
            const kept = keptResources(uninstallPlan(app, { deleteData: true }));
            for (const resource of kept) expect(ALWAYS_KEPT).toContain(resource);
        }
    );

    it("keeps the data, and only the data, when the reader did not ask to delete it", () => {
        const app = findApp("minecraft")!;
        const kept = keptResources(uninstallPlan(app, { deleteData: false }));
        expect(kept.sort()).toEqual(
            [...ALWAYS_KEPT, "analytics", "install-data", "install-row", "volume-data"].sort()
        );
        // The container side goes either way.
        const plan = uninstallPlan(app, { deleteData: false });
        for (const resource of [
            "containers",
            "network",
            "env-vars",
            "edge-routes",
            "grants",
            "firewall-rules"
        ] as const) {
            expect(plan.get(resource)?.action, resource).toBe("remove");
        }
    });

    it("lists a volume only for an app whose template declares one", () => {
        for (const app of POLARIS_APP_CATALOG) {
            const declares = (app.template?.volumes?.length ?? 0) > 0;
            expect(installFootprint(app).includes("volume-data")).toBe(declares);
        }
    });

    it("a builtin app's helpers are uninstalled with the data, paused without", () => {
        const home = findApp("home")!;
        expect(uninstallPlan(home, { deleteData: true }).get("owned-services")?.action).toBe(
            "remove"
        );
        expect(uninstallPlan(home, { deleteData: false }).get("owned-services")?.action).toBe(
            "keep"
        );
    });

    it("the hub's shared secret never survives an uninstall", () => {
        const hub = findApp("messaging-bridge")!;
        expect(installFootprint(hub)).toContain("install-secret");
        expect(uninstallPlan(hub, { deleteData: false }).get("install-secret")?.action).toBe(
            "remove"
        );
    });
});

describe("install-scoped tables", () => {
    it("names every model in the schema that keeps rows under an install id", () => {
        const schema = readFileSync(
            resolve(__dirname, "../../../../packages/db/prisma/schema.prisma"),
            "utf8"
        );
        const models = [...schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)]
            .filter(([, , body]) => /^\s*installedAppId\s+String/m.test(body!))
            .map(([, name]) => name!.charAt(0).toLowerCase() + name!.slice(1));
        expect(models.length).toBeGreaterThan(0);
        expect([...INSTALL_SCOPED_MODELS].sort()).toEqual(models.sort());
    });

    it("deletes a child before the place it belongs to", () => {
        const order = [...INSTALL_SCOPED_MODELS];
        for (const child of ["camera", "alertRule", "placeDevice", "placeAutomation"] as const) {
            expect(order.indexOf(child)).toBeLessThan(order.indexOf("place"));
        }
        expect(order.indexOf("minecraftSound")).toBeLessThan(order.indexOf("minecraftSoundPack"));
        expect(order.indexOf("minecraftLoginCheckIn")).toBeLessThan(
            order.indexOf("minecraftLogin")
        );
    });
});
