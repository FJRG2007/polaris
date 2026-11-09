/**
 * Analytics and Telemetry stay installed on a Polaris that had them.
 *
 * They became apps to install; an instance that was already running when that
 * happened keeps both, a new one starts without them, and the decision is made
 * once - an uninstall afterwards is not undone by the next restart.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let admins: { id: string }[] = [];
let installs: { catalogId: string; status: string }[] = [];
let settings = new Map<string, string>();

vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findFirst: async () => admins[0] ?? null },
        installedApp: {
            findFirst: async ({ where }: { where: { catalogId: string } }) =>
                installs.find((row) => row.catalogId === where.catalogId && row.status !== "removed") ?? null,
            create: async ({ data }: { data: { catalogId: string } }) => {
                installs.push({ catalogId: data.catalogId, status: "running" });
                return { id: data.catalogId };
            }
        }
    }
}));
vi.mock("@/lib/setting-store", () => ({
    swapSetting: async (key: string, expected: string | null, value: string) => {
        if ((settings.get(key) ?? null) !== expected) return false;
        settings.set(key, value);
        return true;
    }
}));
vi.mock("@/lib/apps/catalog", () => ({ findApp: (id: string) => ({ name: id }) }));
vi.mock("@/lib/apps/install-presence", () => ({ invalidateInstallPresence: () => undefined }));

const { carryFormerlyBuiltInApps } = await import("../../src/lib/apps/optional-app-carry");

beforeEach(() => {
    admins = [];
    installs = [];
    settings = new Map();
});

describe("carrying Analytics and Telemetry", () => {
    it("installs both on a Polaris that was already set up", async () => {
        admins = [{ id: "admin" }];
        expect(await carryFormerlyBuiltInApps()).toEqual(["analytics", "telemetry"]);
        expect(installs.map((row) => row.catalogId)).toEqual(["analytics", "telemetry"]);
    });

    it("installs nothing on a Polaris being set up for the first time", async () => {
        expect(await carryFormerlyBuiltInApps()).toEqual([]);
        admins = [{ id: "admin" }];
        // The admin created afterwards does not bring them back.
        expect(await carryFormerlyBuiltInApps()).toEqual([]);
        expect(installs).toEqual([]);
    });

    it("runs once, so an uninstall afterwards stays", async () => {
        admins = [{ id: "admin" }];
        await carryFormerlyBuiltInApps();
        for (const row of installs) row.status = "removed";
        expect(await carryFormerlyBuiltInApps()).toEqual([]);
        expect(installs.every((row) => row.status === "removed")).toBe(true);
    });

    it("leaves one already installed alone", async () => {
        admins = [{ id: "admin" }];
        installs = [{ catalogId: "analytics", status: "running" }];
        expect(await carryFormerlyBuiltInApps()).toEqual(["telemetry"]);
    });
});
