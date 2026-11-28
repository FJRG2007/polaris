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
    appEventFields,
    appEventNames,
    appEventOwner,
    deniedPermissions,
    isAppEventName,
    parseAppEventPayload,
    registeredAppEventLabel,
    createApiKeySchema,
    expandPermissions,
    hasPermission,
    isAllowed,
    knownPermissions,
    listedPermissions,
    permissionMeta,
    policyTemplateOf,
    policyTemplateStatements,
    registerAppPermissions,
    roleGrantsSchema,
    type Permission
} from "@polaris/core";
import { findApp } from "@/lib/apps/catalog";
import { SCOPE_LABELS, scopeAppArea, scopeLabel } from "@/lib/api-key-scopes";
import { isMcpScope, mcpScopeListSchema, offeredMcpScopes, scopeCategory } from "@/lib/mcp/scope-table";
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
        { key: "bakery.manage", label: { "en-US": "Run the bakery" }, implies: ["bakery.use"], writes: true },
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

    it("accepts them when a role is saved, and refuses what is not a permission at all", () => {
        deliver([bakery]);
        expect(roleGrantsSchema.safeParse({ permissions: ["bakery.manage"] }).success).toBe(true);
        expect(roleGrantsSchema.safeParse({ permissions: ["not a permission"] }).success).toBe(false);
        expect(roleGrantsSchema.safeParse({ permissions: ["*"] }).success).toBe(false);
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

    it("keeps a dropped app's grant stored and inert: saving neither strips nor refuses it", () => {
        deliver([bakery]);
        const role = expandPermissions(["bakery.manage" as Permission, "drive.read"]);
        deliver([]);
        expect(knownPermissions()).not.toContain("bakery.use");
        // The role editor saves the role with the grant still in it...
        const saved = roleGrantsSchema.safeParse({ permissions: role });
        expect(saved.success).toBe(true);
        // ...and building the grants keeps it, after the known ones.
        expect(expandPermissions(role)).toEqual(expect.arrayContaining(["drive.read", "bakery.manage", "bakery.use"]));
        // It grants nothing while the app is gone, not even to the wildcard.
        expect(hasPermission(role, "bakery.use" as Permission)).toBe(false);
        expect(hasPermission(["*"], "bakery.use" as Permission)).toBe(false);
        expect(hasPermission(role, "drive.read")).toBe(true);
        // And works again the moment the app is back.
        deliver([bakery]);
        expect(hasPermission(role, "bakery.use" as Permission)).toBe(true);
    });

    it("is offered everywhere a built-in permission is: MCP scopes, API keys, sharing, policy templates", () => {
        deliver([bakery]);
        expect(offeredMcpScopes()).toEqual(expect.arrayContaining(["bakery.use", "bakery.manage"]));
        expect(isMcpScope("bakery.use")).toBe(true);
        expect(scopeCategory("bakery.use" as Permission)).toBe("productivity");
        expect(mcpScopeListSchema.safeParse(["bakery.use"]).success).toBe(true);
        expect(scopeLabel("bakery.manage" as Permission)).toBe("Run the bakery");
        expect(scopeAppArea("bakery.manage" as Permission)).toEqual({ title: "Bakery", app: "bakery" });
        expect(scopeLabel("drive.read")).toBe(SCOPE_LABELS["drive.read"]);
        const key = createApiKeySchema.safeParse({ name: "Till", scopes: ["bakery.manage"] });
        expect(key.success && key.data.scopes).toEqual(expect.arrayContaining(["bakery.manage", "bakery.use"]));
        const readOnly = policyTemplateOf("polaris:read-only")!;
        const denied = policyTemplateStatements(readOnly).flatMap((statement) => (statement.effect === "deny" ? statement.actions : []));
        expect(denied).toContain("bakery.manage");
        expect(denied).not.toContain("bakery.use");
        expect(isAllowed(policyTemplateStatements(readOnly), "bakery.manage", "*")).toBe(false);
    });

    it("drops out of the scopes it was offered in when the app is withdrawn", () => {
        deliver([bakery]);
        deliver([]);
        expect(offeredMcpScopes()).not.toContain("bakery.use");
        expect(isMcpScope("bakery.use")).toBe(false);
    });

    it("leaves every built-in permission, and roles naming them, exactly as they were", () => {
        expect(knownPermissions()).toEqual(expect.arrayContaining(["hospitality.use", "hospitality.manage", "deploy.read"]));
        expect(roleGrantsSchema.safeParse({ permissions: ["hospitality.use"] }).success).toBe(true);
        expect(hasPermission(["hospitality.use"], "hospitality.use")).toBe(true);
    });
});

describe("an app's own automation triggers, from its manifest", () => {
    const withEvents = {
        ...bakery,
        events: [
            { name: "bakery.oven-ready", label: { "en-US": "Oven ready" }, fields: { ovenId: "id", minutes: "number" } },
            // Not its own: left out, so an app never redefines another's event.
            { name: "deploy.succeeded", label: { "en-US": "Hijack" }, fields: {} }
        ]
    };

    it("offers them as triggers, with their fields, and validates what is emitted", () => {
        deliver([withEvents]);
        expect(appEventNames()).toContain("bakery.oven-ready");
        expect(appEventOwner("bakery.oven-ready")).toBe("bakery");
        expect(registeredAppEventLabel("bakery.oven-ready")).toBe("Oven ready");
        expect(appEventFields("bakery.oven-ready")).toEqual(["ovenId", "minutes"]);
        expect(parseAppEventPayload("bakery.oven-ready" as never, { ovenId: "o1", minutes: 12 })).toEqual({ ovenId: "o1", minutes: 12 });
        expect(parseAppEventPayload("bakery.oven-ready" as never, { ovenId: "o1", minutes: "12" })).toBeNull();
        expect(parseAppEventPayload("bakery.oven-ready" as never, { ovenId: "o1", minutes: 1, extra: true })).toBeNull();
        expect(appEventOwner("deploy.succeeded")).toBe("deploy");
    });

    it("withdraws them with the app, so a trigger naming one is no longer an event, while built-in ones stay", () => {
        deliver([withEvents]);
        deliver([]);
        expect(isAppEventName("bakery.oven-ready")).toBe(false);
        expect(appEventOwner("bakery.oven-ready")).toBeNull();
        expect(isAppEventName("game-server.started")).toBe(true);
    });
});
