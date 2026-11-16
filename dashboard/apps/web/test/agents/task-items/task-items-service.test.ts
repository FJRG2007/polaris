/**
 * The Tasks link's service: the sweep moves an item to where its session is,
 * stops for good once a person moves it, writes only as somebody who may still
 * edit the item, and a run's new worker takes only that run's own plan item.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
    links: [] as Row[],
    items: [] as Row[],
    statuses: [] as Row[],
    sessions: [] as Row[],
    orchestrated: [] as Row[],
    runs: [] as Row[],
    pulls: new Map<string, Row[]>(),
    // What each session state derives to here.
    derived: {} as Record<string, string>,
    writable: new Set<string>(),
    lists: new Set<string>(),
    updates: [] as Array<{ taskId: string; statusId: string }>,
    created: [] as Row[]
}));

function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (value && typeof value === "object" && "in" in (value as Row)) {
            return ((value as { in: unknown[] }).in).includes(row[key]);
        }
        return row[key] === value;
    });
}

function table(rows: () => Row[]) {
    return {
        findMany: vi.fn(async ({ where = {} }: { where?: Row } = {}) => rows().filter((row) => matches(row, where))),
        findUnique: vi.fn(async ({ where }: { where: Row }) => rows().find((row) => matches(row, where)) ?? null),
        count: vi.fn(async ({ where }: { where: Row }) => rows().filter((row) => matches(row, where)).length),
        updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
            const hit = rows().filter((row) => matches(row, where));
            for (const row of hit) Object.assign(row, data);
            return { count: hit.length };
        }),
        deleteMany: vi.fn(async ({ where }: { where: Row }) => {
            const keep = rows().filter((row) => !matches(row, where));
            const count = rows().length - keep.length;
            rows().splice(0, rows().length, ...keep);
            return { count };
        })
    };
}

const prisma = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("@/lib/tasks/access", () => ({
    requireTask: async (_actor: unknown, taskId: string) => {
        if (!db.writable.has(taskId)) throw new Error("no access");
        return { taskId };
    },
    requireList: async (_actor: unknown, listId: string) => {
        if (!db.lists.has(listId)) throw new Error("no access");
        return { listId, spaceId: "space-1" };
    }
}));
vi.mock("@/lib/tasks/task-service", () => ({
    updateTask: async (_actor: string, input: { taskId: string; statusId: string }) => {
        db.updates.push(input);
        const item = db.items.find((row) => row.id === input.taskId);
        if (item) item.statusId = input.statusId;
    },
    createTask: async (_actor: string, spaceId: string, input: Row) => {
        const id = `0190c6a0-0000-7000-8000-0000000009${String(db.items.length).padStart(2, "0")}`;
        db.items.push({ id, spaceId, statusId: "0190c6a0-0000-7000-8000-0000000000b1" });
        db.writable.add(id);
        db.created.push(input);
        return { id, reference: "ENG-9" };
    }
}));
vi.mock("@/lib/tasks/live", () => ({ publishTaskChange: () => undefined }));
vi.mock("@/lib/agents/session-pr-facts", () => ({
    readSessionPullRows: async () => db.pulls,
    pullFactsOf: (row: Row) => row
}));
// The derivation has its own tests; here each state derives to what a test says.
vi.mock("@/lib/agents/session-status", () => ({
    sessionFactsFrom: (row: Row) => row,
    deriveSessionStatus: (facts: Row) => db.derived[facts.state as string]
}));

Object.assign(prisma, {
    taskAgentLink: {
        ...table(() => db.links),
        create: vi.fn(async ({ data }: { data: Row }) => {
            db.links.push({ id: `link-${db.links.length + 1}`, held: false, settled: false, createdAt: new Date(), ...data });
            return {};
        }),
        upsert: vi.fn(async ({ where, create }: { where: Row; create: Row }) => {
            if (!db.links.some((row) => matches(row, where))) {
                db.links.push({ id: `link-${db.links.length + 1}`, held: false, settled: false, createdAt: new Date(), ...create });
            }
            return {};
        })
    },
    task: table(() => db.items),
    taskStatus: table(() => db.statuses),
    agentSession: table(() => db.sessions),
    agentOrchestrationTask: table(() => db.orchestrated),
    agentOrchestrationRun: table(() => db.runs)
});

const items = await import("@/lib/agents/task-items");

const ITEM = "0190c6a0-0000-7000-8000-000000000001";
const RUN = "0190c6a0-0000-7000-8000-0000000000aa";

function link(extra: Row = {}): Row {
    return {
        id: "link-1",
        itemId: ITEM,
        ownerId: "u1",
        sessionId: "s1",
        runId: null,
        orchestrationTaskId: null,
        appliedStatusId: "0190c6a0-0000-7000-8000-0000000000b1",
        held: false,
        settled: false,
        createdAt: new Date(),
        ...extra
    };
}

beforeEach(() => {
    db.links = [];
    db.items = [{ id: ITEM, spaceId: "space-1", statusId: "0190c6a0-0000-7000-8000-0000000000b1" }];
    db.statuses = [
        { id: "0190c6a0-0000-7000-8000-0000000000b1", spaceId: "space-1", type: "open", order: 1 },
        { id: "0190c6a0-0000-7000-8000-0000000000b2", spaceId: "space-1", type: "active", order: 2 },
        { id: "0190c6a0-0000-7000-8000-0000000000b3", spaceId: "space-1", type: "blocked", order: 3 },
        { id: "0190c6a0-0000-7000-8000-0000000000b4", spaceId: "space-1", type: "done", order: 4 }
    ];
    db.sessions = [{ id: "s1", state: "running" }];
    db.derived = { running: "working", stopped: "terminated" };
    db.orchestrated = [];
    db.runs = [];
    db.pulls = new Map();
    db.writable = new Set([ITEM]);
    db.lists = new Set();
    db.updates = [];
    db.created = [];
});

describe("syncTaskItems", () => {
    it("moves the item to the session's status and remembers what it wrote", async () => {
        db.links = [link()];
        await items.syncTaskItems();
        expect(db.updates).toEqual([{ taskId: ITEM, statusId: "0190c6a0-0000-7000-8000-0000000000b2" }]);
        expect(db.links[0]).toMatchObject({ appliedStatusId: "0190c6a0-0000-7000-8000-0000000000b2", lastStatus: "working", settled: false });
    });

    it("follows a session through needing a person to being merged, then stops reading it", async () => {
        db.links = [link()];
        db.derived.running = "needs_input";
        await items.syncTaskItems();
        expect(db.items[0]!.statusId).toBe("0190c6a0-0000-7000-8000-0000000000b3");
        db.derived.running = "merged";
        await items.syncTaskItems();
        expect(db.items[0]!.statusId).toBe("0190c6a0-0000-7000-8000-0000000000b4");
        expect(db.links[0]!.settled).toBe(true);
    });

    it("never overwrites a status a person set after the link was made", async () => {
        db.links = [link()];
        db.items[0]!.statusId = "0190c6a0-0000-7000-8000-0000000000b4";
        await items.syncTaskItems();
        expect(db.updates).toEqual([]);
        expect(db.links[0]!.held).toBe(true);
        // Held for good: the next sweep does not even read it.
        db.items[0]!.statusId = "0190c6a0-0000-7000-8000-0000000000b1";
        await items.syncTaskItems();
        expect(db.updates).toEqual([]);
    });

    it("writes nothing for somebody who can no longer edit the item", async () => {
        db.links = [link()];
        db.writable.clear();
        await items.syncTaskItems();
        expect(db.updates).toEqual([]);
        expect(db.links[0]!.settled).toBe(true);
    });

    it("drops the link of an item that was deleted", async () => {
        db.links = [link()];
        db.items = [];
        await items.syncTaskItems();
        expect(db.links).toEqual([]);
    });

    it("follows a run's worker through its orchestration task, and settles a plan item when the run ends", async () => {
        db.links = [
            link({ sessionId: null, runId: RUN, orchestrationTaskId: "ot-1" }),
            link({ id: "link-2", itemId: "other", sessionId: null, runId: RUN, orchestrationTaskId: null })
        ];
        db.items.push({ id: "other", spaceId: "space-1", statusId: "0190c6a0-0000-7000-8000-0000000000b1" });
        db.orchestrated = [{ id: "ot-1", sessionId: "s1" }];
        db.runs = [{ id: RUN, status: "completed" }];
        await items.syncTaskItems();
        expect(db.updates).toEqual([{ taskId: ITEM, statusId: "0190c6a0-0000-7000-8000-0000000000b2" }]);
        expect(db.links[1]!.settled).toBe(true);
    });

    it("leaves the item where it is when the session ended unmerged", async () => {
        db.links = [link()];
        db.sessions[0] = { id: "s1", state: "stopped" };
        await items.syncTaskItems();
        expect(db.updates).toEqual([]);
        expect(db.links[0]!.settled).toBe(true);
    });
});

describe("linkItem", () => {
    it("links at the item's current status, and refuses an item the person cannot edit", async () => {
        expect(await items.linkItem({ ownerId: "u1", itemId: ITEM, sessionId: "s1" })).toBe(true);
        expect(db.links[0]).toMatchObject({ itemId: ITEM, sessionId: "s1", appliedStatusId: "0190c6a0-0000-7000-8000-0000000000b1" });
        db.writable.clear();
        expect(await items.linkItem({ ownerId: "u1", itemId: ITEM, sessionId: "s2" })).toBe(false);
        expect(db.links).toHaveLength(1);
    });
});

describe("writeRunItems", () => {
    it("lets a worker take its own run's plan item and nothing else", async () => {
        db.links = [link({ sessionId: null, runId: RUN, orchestrationTaskId: null })];
        db.items.push({ id: "foreign", spaceId: "space-1", statusId: "0190c6a0-0000-7000-8000-0000000000b1" });
        await items.writeRunItems({ id: RUN, ownerId: "u1", taskListId: null }, [
            { id: "ot-1", title: "Fix", spec: "Fix it", itemId: ITEM },
            { id: "ot-2", title: "Other", spec: "Other", itemId: "foreign" }
        ]);
        expect(db.links[0]!.orchestrationTaskId).toBe("ot-1");
        // No list: the foreign id is ignored rather than linked.
        expect(db.links).toHaveLength(1);
    });

    it("writes a worker with no plan item into the run's list as a new item", async () => {
        db.lists.add("0190c6a0-0000-7000-8000-0000000000c1");
        await items.writeRunItems({ id: RUN, ownerId: "u1", taskListId: "0190c6a0-0000-7000-8000-0000000000c1" }, [
            { id: "ot-3", title: "Extra worker", spec: "Do the extra", itemId: null }
        ]);
        expect(db.created).toEqual([expect.objectContaining({ listId: "0190c6a0-0000-7000-8000-0000000000c1", name: "Extra worker", description: "Do the extra" })]);
        expect(db.links).toEqual([expect.objectContaining({ runId: RUN, orchestrationTaskId: "ot-3" })]);
    });

    it("writes no item into a list the person cannot edit", async () => {
        await items.writeRunItems({ id: RUN, ownerId: "u1", taskListId: "0190c6a0-0000-7000-8000-0000000000c1" }, [
            { id: "ot-4", title: "Extra", spec: "x", itemId: null }
        ]);
        expect(db.created).toEqual([]);
        expect(db.links).toEqual([]);
    });
});
