/**
 * The audit log on the server: the shelf's events newest first, a bounded page
 * at a time, narrowed as asked, only of the kinds of record the reader reaches
 * in full, with the fields their role hides left out, and the same as a CSV
 * file capped at a ceiling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    records: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    crmEvent: { findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []) }
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

import { auditObjects, exportAudit, listAudit } from "@polaris-app/crm/src/lib/audit";
import {
    AUDIT_EXPORT_LIMIT,
    AUDIT_PAGE,
    EMPTY_AUDIT_QUERY
} from "@polaris-app/crm/src/model/audit";

const can = (read: boolean) => ({ read, edit: read, delete: false });
const rule = (rows: "all" | "own", hidden: string[] = []) => ({ rows, hidden, readOnly: [] });
const actor = (rules?: Record<string, ReturnType<typeof rule>>, people = can(true)) =>
    ({
        user: { id: "u1", name: "Test User", isAdmin: false },
        shelf: { orgId: "o1", userId: null, key: "org:o1", orgName: "Example Org" },
        can: { companies: can(true), people, opportunities: can(true) },
        rules
    }) as never;

const RECORD = "00000000-0000-7000-8000-000000000001";
const event = (id: number, over: Record<string, unknown> = {}) => ({
    id: `00000000-0000-7000-8000-${String(id).padStart(12, "0")}`,
    object: "companies",
    recordId: RECORD,
    kind: "updated",
    actorId: "u1",
    changes: JSON.stringify([
        { key: "name", before: "Old Co", after: "New Co" },
        { key: "domain", before: null, after: "example.test" }
    ]),
    createdAt: new Date("2026-10-13T10:00:00Z"),
    ...over
});
const people = [{ id: "u1", name: "Test User" }];

function lastWhere(): Record<string, unknown> {
    const calls = db.crmEvent.findMany.mock.calls as unknown as [
        { where: Record<string, unknown> }
    ][];
    return calls[calls.length - 1]![0].where;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("auditObjects", () => {
    it("leaves out what the reader may not read and what their role keeps to their own records", () => {
        expect(auditObjects(actor())).toEqual(["companies", "people", "opportunities"]);
        expect(
            auditObjects(
                actor(
                    { companies: rule("all"), people: rule("all"), opportunities: rule("own") },
                    can(false)
                )
            )
        ).toEqual(["companies"]);
    });
});

describe("listAudit", () => {
    it("reads this shelf's events newest first, one past a page, and names the record and who", async () => {
        db.crmEvent.findMany.mockResolvedValueOnce([event(2), event(1)]);
        db.records.findMany.mockResolvedValueOnce([{ id: RECORD, name: "New Co" }]);
        const page = await listAudit(actor(), EMPTY_AUDIT_QUERY, people);
        const call = (
            db.crmEvent.findMany.mock.calls[0] as unknown as [Record<string, unknown>]
        )[0];
        expect(call).toMatchObject({ orderBy: { id: "desc" }, take: AUDIT_PAGE + 1 });
        expect(lastWhere()).toEqual({
            orgId: "o1",
            object: { in: ["companies", "people", "opportunities"] }
        });
        expect(page.next).toBeNull();
        expect(page.events[0]).toMatchObject({
            object: "companies",
            recordName: "New Co",
            actor: { id: "u1", name: "Test User" },
            at: "2026-10-13T10:00:00.000Z"
        });
        expect(page.events[1]!.changes).toHaveLength(2);
    });

    it("narrows by kind of record, what happened, who, the days and the cursor", async () => {
        await listAudit(
            actor(),
            {
                object: "people",
                kind: "trashed",
                actorId: "00000000-0000-4000-8000-000000000009",
                since: "2026-10-01T00:00:00.000Z",
                until: "2026-10-02T00:00:00.000Z",
                cursor: RECORD
            },
            people
        );
        expect(lastWhere()).toEqual({
            orgId: "o1",
            object: { in: ["people"] },
            kind: "trashed",
            actorId: "00000000-0000-4000-8000-000000000009",
            createdAt: {
                gte: new Date("2026-10-01T00:00:00.000Z"),
                lt: new Date("2026-10-02T00:00:00.000Z")
            },
            id: { lt: RECORD }
        });
    });

    it("reads nothing when the kind asked for is not the reader's to follow", async () => {
        const page = await listAudit(
            actor({ companies: rule("own"), people: rule("all"), opportunities: rule("all") }),
            { ...EMPTY_AUDIT_QUERY, object: "companies" },
            people
        );
        expect(page).toEqual({ events: [], next: null });
        expect(db.crmEvent.findMany).not.toHaveBeenCalled();
    });

    it("hides the fields the role hides, marks a record gone for good, and pages on", async () => {
        db.crmEvent.findMany.mockResolvedValueOnce(
            Array.from({ length: AUDIT_PAGE + 1 }, (_, index) =>
                event(AUDIT_PAGE + 1 - index, { actorId: null })
            )
        );
        const page = await listAudit(
            actor({
                companies: rule("all", ["domain"]),
                people: rule("all"),
                opportunities: rule("all")
            }),
            EMPTY_AUDIT_QUERY,
            people
        );
        expect(page.events).toHaveLength(AUDIT_PAGE);
        expect(page.next).toBe(page.events[AUDIT_PAGE - 1]!.id);
        expect(page.events[0]!.changes.map((change) => change.key)).toEqual(["name"]);
        expect(page.events[0]!.recordName).toBeNull();
        expect(page.events[0]!.actor).toBeNull();
    });
});

describe("exportAudit", () => {
    it("writes a line per change and says when the file was cut", async () => {
        db.crmEvent.findMany.mockImplementation(async (args: unknown) => {
            const { take } = args as { take: number };
            return Array.from({ length: take }, (_, index) => event(100_000 - index));
        });
        const file = await exportAudit(actor(), EMPTY_AUDIT_QUERY, people);
        expect(file.truncated).toBe(true);
        expect(file.rows).toBe(AUDIT_EXPORT_LIMIT);
        const lines = file.csv.trimEnd().split("\r\n");
        expect(lines[0]).toContain("When");
        expect(lines).toHaveLength(1 + AUDIT_EXPORT_LIMIT * 2);
        expect(lines[1]).toContain("Old Co");
    });
});
