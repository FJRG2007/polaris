/**
 * A card dropped at the end of a board column lands after every card of that
 * column, including the ones past the page the board has loaded.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const delegate = vi.hoisted(() => ({
    findFirst: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 }))
}));

vi.mock("@polaris/db", () => ({
    prisma: { crmCompany: delegate, crmPerson: delegate, crmOpportunity: delegate },
    Prisma: { Decimal: class {} }
}));
vi.mock("@polaris/app-host", () => ({
    host: { crmHost: {}, i18nRequest: { getLocale: async () => "en-US" } }
}));

import { moveRecord } from "@polaris-app/crm/src/lib/records";

const can = { read: true, edit: true, delete: true };
const actor = {
    shelf: { orgId: null, userId: "u1", key: "user:u1" },
    can: { companies: can, people: can, opportunities: can }
} as never;

function savedPosition(): unknown {
    const [call] = delegate.updateMany.mock.calls as unknown as [{ data: { position: number } }][];
    return call?.[0].data.position;
}

describe("moveRecord", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delegate.findFirst.mockResolvedValue(null);
    });

    it("keeps the place it was given between loaded neighbours", async () => {
        await moveRecord(actor, "opportunities", "o1", {
            key: "stage",
            value: "meeting",
            position: 4.5
        }).catch(() => undefined);
        expect(savedPosition()).toBe(4.5);
    });

    it("goes past the last card of the column when the board has not loaded it", async () => {
        delegate.findFirst.mockResolvedValueOnce({ position: 120 });
        await moveRecord(actor, "opportunities", "o1", {
            key: "stage",
            value: "meeting",
            position: 51,
            last: true
        }).catch(() => undefined);
        expect(savedPosition()).toBe(121);
        const [query] = delegate.findFirst.mock.calls[0] as unknown as [
            { where: Record<string, unknown>; orderBy: unknown }
        ];
        expect(query.orderBy).toEqual({ position: "desc" });
        expect(query.where).toMatchObject({ id: { not: "o1" }, deletedAt: null });
        expect(JSON.stringify(query.where)).toContain('"stage":"meeting"');
    });

    it("keeps its own place in an empty column", async () => {
        await moveRecord(actor, "opportunities", "o1", {
            key: "stage",
            value: "meeting",
            position: 0,
            last: true
        }).catch(() => undefined);
        expect(savedPosition()).toBe(0);
    });
});
