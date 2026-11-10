/**
 * Analytics and Telemetry installed by the update itself are taken back.
 *
 * One release installed both on every instance already set up. They are apps
 * to install, so those automatic installs are removed once - keeping their
 * data - and an install a person made is never touched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    catalogId: string;
    status: string;
    ownerId: string;
    installedById: string | null;
    createdAt: Date;
}

let installs: Row[] = [];
let settings = new Map<string, string>();
const invalidated: string[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findMany: async ({
                where
            }: {
                where: { catalogId: { in: string[] }; createdAt: { gte: Date; lte: Date } };
            }) =>
                installs.filter(
                    (row) =>
                        where.catalogId.in.includes(row.catalogId) &&
                        row.status !== "removed" &&
                        row.createdAt >= where.createdAt.gte &&
                        row.createdAt <= where.createdAt.lte
                ),
            updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: { status: string } }) => {
                for (const row of installs) if (where.id.in.includes(row.id)) row.status = data.status;
                return { count: where.id.in.length };
            }
        }
    }
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    swapSetting: async (key: string, expected: string | null, value: string) => {
        if ((settings.get(key) ?? null) !== expected) return false;
        settings.set(key, value);
        return true;
    }
}));
vi.mock("@/lib/apps/install-presence", () => ({
    invalidateInstallPresence: (id: string) => invalidated.push(id)
}));

const { CARRY_MARK, undoFormerlyBuiltInCarry } = await import("../../src/lib/apps/optional-app-carry");

const carriedAt = new Date("2026-11-09T10:00:00.000Z");
const row = (catalogId: string, overrides: Partial<Row> = {}): Row => ({
    id: `${catalogId}-1`,
    catalogId,
    status: "running",
    ownerId: "admin",
    installedById: "admin",
    createdAt: new Date(carriedAt.getTime() + 1_000),
    ...overrides
});

beforeEach(() => {
    installs = [];
    settings = new Map();
    invalidated.length = 0;
});

describe("taking back the automatic Analytics and Telemetry installs", () => {
    it("removes both when the update installed them, keeping the rows", async () => {
        settings.set(CARRY_MARK, carriedAt.toISOString());
        installs = [row("analytics"), row("telemetry")];
        expect(await undoFormerlyBuiltInCarry()).toEqual(["analytics", "telemetry"]);
        expect(installs.map((install) => install.status)).toEqual(["removed", "removed"]);
        expect(invalidated).toEqual(["analytics", "telemetry"]);
    });

    it("does nothing on an instance the update never carried", async () => {
        installs = [row("analytics")];
        expect(await undoFormerlyBuiltInCarry()).toEqual([]);
        expect(installs[0]?.status).toBe("running");
    });

    it("leaves an install somebody made later", async () => {
        settings.set(CARRY_MARK, carriedAt.toISOString());
        installs = [row("analytics", { createdAt: new Date(carriedAt.getTime() + 86_400_000) })];
        expect(await undoFormerlyBuiltInCarry()).toEqual([]);
        expect(installs[0]?.status).toBe("running");
    });

    it("leaves an install made by somebody other than its owner", async () => {
        settings.set(CARRY_MARK, carriedAt.toISOString());
        installs = [row("telemetry", { installedById: "someone-else" })];
        expect(await undoFormerlyBuiltInCarry()).toEqual([]);
    });

    it("runs once, so a reinstall afterwards stays", async () => {
        settings.set(CARRY_MARK, carriedAt.toISOString());
        installs = [row("analytics")];
        await undoFormerlyBuiltInCarry();
        installs[0]!.status = "running";
        expect(await undoFormerlyBuiltInCarry()).toEqual([]);
        expect(installs[0]?.status).toBe("running");
    });
});
