/**
 * Notes and tasks on a record: what the record links to is read through Notes
 * and Tasks, so only what the reader may open comes back; a note or task made
 * from a record is made there and linked here, never on a record in the trash
 * or by somebody who may not change it; and only a task the record links to
 * can be ticked off from it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NOTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LIST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RECORD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FILE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CONNECTION = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const db = vi.hoisted(() => ({
    records: {
        count: vi.fn(async () => 1),
        findMany: vi.fn(async (): Promise<{ email: string }[]> => []),
        findFirst: vi.fn(
            async (): Promise<{
                companyId: string | null;
                pointOfContactId: string | null;
            } | null> => null
        )
    },
    crmLink: {
        findMany: vi.fn(async (): Promise<{ targetId: string }[]> => []),
        count: vi.fn(async () => 1),
        createMany: vi.fn(async () => ({ count: 1 })),
        deleteMany: vi.fn(async () => ({ count: 1 }))
    }
}));

const crmHost = vi.hoisted(() => ({
    crmReach: vi.fn(async () => ({ notes: true, tasks: true })),
    crmNoteShelves: vi.fn(async (): Promise<unknown> => [{ id: null, name: "" }]),
    crmNotesByIds: vi.fn(async (_actor: unknown, ids: string[]) =>
        ids.map((id) => ({
            id,
            title: "Kickoff",
            excerpt: "",
            updatedAt: "2026-10-01T10:00:00.000Z"
        }))
    ),
    crmCreateNote: vi.fn(async (): Promise<unknown> => ({ id: NOTE })),
    taskListsFor: vi.fn(async () => [{ id: LIST, name: "Sales", spaceName: "Team" }]),
    tasksByIds: vi.fn(async (_actor: unknown, ids: string[]) =>
        ids.map((id) => ({
            id,
            name: "Call back",
            reference: "T-1",
            due: null,
            timed: false,
            done: false,
            listName: "Sales",
            statusType: "open",
            statusColor: "#000000",
            statusName: "Open"
        }))
    ),
    createTask: vi.fn(async (): Promise<unknown> => ({ id: TASK, reference: "T-1" })),
    setTaskDone: vi.fn(async () => ({})),
    crmDriveFileRef: vi.fn(async (): Promise<unknown> => ({ id: FILE, name: "deck.pdf" })),
    crmMailWith: vi.fn(async (): Promise<unknown> => []),
    crmEventsWith: vi.fn(async (): Promise<unknown> => []),
    crmDriveFiles: vi.fn(async (_actor: unknown, ids: string[]) =>
        ids.map((id) => ({ id, name: "deck.pdf", href: `/drive/open?c=x&p=deck.pdf` }))
    )
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        crmCompany: db.records,
        crmPerson: db.records,
        crmOpportunity: db.records,
        crmLink: db.crmLink
    },
    Prisma: { Decimal: class {} }
}));
vi.mock("@polaris/app-host", () => ({
    host: { crmHost, i18nRequest: { getLocale: async () => "en-US" } }
}));

import * as activities from "@polaris-app/crm/src/lib/activities";
import { dueAt, newTaskSchema } from "@polaris-app/crm/src/model/links";

const allowed = { read: true, edit: true, delete: true };
const reader = { read: true, edit: false, delete: false };
const actorWith = (can: typeof allowed) =>
    ({
        user: { id: "u1", name: "Test User", isAdmin: false },
        shelf: { orgId: "o1", userId: null, key: "org:o1" },
        can: { companies: can, people: can, opportunities: can }
    }) as never;
const caller = { id: "u1", isAdmin: false };

beforeEach(() => vi.clearAllMocks());

describe("notes and tasks on a record", () => {
    it("reads the linked ids through Notes and Tasks, newest link first", async () => {
        db.crmLink.findMany
            .mockResolvedValueOnce([{ targetId: NOTE }])
            .mockResolvedValueOnce([{ targetId: TASK }]);
        const opened = await activities.openActivities(actorWith(allowed), "companies", RECORD);
        expect(db.crmLink.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { orgId: "o1", object: "companies", recordId: RECORD, kind: "note" },
                orderBy: { id: "desc" },
                take: 50
            })
        );
        expect(crmHost.crmNotesByIds).toHaveBeenCalledWith(caller, [NOTE]);
        expect(opened.notes).toEqual([expect.objectContaining({ id: NOTE, title: "Kickoff" })]);
        expect(opened.tasks).toEqual([
            {
                id: TASK,
                name: "Call back",
                reference: "T-1",
                due: null,
                done: false,
                listName: "Sales"
            }
        ]);
        expect(opened.taskLists).toHaveLength(1);
    });

    it("offers a reader who may not edit nowhere to add, and no notes without Notes", async () => {
        crmHost.crmReach.mockResolvedValueOnce({ notes: false, tasks: true });
        const opened = await activities.openActivities(actorWith(reader), "companies", RECORD);
        expect(opened.notes).toBeNull();
        expect(opened.noteShelves).toEqual([]);
        expect(opened.taskLists).toEqual([]);
        expect(crmHost.crmNotesByIds).not.toHaveBeenCalled();
        expect(crmHost.crmNoteShelves).not.toHaveBeenCalled();
        expect(crmHost.taskListsFor).not.toHaveBeenCalled();
    });

    it("leaves tasks out, rather than empty, for a reader without Tasks", async () => {
        crmHost.crmReach.mockResolvedValueOnce({ notes: true, tasks: false });
        db.crmLink.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ targetId: TASK }]);
        const opened = await activities.openActivities(actorWith(allowed), "companies", RECORD);
        expect(opened.tasks).toBeNull();
        expect(crmHost.tasksByIds).not.toHaveBeenCalled();
    });

    it("offers no Notes shelf to an editor without Notes", async () => {
        crmHost.crmReach.mockResolvedValueOnce({ notes: false, tasks: true });
        const opened = await activities.openActivities(actorWith(allowed), "companies", RECORD);
        expect(opened.notes).toBeNull();
        expect(opened.noteShelves).toEqual([]);
    });

    it("writes a note in Notes and links it", async () => {
        const note = await activities.createRecordNote(actorWith(allowed), "companies", RECORD, {
            title: "Kickoff",
            body: "",
            spaceId: null
        });
        expect(note.id).toBe(NOTE);
        expect(db.crmLink.createMany).toHaveBeenCalledWith({
            data: [
                expect.objectContaining({
                    orgId: "o1",
                    object: "companies",
                    recordId: RECORD,
                    kind: "note",
                    targetId: NOTE,
                    createdById: "u1"
                })
            ],
            skipDuplicates: true
        });
    });

    it("passes on a refusal from Notes and links nothing", async () => {
        crmHost.crmCreateNote.mockResolvedValueOnce({
            refused: "You cannot make that change here"
        });
        await expect(
            activities.createRecordNote(actorWith(allowed), "companies", RECORD, {
                title: "Kickoff",
                body: "",
                spaceId: LIST
            })
        ).rejects.toThrow("You cannot make that change here");
        expect(db.crmLink.createMany).not.toHaveBeenCalled();
    });

    it("makes a task due on a day, and links it", async () => {
        const task = await activities.createRecordTask(actorWith(allowed), "people", RECORD, {
            name: "Call back",
            listId: LIST,
            due: "2026-11-02"
        });
        expect(task.id).toBe(TASK);
        expect(crmHost.createTask).toHaveBeenCalledWith(caller, {
            listId: LIST,
            name: "Call back",
            due: { at: "2026-11-02T00:00:00.000Z", timed: false }
        });
        expect(db.crmLink.createMany).toHaveBeenCalledTimes(1);
    });

    it("adds nothing to a record in the trash, or for somebody who may not edit", async () => {
        db.records.count.mockResolvedValueOnce(0);
        const input = { name: "Call back", listId: LIST, due: null };
        await expect(
            activities.createRecordTask(actorWith(allowed), "people", RECORD, input)
        ).rejects.toThrow();
        await expect(
            activities.createRecordTask(actorWith(reader), "people", RECORD, input)
        ).rejects.toThrow();
        expect(crmHost.createTask).not.toHaveBeenCalled();
    });

    it("looks the record up among the reader's own when their role is held to those", async () => {
        const ownOnly = {
            user: { id: "u1", name: "Test User", isAdmin: false },
            shelf: { orgId: "o1", userId: null, key: "org:o1" },
            can: { companies: allowed, people: allowed, opportunities: allowed },
            rules: {
                companies: { rows: "own", hidden: [], readOnly: [] },
                people: { rows: "own", hidden: [], readOnly: [] },
                opportunities: { rows: "own", hidden: [], readOnly: [] }
            }
        } as never;
        db.records.count.mockResolvedValueOnce(0);
        await expect(
            activities.createRecordTask(ownOnly, "people", RECORD, {
                name: "Call back",
                listId: LIST,
                due: null
            })
        ).rejects.toThrow();
        expect(db.records.count).toHaveBeenCalledWith({
            where: { id: RECORD, orgId: "o1", AND: [{ createdById: "u1" }], deletedAt: null }
        });
        expect(crmHost.createTask).not.toHaveBeenCalled();
    });

    it("ticks off only a task the record links to", async () => {
        db.crmLink.count.mockResolvedValueOnce(0);
        await expect(
            activities.setRecordTaskDone(actorWith(allowed), "companies", RECORD, TASK, true)
        ).rejects.toThrow();
        expect(crmHost.setTaskDone).not.toHaveBeenCalled();
        await activities.setRecordTaskDone(actorWith(allowed), "companies", RECORD, TASK, true);
        expect(crmHost.setTaskDone).toHaveBeenCalledWith(caller, TASK, true);
    });
});

describe("a new task's input", () => {
    it("takes a day or none, and refuses anything else", () => {
        const base = { name: " Call back ", listId: LIST };
        expect(newTaskSchema.parse({ ...base, due: null })).toEqual({
            name: "Call back",
            listId: LIST,
            due: null
        });
        expect(newTaskSchema.safeParse({ ...base, due: "2026-13-45" }).success).toBe(false);
        expect(newTaskSchema.safeParse({ ...base, due: "2026-02-31" }).success).toBe(false);
        expect(newTaskSchema.safeParse({ ...base, due: "tomorrow" }).success).toBe(false);
        expect(newTaskSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
        expect(dueAt(null)).toBeNull();
    });
});

describe("Drive files on a record", () => {
    it("lists the linked files the reader may still open", async () => {
        db.crmLink.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ targetId: FILE }]);
        const opened = await activities.openActivities(actorWith(allowed), "companies", RECORD);
        expect(crmHost.crmDriveFiles).toHaveBeenCalledWith(caller, [FILE]);
        expect(opened.files).toEqual([
            { id: FILE, name: "deck.pdf", href: "/drive/open?c=x&p=deck.pdf" }
        ]);
    });

    it("links a picked file where it is, and refuses one the reader cannot open", async () => {
        const file = await activities.attachRecordFile(actorWith(allowed), "companies", RECORD, {
            connectionId: CONNECTION,
            path: "decks/deck.pdf"
        });
        expect(file.id).toBe(FILE);
        expect(crmHost.crmDriveFileRef).toHaveBeenCalledWith(caller, CONNECTION, "decks/deck.pdf");
        expect(db.crmLink.createMany).toHaveBeenCalledWith({
            data: [expect.objectContaining({ kind: "file", targetId: FILE, recordId: RECORD })],
            skipDuplicates: true
        });

        vi.clearAllMocks();
        crmHost.crmDriveFileRef.mockResolvedValueOnce({ refused: true });
        await expect(
            activities.attachRecordFile(actorWith(allowed), "companies", RECORD, {
                connectionId: CONNECTION,
                path: "secret.pdf"
            })
        ).rejects.toThrow();
        expect(db.crmLink.createMany).not.toHaveBeenCalled();
    });

    it("lets nobody who may not edit attach a file", async () => {
        await expect(
            activities.attachRecordFile(actorWith(reader), "companies", RECORD, {
                connectionId: CONNECTION,
                path: "deck.pdf"
            })
        ).rejects.toThrow();
        expect(crmHost.crmDriveFileRef).not.toHaveBeenCalled();
    });
});

describe("mail and meetings on a record", () => {
    const thread = {
        id: "t1",
        subject: "Renewal",
        snippet: "",
        participants: [{ name: "Fixture Contact", address: "contact@example.test" }],
        messageCount: 2,
        lastMessageAt: "2026-10-01T10:00:00.000Z",
        href: "/mail/t/t1"
    };

    it("finds a person's mail and meetings by their address", async () => {
        db.records.findMany.mockResolvedValueOnce([{ email: "contact@example.test" }]);
        crmHost.crmMailWith.mockResolvedValueOnce([thread]);
        const opened = await activities.openActivities(actorWith(allowed), "people", RECORD);
        expect(db.records.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    AND: [{ orgId: "o1" }, { id: RECORD }, { deletedAt: null, NOT: { email: "" } }]
                }
            })
        );
        expect(crmHost.crmMailWith).toHaveBeenCalledWith(caller, ["contact@example.test"], 20);
        expect(crmHost.crmEventsWith).toHaveBeenCalledWith(caller, ["contact@example.test"], 20);
        expect(opened.mail).toEqual([thread]);
        expect(opened.events).toEqual([]);
    });

    it("reads a company's through its people, and an opportunity's through its contact", async () => {
        await activities.openActivities(actorWith(allowed), "companies", RECORD);
        expect(db.records.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    AND: expect.arrayContaining([{ companyId: RECORD }])
                })
            })
        );
        db.records.findFirst.mockResolvedValueOnce({ companyId: null, pointOfContactId: "p1" });
        await activities.openActivities(actorWith(allowed), "opportunities", RECORD);
        expect(db.records.findMany).toHaveBeenLastCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    AND: expect.arrayContaining([{ OR: [{ id: "p1" }] }])
                })
            })
        );
    });

    it("looks nothing up when the reader's role hides people's email", async () => {
        const actor = {
            ...(actorWith(allowed) as object),
            rules: {
                companies: { rows: "all", hidden: [], readOnly: [] },
                people: { rows: "all", hidden: ["email"], readOnly: [] },
                opportunities: { rows: "all", hidden: [], readOnly: [] }
            }
        } as never;
        await activities.openActivities(actor, "people", RECORD);
        expect(db.records.findMany).not.toHaveBeenCalled();
        expect(crmHost.crmMailWith).toHaveBeenCalledWith(caller, [], 20);
    });

    it("says nothing about mail to a reader without Mail", async () => {
        crmHost.crmMailWith.mockResolvedValueOnce(null);
        const opened = await activities.openActivities(actorWith(allowed), "people", RECORD);
        expect(opened.mail).toBeNull();
    });

    it("refuses a record the reader cannot reach", async () => {
        db.records.count.mockResolvedValueOnce(0);
        await expect(
            activities.openActivities(actorWith(allowed), "people", RECORD)
        ).rejects.toThrow();
        expect(crmHost.crmMailWith).not.toHaveBeenCalled();
    });
});
