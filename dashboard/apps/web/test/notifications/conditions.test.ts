/**
 * Condition-keyed notices: a checker on a clock raises the same problem every
 * run, and the reader must see one notice that stays current - not a bell of
 * copies. And when the problem ends, that notice is what says so.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { conditionStore } from "./fixtures/condition-store";

const store = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./fixtures/condition-store").conditionStore> | null }));

vi.mock("@polaris/db", () => ({
    prisma: {
        notification: {
            updateMany: (args: never) => store.current!.notification.updateMany(args),
            create: (args: never) => store.current!.notification.create(args),
            findMany: (args: never) => store.current!.notification.findMany(args)
        }
    }
}));
vi.mock("@/lib/shelf", () => ({ shelfFilter: () => ({}) }));

const { raiseCondition, resolveCondition, openConditions } = await import("../../src/lib/notification-service");

const notice = (title: string) => ({ userId: "u1", type: "domain.address-stale", title, level: "warning" as const });

beforeEach(() => {
    store.current = conditionStore();
});

describe("raiseCondition", () => {
    it("creates the notice once and rewrites it in place after that", async () => {
        expect(await raiseCondition("dns", notice("first"))).toBe("created");
        expect(await raiseCondition("dns", notice("second"))).toBe("updated");
        expect(await raiseCondition("dns", notice("third"))).toBe("updated");
        expect(store.current!.rows).toHaveLength(1);
        expect(store.current!.rows[0]).toMatchObject({ title: "third", conditionKey: "dns" });
        expect(store.current!.rows[0]!.updatedAt).toBeInstanceOf(Date);
    });

    it("leaves a notice the reader already read as read, unless it got worse", async () => {
        await raiseCondition("dns", notice("first"));
        store.current!.rows[0]!.readAt = new Date(1);
        await raiseCondition("dns", notice("still"));
        expect(store.current!.rows[0]!.readAt).toEqual(new Date(1));
        await raiseCondition("dns", notice("worse"), { resurface: true });
        expect(store.current!.rows[0]!.readAt).toBeNull();
    });

    it("keeps one row per reader and per condition", async () => {
        await raiseCondition("dns", notice("a"));
        await raiseCondition("dns", { ...notice("a"), userId: "u2" });
        await raiseCondition("other", notice("b"));
        expect(store.current!.rows).toHaveLength(3);
    });

    it("ends in one row when two checkers raise the same condition at once", async () => {
        const outcomes = await Promise.all([
            raiseCondition("dns", notice("one")),
            raiseCondition("dns", notice("two")),
            raiseCondition("dns", notice("three"))
        ]);
        expect(store.current!.rows).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome === "updated")).toHaveLength(2);
    });
});

describe("resolveCondition", () => {
    it("closes the open notice, rewritten with the recovery, and frees the key", async () => {
        await raiseCondition("dns", { ...notice("broken"), actionRequired: true });
        const closed = await resolveCondition("dns", { recovery: { title: "fixed", level: "success" } });
        expect(closed).toBe(1);
        expect(store.current!.rows[0]).toMatchObject({ title: "fixed", level: "success", conditionKey: null, actionRequired: false });
        expect(store.current!.rows[0]!.readAt).toBeInstanceOf(Date);
        // The next occurrence is a new notice, not the closed one reopened.
        expect(await raiseCondition("dns", notice("broken again"))).toBe("created");
        expect(store.current!.rows).toHaveLength(2);
    });

    it("is a no-op when nothing is open, and can be narrowed to some readers", async () => {
        expect(await resolveCondition("dns")).toBe(0);
        await raiseCondition("dns", notice("a"));
        await raiseCondition("dns", { ...notice("a"), userId: "u2" });
        expect(await resolveCondition("dns", { userIds: ["u2"] })).toBe(1);
        expect(store.current!.rows.find((row) => row.userId === "u1")!.conditionKey).toBe("dns");
    });

    it("lists what is still open under a prefix", async () => {
        await raiseCondition("svc:a", notice("a"));
        await raiseCondition("svc:b", notice("b"));
        await raiseCondition("other", notice("c"));
        await resolveCondition("svc:a");
        expect(await openConditions("u1", "svc:")).toEqual([
            { conditionKey: "svc:b", type: "domain.address-stale", metadata: {} }
        ]);
    });
});
