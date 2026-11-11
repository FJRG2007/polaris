/**
 * An app's administrator settings have one address,
 * `/admin/apps/<app>/settings`: the page an app draws them with among its own
 * routes is drawn there, and is not found at the app's own address.
 */

import { describe, expect, it, vi } from "vitest";

const drawn: string[] = [];

vi.mock("next/navigation", () => ({
    notFound: () => {
        throw new Error("not found");
    },
    redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
    }
}));
vi.mock("@/lib/session", () => ({
    requireUser: vi.fn(async () => ({ id: "user-1", isAdmin: true })),
    homePathForUser: vi.fn(async () => "/home")
}));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: vi.fn(async () => true) }));
vi.mock("@/lib/app-bundles/code", () => ({
    findAppRoute: (_kind: string, url: string) => {
        drawn.push(url);
        return { params: {}, load: async () => ({ default: () => null }) };
    },
    knownApps: () => ["calendar", "translate"]
}));
vi.mock("@/lib/app-bundles/loader", () => ({ loadedBundle: () => undefined }));
vi.mock("@/lib/app-bundles/shared-server", () => ({ provideShared: () => {} }));
vi.mock("@/components/app-bundles/mount", () => ({}));
vi.mock("@/components/app-bundles/unavailable", () => ({ AppUnavailable: () => null }));

const { findApp } = await import("@/lib/apps/catalog");
const { renderAppPage, renderAppSettings } = await import("@/lib/app-bundles/serve-page");

const at = (...path: string[]) => ({
    params: Promise.resolve({ path }),
    searchParams: Promise.resolve({})
});

describe("an app's settings address", () => {
    it("is not found at the app's own route", async () => {
        expect(findApp("calendar")?.settingsAt).toBe("/calendar/admin");
        await expect(renderAppPage("/calendar", "calendar", at("admin"))).rejects.toThrow(
            "not found"
        );
        await expect(renderAppPage("/translate", "translate", at("settings"))).rejects.toThrow(
            "not found"
        );
    });

    it("draws the app's page there, and its other pages where they are", async () => {
        drawn.length = 0;
        await expect(renderAppSettings("calendar", Promise.resolve({}))).resolves.toBeTruthy();
        expect(drawn).toEqual(["/calendar/admin"]);
        await expect(renderAppPage("/calendar", "calendar", at("settings"))).resolves.toBeTruthy();
        await expect(renderAppSettings("crm", Promise.resolve({}))).resolves.toBeNull();
    });
});
