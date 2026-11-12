/**
 * Places' Machines and NAS screens send away somebody who was given neither the
 * screen's own app nor Places, and lent nothing on it.
 *
 * The source scan in app-route-guards.test.ts only sees that a page reads a
 * permission; both of these read one and still drew an empty screen for anybody
 * signed in. So the refusal itself is checked here, by running the pages.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    permissions: new Set<string>(),
    grants: new Map<string, Map<string, unknown>>(),
    nas: [] as { id: string; name: string }[]
}));

class Redirected extends Error {
    constructor(readonly to: string) {
        super(`redirect ${to}`);
    }
}

const user = { id: "user-1" };

vi.mock("next/navigation", () => ({
    redirect: (to: string) => {
        throw new Redirected(to);
    }
}));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("@polaris/ui", () => ({ PageHeader: () => null, Skeleton: () => null, ProductMark: () => null }));
vi.mock("@polaris/db", () => ({
    prisma: { storageConnection: { findMany: async () => state.nas } }
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/access/grants", () => ({
    grantedSubjects: async (_userId: string, subject: string) =>
        state.grants.get(subject) ?? new Map()
}));
vi.mock("@/lib/session", () => ({
    requireUser: async () => user,
    homePathForUser: async () => "/overview",
    sessionCan: async (_user: unknown, permission: string) => state.permissions.has(permission),
    sessionCanAny: async (_user: unknown, permission: string) => state.permissions.has(permission)
}));
vi.mock("@/lib/machines/machines-service", () => ({}));
vi.mock("../../src/app/(app)/places/machines/machine-groups", () => ({
    MachineCards: () => null,
    MachineDomains: () => null
}));

const { default: MachinesPage } = await import("../../src/app/(app)/places/machines/page");
const { default: NasListPage } = await import("../../src/app/(app)/places/nas/page");

const DENIED = "/overview?denied=1";

beforeEach(() => {
    state.permissions = new Set();
    state.grants = new Map();
    state.nas = [];
});

describe("the Machines screen", () => {
    it("refuses somebody with neither machines, Places nor anything lent", async () => {
        await expect(MachinesPage()).rejects.toMatchObject({ to: DENIED });
    });

    it("opens for somebody with Places, though they own no machines", async () => {
        state.permissions = new Set(["home.read"]);
        await expect(MachinesPage()).resolves.toBeTruthy();
    });

    it("opens for somebody with machines", async () => {
        state.permissions = new Set(["deploy.read"]);
        await expect(MachinesPage()).resolves.toBeTruthy();
    });

    it("opens for somebody lent a server, without either permission", async () => {
        state.grants = new Map([["place.server", new Map([["server-1", {}]])]]);
        await expect(MachinesPage()).resolves.toBeTruthy();
    });
});

describe("the NAS list", () => {
    it("refuses somebody with neither Places nor a NAS", async () => {
        await expect(NasListPage()).rejects.toMatchObject({ to: DENIED });
    });

    it("refuses somebody whose lent NAS is gone", async () => {
        state.permissions = new Set(["home.read"]);
        state.grants = new Map([["place.nas", new Map([["nas-gone", {}]])]]);
        await expect(NasListPage()).rejects.toMatchObject({ to: DENIED });
    });

    it("opens empty for somebody with Places", async () => {
        state.permissions = new Set(["home.read"]);
        await expect(NasListPage()).resolves.toBeTruthy();
    });

    it("goes straight to the one NAS somebody was lent", async () => {
        state.grants = new Map([["place.nas", new Map([["nas-1", {}]])]]);
        state.nas = [{ id: "nas-1", name: "Shelf" }];
        await expect(NasListPage()).rejects.toMatchObject({ to: "/places/nas/nas-1" });
    });
});
