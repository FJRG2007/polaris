/**
 * An app delivered by the published catalogue brings its own permissions with no
 * change to core: they are listed in the roles editor, accepted when a role is
 * saved, carried by the grants that imply them, checked by the same function the
 * server uses, and kept off minors until allowed. Built-in permissions, and the
 * stored roles that name them, resolve exactly as before.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/app-bundles/store", () => ({ bundleRoot: () => "/nonexistent-polaris-test" }));

import { HOST_API } from "@polaris/app-host/version";
import {
    deniedPermissions,
    expandPermissions,
    hasPermission,
    knownPermissions,
    listedPermissions,
    permissionMeta,
    registerAppPermissions,
    roleGrantsSchema,
    type Permission
} from "@polaris/core";
import { findApp } from "@/lib/apps/catalog";
import { registerRuntimeApps } from "@/lib/apps/runtime-apps";
import { KNOWN_PERMISSIONS } from "@/lib/apps/runtime-catalog";
import { readAppCatalog, runtimeViews } from "@/lib/apps/runtime-catalog-schema";

const bakery = {
    id: "bakery",
    version: "1.0.0",
    hostApi: HOST_API,
    minPolaris: "0.1.140",
    name: { "en-US": "Bakery", "es-ES": "Panaderia" },
    summary: { "en-US": "Run a bakery." },
    description: { "en-US": "Orders and ovens." },
    category: "Productivity",
    nav: { category: "work", permission: "bakery.use" },
    permissions: ["bakery.use", "bakery.manage"],
    permissionDefs: [
        { key: "bakery.use", label: { "en-US": "Take orders" } },
        { key: "bakery.manage", label: { "en-US": "Run the bakery" }, implies: ["bakery.use"] },
        // Not its own: ignored, so an app can never take over a built-in permission.
        { key: "deploy.manage", label: { "en-US": "Taken over" } }
    ],
    bundle: { file: "bakery.zip", digest: `sha256:${"e".repeat(64)}`, size: 1024 },
    published: "2026-11-28T00:00:00.000Z"
};

const deliver = (apps: unknown[]) =>
    registerRuntimeApps(
        runtimeViews(readAppCatalog({ schema: 1, kind: "apps", issued: "2026-11-28T00:00:00.000Z", apps }), KNOWN_PERMISSIONS, "en-US")
    );

afterEach(() => deliver([]));

describe("an app's own permissions, from its manifest", () => {
    it("makes an app that brings its own permissions runnable, with a nav entry", () => {
        deliver([bakery]);
        expect(findApp("bakery")?.needsPolaris).toBeUndefined();
    });

    it("lists them in the roles editor once the app is installed, filed under the app", () => {
        deliver([bakery]);
        expect(listedPermissions(["bakery"])).toEqual(expect.arrayContaining(["bakery.use", "bakery.manage"]));
        expect(listedPermissions([])).not.toContain("bakery.use");
        expect(permissionMeta("bakery.manage" as Permission)).toEqual({ area: "Bakery", app: "bakery", label: "Run the bakery" });
    });

    it("accepts them when a role is saved and refuses a permission nobody declared", () => {
        deliver([bakery]);
        expect(roleGrantsSchema.safeParse({ permissions: ["bakery.manage"] }).success).toBe(true);
        expect(roleGrantsSchema.safeParse({ permissions: ["pastry.use"] }).success).toBe(false);
    });

    it("enforces them with the same check the server uses, implied grants included", () => {
        deliver([bakery]);
        const role = expandPermissions(["bakery.manage" as Permission]);
        expect(role).toEqual(expect.arrayContaining(["bakery.manage", "bakery.use"]));
        expect(hasPermission(role, "bakery.use" as Permission)).toBe(true);
        expect(hasPermission(["drive.read"], "bakery.use" as Permission)).toBe(false);
        expect(hasPermission(["*"], "bakery.use" as Permission)).toBe(true);
    });

    it("keeps them off a minor until a guardian allows them", () => {
        deliver([bakery]);
        expect(deniedPermissions({ stage: "child", allowed: new Set(), contactsOnly: new Set(), ignored: [] } as never)).toContain(
            "bakery.use"
        );
    });

    it("never lets an app take over a built-in permission", () => {
        deliver([bakery]);
        expect(permissionMeta("deploy.manage")).not.toMatchObject({ app: "bakery" });
        registerAppPermissions("bakery", "Bakery", [{ key: "hospitality.use", label: "Stolen" }]);
        expect(permissionMeta("hospitality.use").label).not.toBe("Stolen");
    });

    it("withdraws them with the app, and a stored grant of one no longer passes the role schema", () => {
        deliver([bakery]);
        deliver([]);
        expect(knownPermissions()).not.toContain("bakery.use");
        expect(roleGrantsSchema.safeParse({ permissions: ["bakery.use"] }).success).toBe(false);
    });

    it("leaves every built-in permission, and roles naming them, exactly as they were", () => {
        expect(knownPermissions()).toEqual(expect.arrayContaining(["hospitality.use", "hospitality.manage", "deploy.read"]));
        expect(roleGrantsSchema.safeParse({ permissions: ["hospitality.use"] }).success).toBe(true);
        expect(hasPermission(["hospitality.use"], "hospitality.use")).toBe(true);
    });
});
