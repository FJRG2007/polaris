/**
 * Every change to a record leaves a line on its timeline - what it was made
 * with, the fields an edit changed, a trip to the trash - on the reader's own
 * shelf, and a timeline is read a bounded page at a time, newest first. A log
 * that cannot be written never undoes the change.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    records: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 1 }))
    },
    crmEvent: {
        createMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async (): Promise<unknown[]> => [])
    }
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        crmCompany: db.records,
        crmPerson: db.records,
        crmOpportunity: db.records,
        crmField: { findMany: async () => [] },
        crmEvent: db.crmEvent
    },
    Prisma: { Decimal: class {} }
}));
vi.mock("@polaris/app-host", () => ({
    host: { crmHost: {}, i18nRequest: { getLocale: async () => "en-US" } }
}));

import { listTimeline } from "@polaris-app/crm/src/lib/timeline";
import { TIMELINE_PAGE } from "@polaris-app/crm/src/model/timeline";
import { createRecord, trashRecords, updateRecords } from "@polaris-app/crm/src/lib/records";

const can = { read: true, edit: true, delete: true };
const actor = {
    user: { id: "u1", name: "Test User" },
    shelf: { orgId: null, userId: "u1", key: "user:u1" },
    can: { companies: can, people: can, opportunities: can }
} as never;

const row = (id: string, city: string) => ({
    id,
    name: "Acme",
    city,
    domain: "",
    position: 0,
    deletedAt: null
});

type Logged = { data: { recordId: string; kind: string; changes: string; userId: string }[] };
const logged = () =>
    (db.crmEvent.createMany.mock.calls as unknown as [Logged][]).map(([call]) => call.data);

beforeEach(() => {
    vi.clearAllMocks();
});

describe("the record timeline", () => {
    it("logs the fields an edit changed, per record, on the reader's shelf", async () => {
        db.records.findMany
            .mockResolvedValueOnce([row("c1", "Madrid"), row("c2", "Lisbon")])
            .mockResolvedValueOnce([row("c1", "Lisbon"), row("c2", "Lisbon")]);
        await updateRecords(actor, "companies", ["c1", "c2"], { city: "Lisbon" });
        const [rows] = logged();
        // c2 already said Lisbon: nothing happened to it.
        expect(rows).toHaveLength(1);
        expect(rows![0]).toMatchObject({ recordId: "c1", kind: "updated", userId: "u1" });
        expect(JSON.parse(rows![0]!.changes)).toEqual([
            { key: "city", before: "Madrid", after: "Lisbon" }
        ]);
    });

    it("logs what a new record was made with", async () => {
        db.records.findFirst.mockResolvedValue(null);
        db.records.create.mockResolvedValue(row("c3", "Paris"));
        await createRecord(actor, "companies", { name: "Acme", city: "Paris" });
        const [rows] = logged();
        expect(rows![0]).toMatchObject({ recordId: "c3", kind: "created" });
        expect(JSON.parse(rows![0]!.changes)).toEqual([
            { key: "name", before: null, after: "Acme" },
            { key: "city", before: null, after: "Paris" }
        ]);
    });

    it("logs a trip to the trash only for the records that went", async () => {
        db.records.findMany.mockResolvedValueOnce([{ id: "c1" }]);
        expect(await trashRecords(actor, "companies", ["c1", "c9"])).toBe(1);
        expect(logged()[0]).toEqual([expect.objectContaining({ recordId: "c1", kind: "trashed" })]);
    });

    it("keeps the change when the log cannot be written", async () => {
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        db.crmEvent.createMany.mockRejectedValueOnce(new Error("down"));
        db.records.findMany
            .mockResolvedValueOnce([row("c1", "Madrid")])
            .mockResolvedValueOnce([row("c1", "Rome")]);
        const saved = await updateRecords(actor, "companies", ["c1"], { city: "Rome" });
        expect(saved[0]!.values.city).toBe("Rome");
        expect(quiet).toHaveBeenCalled();
        quiet.mockRestore();
    });

    it("reads a bounded page, newest first, and says where the next one starts", async () => {
        const rows = Array.from({ length: TIMELINE_PAGE + 1 }, (_, at) => ({
            id: `e${100 - at}`,
            kind: "updated",
            actorId: at === 0 ? "u1" : "gone",
            changes: "[]",
            createdAt: new Date("2026-10-01T10:00:00Z")
        }));
        db.crmEvent.findMany.mockResolvedValueOnce(rows);
        const page = await listTimeline(
            actor,
            "companies",
            "c1",
            [{ id: "u1", name: "Test User" }],
            "e200"
        );
        const [query] = db.crmEvent.findMany.mock.calls[0] as unknown as [
            { where: Record<string, unknown>; take: number; orderBy: unknown }
        ];
        expect(query.where).toEqual({
            userId: "u1",
            orgId: null,
            object: "companies",
            recordId: "c1",
            id: { lt: "e200" }
        });
        expect(query.take).toBe(TIMELINE_PAGE + 1);
        expect(query.orderBy).toEqual({ id: "desc" });
        expect(page.events).toHaveLength(TIMELINE_PAGE);
        expect(page.events[0]!.actor).toEqual({ id: "u1", name: "Test User" });
        expect(page.events[1]!.actor).toBeNull();
        expect(page.next).toBe(page.events[TIMELINE_PAGE - 1]!.id);
    });
});
