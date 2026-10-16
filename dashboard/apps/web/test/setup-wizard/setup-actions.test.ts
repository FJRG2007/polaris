/**
 * The setup's server actions: only an administrator installs or settles it, it
 * opens by itself only on a new Polaris, and a failed install comes back as a
 * sentence the reader can act on rather than the cause.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Viewer {
    id: string;
    isAdmin: boolean;
    viewingAs?: unknown;
}

let viewer: Viewer | null;
let mark: string | null;
let users: { id: string }[];
let anyApp: { id: string } | null;
let present: Set<string>;
let reads: string[];
const installApp = vi.fn(async () => ({ installedAppId: "row-1", applicationId: null }));
const upsert = vi.fn(async () => ({}));

vi.mock("@polaris/db", () => ({
    prisma: {
        setting: {
            findUnique: async () => (mark === null ? null : { value: mark }),
            upsert: (...args: unknown[]) => upsert(...(args as []))
        },
        user: { findMany: async () => (reads.push("users"), users) },
        installedApp: { findFirst: async () => anyApp }
    }
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string, values?: Record<string, string>) =>
        values?.app ? `${key}:${values.app}` : key
}));
vi.mock("@/lib/session", () => ({
    backgroundUser: async () => viewer,
    requireUser: async () => {
        if (!viewer) throw new Error("signed out");
        return viewer;
    }
}));
vi.mock("@/lib/apps/install-service", () => ({
    installApp: (...args: unknown[]) => installApp(...(args as []))
}));
vi.mock("@/lib/apps/install-presence", () => ({
    isAppInstalled: async (id: string) => (reads.push(id), present.has(id))
}));

const { finishSetupAction, installSetupAppAction, setupInstalledAction, setupStateAction } =
    await import("@/app/(app)/setup-actions");

beforeEach(() => {
    viewer = { id: "admin-1", isAdmin: true };
    mark = null;
    users = [{ id: "admin-1" }];
    anyApp = null;
    present = new Set();
    reads = [];
    installApp.mockClear();
    upsert.mockClear();
});

describe("installing from the setup", () => {
    it("refuses anybody who is not an administrator, before touching anything", async () => {
        viewer = { id: "member-1", isAdmin: false };
        expect(await installSetupAppAction("calendar")).toEqual({ error: "errors.adminOnly" });
        viewer = { id: "admin-1", isAdmin: true, viewingAs: { mode: "user" } };
        expect(await installSetupAppAction("calendar")).toEqual({ error: "errors.adminOnly" });
        expect(installApp).not.toHaveBeenCalled();
    });

    it("installs only an app the setup offers", async () => {
        expect(await installSetupAppAction("vault")).toEqual({ error: "errors.unknownApp" });
        expect(await installSetupAppAction({ id: "calendar" })).toEqual({
            error: "errors.unknownApp"
        });
        expect(installApp).not.toHaveBeenCalled();
    });

    it("installs through the marketplace's path, as the administrator", async () => {
        expect(await installSetupAppAction("calendar")).toEqual({});
        expect(installApp).toHaveBeenCalledWith(
            "admin-1",
            "admin-1",
            expect.objectContaining({ catalogId: "calendar" })
        );
    });

    it("treats an app installed meanwhile as done", async () => {
        present.add("calendar");
        expect(await installSetupAppAction("calendar")).toEqual({});
        expect(installApp).not.toHaveBeenCalled();
    });

    it("hides the cause behind a sentence that names the app", async () => {
        installApp.mockRejectedValueOnce(new Error("P2002 Unique constraint failed on /srv/x"));
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const result = await installSetupAppAction("calendar");
        error.mockRestore();
        expect(result.error).toMatch(/^errors\.install:/);
        expect(result.error).not.toContain("P2002");
    });
});

describe("whether the setup opens by itself", () => {
    it("opens for the only administrator of a new Polaris", async () => {
        expect((await setupStateAction()).offer).toBe(true);
    });

    it("stays shut once finished or skipped, reading nothing but the mark", async () => {
        mark = "skipped";
        expect(await setupStateAction()).toEqual({ offer: false, installed: [] });
        expect(reads).toEqual([]);
    });

    it("stays shut on a Polaris already in use", async () => {
        users = [{ id: "admin-1" }, { id: "member-1" }];
        expect((await setupStateAction()).offer).toBe(false);
        users = [{ id: "admin-1" }];
        anyApp = { id: "row-9" };
        expect((await setupStateAction()).offer).toBe(false);
    });

    it("says nothing to somebody who may not install", async () => {
        viewer = { id: "member-1", isAdmin: false };
        expect(await setupStateAction()).toEqual({ offer: false, installed: [] });
    });

    it("reports which of its apps are already here", async () => {
        present = new Set(["home", "calendar"]);
        expect((await setupStateAction()).installed).toEqual(["calendar", "home"]);
    });

    it("asks no app whether it is installed on a Polaris already in use", async () => {
        users = [{ id: "admin-1" }, { id: "member-1" }];
        await setupStateAction();
        expect(reads).toEqual(["users"]);
    });
});

describe("the setup opened again from Management", () => {
    it("reports which of its apps are already here, whatever the mark says", async () => {
        mark = "done";
        present = new Set(["tools", "crm"]);
        expect(await setupInstalledAction()).toEqual(["crm", "tools"]);
    });

    it("says nothing to somebody who may not install", async () => {
        viewer = { id: "member-1", isAdmin: false };
        present = new Set(["tools"]);
        expect(await setupInstalledAction()).toEqual([]);
    });
});

describe("finishing the setup", () => {
    it("remembers a skip for everybody", async () => {
        await finishSetupAction("skipped");
        expect(upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { key: "setup.wizard" },
                update: { value: "skipped" }
            })
        );
    });

    it("refuses anybody who is not an administrator", async () => {
        viewer = { id: "member-1", isAdmin: false };
        expect(await finishSetupAction("done")).toEqual({ error: "errors.adminOnly" });
        expect(upsert).not.toHaveBeenCalled();
    });
});
