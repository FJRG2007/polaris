/**
 * The trash: records come back out of it, or are deleted for good - only ever
 * ones already in it, only on the reader's shelf, only by somebody who may
 * delete - and a record deleted for good takes its timeline with it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    records: {
        findMany: vi.fn(async (): Promise<{ id: string }[]> => []),
        updateMany: vi.fn(async () => ({ count: 1 })),
        deleteMany: vi.fn(async () => ({ count: 1 }))
    },
    crmEvent: {
        createMany: vi.fn(async () => ({ count: 1 })),
        deleteMany: vi.fn(async () => ({ count: 1 }))
    }
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        crmCompany: db.records,
        crmPerson: db.records,
        crmOpportunity: db.records,
        crmEvent: db.crmEvent
    },
    Prisma: { Decimal: class {} }
}));
vi.mock("@polaris/app-host", () => ({
    host: { crmHost: {}, i18nRequest: { getLocale: async () => "en-US" } }
}));

import { destroyRecords, restoreRecords } from "@polaris-app/crm/src/lib/records";

const allowed = { read: true, edit: true, delete: true };
const actorWith = (can: typeof allowed) =>
    ({
        user: { id: "u1", name: "Test User" },
        shelf: { orgId: "o1", userId: null, key: "org:o1" },
        can: { companies: can, people: can, opportunities: can }
    }) as never;

beforeEach(() => vi.clearAllMocks());

describe("the trash", () => {
    it("restores only trashed records on the shelf, and logs it", async () => {
        db.records.findMany.mockResolvedValueOnce([{ id: "c1" }]);
        expect(await restoreRecords(actorWith(allowed), "companies", ["c1", "c2"])).toBe(1);
        const [[find]] = db.records.findMany.mock.calls as unknown as [[{ where: unknown }]];
        expect(find.where).toEqual({
            id: { in: ["c1", "c2"] },
            orgId: "o1",
            deletedAt: { not: null }
        });
        expect(db.records.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["c1"] }, orgId: "o1", deletedAt: { not: null } },
            data: { deletedAt: null }
        });
        const [[logged]] = db.crmEvent.createMany.mock.calls as unknown as [
            [{ data: { kind: string; recordId: string }[] }]
        ];
        expect(logged.data).toEqual([
            expect.objectContaining({ kind: "restored", recordId: "c1", orgId: "o1" })
        ]);
    });

    it("deletes for good only what is in the trash, with its timeline", async () => {
        db.records.findMany.mockResolvedValueOnce([{ id: "c1" }]);
        expect(await destroyRecords(actorWith(allowed), "companies", ["c1", "c3"])).toBe(1);
        expect(db.records.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ["c1"] }, orgId: "o1", deletedAt: { not: null } }
        });
        expect(db.crmEvent.deleteMany).toHaveBeenCalledWith({
            where: { orgId: "o1", recordId: { in: ["c1"] } }
        });
    });

    it("touches nothing when none of the records is in the trash", async () => {
        expect(await destroyRecords(actorWith(allowed), "companies", ["c9"])).toBe(0);
        expect(db.records.deleteMany).not.toHaveBeenCalled();
        expect(db.crmEvent.deleteMany).not.toHaveBeenCalled();
    });

    it("refuses somebody who may not delete", async () => {
        const reader = { read: true, edit: true, delete: false };
        await expect(restoreRecords(actorWith(reader), "companies", ["c1"])).rejects.toThrow();
        await expect(destroyRecords(actorWith(reader), "companies", ["c1"])).rejects.toThrow();
        expect(db.records.findMany).not.toHaveBeenCalled();
    });
});
