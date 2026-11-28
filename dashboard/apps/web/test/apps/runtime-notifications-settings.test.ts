/**
 * An app delivered by the published catalogue brings its kinds of alert and its
 * settings page in its manifest: the kinds are accepted by the same checks a
 * built-in alert passes (listed, ruled, validated), filed under "apps" with the
 * app's name, and go when the app is withdrawn; its settings page is one of its
 * own screens and nothing else. Built-in kinds resolve exactly as before.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/app-bundles/store", () => ({ bundleRoot: () => "/nonexistent-polaris-test" }));

import { HOST_API } from "@polaris/app-host/version";
import {
    NOTIFICATION_EVENTS,
    breaksDoNotDisturb,
    isNotificationEvent,
    notificationEvent,
    notificationEvents,
    resolveRule
} from "@polaris/core";
import { findApp } from "@/lib/apps/catalog";
import { registerRuntimeApps } from "@/lib/apps/runtime-apps";
import { KNOWN_PERMISSIONS } from "@/lib/apps/runtime-catalog";
import { readAppCatalog, runtimeViews } from "@/lib/apps/runtime-catalog-schema";
import { visibleNotificationGroups } from "@/lib/notifications/group-apps";

const bakery = {
    id: "bakery",
    version: "1.0.0",
    hostApi: HOST_API,
    name: { "en-US": "Bakery", "es-ES": "Panaderia" },
    summary: { "en-US": "Run a bakery." },
    description: { "en-US": "Orders and ovens." },
    category: "Productivity",
    permissions: ["bakery.use"],
    permissionDefs: [{ key: "bakery.use", label: { "en-US": "Take orders" } }],
    notificationKinds: [
        {
            id: "bakery.oven-hot",
            label: { "en-US": "Oven too hot", "es-ES": "Horno demasiado caliente" },
            description: { "en-US": "An oven went over its limit." },
            level: "warning",
            target: "/x/bakery/ovens"
        },
        // Not its own id, a built-in id, a page that is not its own: all left out.
        { id: "deploy.failed", label: { "en-US": "x" }, description: { "en-US": "x" }, target: "/x/bakery" },
        { id: "other.kind", label: { "en-US": "x" }, description: { "en-US": "x" }, target: "/x/bakery" },
        { id: "bakery.elsewhere", label: { "en-US": "x" }, description: { "en-US": "x" }, target: "/admin/users" }
    ],
    settingsAt: "/x/bakery/settings",
    bundle: { file: "bakery.zip", digest: `sha256:${"e".repeat(64)}`, size: 1024 },
    published: "2026-11-28T00:00:00.000Z"
};

const deliver = (apps: unknown[], locale = "en-US") =>
    registerRuntimeApps(
        runtimeViews(readAppCatalog({ schema: 1, kind: "apps", issued: "2026-11-28T00:00:00.000Z", apps }), KNOWN_PERMISSIONS, locale)
    );

afterEach(() => deliver([]));

describe("an app's kinds of alert, from its manifest", () => {
    it("joins the kinds every check reads, under apps, named with the app", () => {
        deliver([bakery]);
        expect(isNotificationEvent("bakery.oven-hot")).toBe(true);
        expect(notificationEvent("bakery.oven-hot")).toMatchObject({
            group: "apps",
            label: "Bakery: Oven too hot",
            level: "warning",
            target: "/x/bakery/ovens",
            defaults: { inapp: true, email: false }
        });
        expect(notificationEvents().map((kind) => kind.id)).toContain("bakery.oven-hot");
        expect(resolveRule({}, "bakery.oven-hot")).toEqual({ inapp: true, email: false, destinations: [] });
        // Only Polaris's own alerts break through do not disturb.
        expect(breaksDoNotDisturb("bakery.oven-hot")).toBe(false);
        expect(visibleNotificationGroups(new Set())).toContain("apps");
    });

    it("never takes a built-in kind, another app's id or a page that is not its own", () => {
        deliver([bakery]);
        expect(isNotificationEvent("other.kind")).toBe(false);
        expect(isNotificationEvent("bakery.elsewhere")).toBe(false);
        expect(notificationEvent("deploy.failed")?.group).toBe("deploy");
        expect(notificationEvents().slice(0, NOTIFICATION_EVENTS.length)).toEqual(NOTIFICATION_EVENTS);
    });

    it("is labelled in the reader's language and goes when the app is withdrawn", () => {
        deliver([bakery], "es-ES");
        expect(notificationEvent("bakery.oven-hot")?.label).toBe("Panaderia: Horno demasiado caliente");
        deliver([]);
        expect(isNotificationEvent("bakery.oven-hot")).toBe(false);
        expect(notificationEvents()).toBe(NOTIFICATION_EVENTS);
    });
});

describe("an app's settings page, from its manifest", () => {
    it("is one of its own screens, drawn at Admin > Apps > Settings", () => {
        deliver([bakery]);
        expect(findApp("bakery")?.settingsAt).toBe("/x/bakery/settings");
    });

    it("is dropped when it points anywhere else", () => {
        deliver([{ ...bakery, settingsAt: "/x/other/settings" }]);
        expect(findApp("bakery")?.settingsAt).toBeUndefined();
        expect(readAppCatalog({ schema: 1, kind: "apps", issued: "2026-11-28T00:00:00.000Z", apps: [{ ...bakery, settingsAt: "/admin/users" }] })?.apps).toEqual([]);
    });
});
