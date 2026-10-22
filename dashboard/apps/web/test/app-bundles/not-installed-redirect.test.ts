/**
 * An app's page on a Polaris that does not have the app sends an admin to where
 * it is installed from - its listing in Polaris apps - and anybody else home,
 * since the admin screen would only turn them away.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const reader = vi.hoisted(() => ({ isAdmin: true }));

vi.mock("next/navigation", () => ({
    notFound: () => {
        throw new Error("not found");
    },
    redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
    }
}));
vi.mock("@/lib/session", () => ({
    requireUser: vi.fn(async () => ({ id: "user-1", isAdmin: reader.isAdmin })),
    homePathForUser: vi.fn(async () => "/home")
}));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: vi.fn(async () => false) }));
vi.mock("@/lib/app-bundles/code", () => ({
    findAppRoute: () => null,
    knownApps: () => ["crm"]
}));
vi.mock("@/lib/app-bundles/loader", () => ({ loadedBundle: () => undefined }));
vi.mock("@/lib/app-bundles/shared-server", () => ({ provideShared: () => {} }));
vi.mock("@/components/app-bundles/mount", () => ({}));
vi.mock("@/components/app-bundles/unavailable", () => ({ AppUnavailable: () => null }));

const { renderAppPage } = await import("@/lib/app-bundles/serve-page");

const props = { params: Promise.resolve({ path: [] }), searchParams: Promise.resolve({}) };

beforeEach(() => {
    reader.isAdmin = true;
});

describe("an app this Polaris does not have", () => {
    it("opens Polaris apps on it for an admin", async () => {
        await expect(renderAppPage("crm", "crm", props)).rejects.toThrow(
            "redirect /admin/apps?app=crm"
        );
    });

    it("sends anybody else home", async () => {
        reader.isAdmin = false;
        await expect(renderAppPage("crm", "crm", props)).rejects.toThrow("redirect /home");
    });

    it("is simply not found on a public surface", async () => {
        await expect(renderAppPage("crm", "crm", props, { public: true })).rejects.toThrow(
            "not found"
        );
    });
});
