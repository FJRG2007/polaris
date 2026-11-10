/**
 * Users affected per issue: which identity an event's user context counts as,
 * that the stored form is a hash and never the value, that one person counts
 * once however many times they hit it, and that the list can sort by it.
 */

import * as core from "@polaris/core";
import { createHash } from "node:crypto";
import type { CapturedEvent } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueUsers = new Set<string>();
const issueUpdate = vi.fn(async (_args: unknown) => ({}));
const createMany = vi.fn(async (args: { data: { issueId: string; userHash: string }[] }) => {
    let count = 0;
    for (const row of args.data) {
        const key = `${row.issueId}:${row.userHash}`;
        if (!issueUsers.has(key)) {
            issueUsers.add(key);
            count += 1;
        }
    }
    return { count };
});
const evaluateAlerts = vi.fn(async (_signal: unknown) => 0);
let existing: { id: string; status: string; resolvedInRelease: string | null; lastSeen: Date } | null = null;
let upsertTimes = 1;

vi.mock("@polaris/db", () => ({
    prisma: {
        telemetryIssue: {
            findUnique: async () => existing,
            upsert: async () => ({ id: "i1", timesSeen: upsertTimes }),
            update: issueUpdate
        },
        telemetryIssueUser: { createMany },
        telemetryEvent: { create: async () => ({}) },
        telemetryDay: { upsert: async () => ({}) },
        telemetryProject: { updateMany: async () => ({ count: 0 }) }
    }
}));
vi.mock("@/lib/telemetry/alerts", () => ({ evaluateAlerts }));

const store = await import("../../src/lib/telemetry/store");
const { issueOrder, ISSUE_SORTS } = await import("../../src/lib/telemetry/issue-query");

const AT = new Date("2026-11-01T10:00:00.000Z");

function event(over: Partial<CapturedEvent> = {}): CapturedEvent {
    return {
        eventId: null,
        level: "error",
        type: "TypeError",
        value: "boom",
        culprit: "",
        platform: "node",
        release: "1.0.0",
        environment: "production",
        serverName: null,
        transaction: null,
        url: null,
        method: null,
        user: null,
        userKey: null,
        tags: {},
        frames: [],
        breadcrumbs: [],
        contexts: [],
        request: null,
        sdk: null,
        ip: null,
        at: AT,
        fingerprint: "f1",
        ...over
    };
}

/** Let the un-awaited alert evaluation run. */
async function settle(): Promise<void> {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
    issueUsers.clear();
    issueUpdate.mockClear();
    createMany.mockClear();
    evaluateAlerts.mockClear();
    existing = null;
    upsertTimes = 1;
});

describe("userKeyOf", () => {
    it("prefers the id, then the email, then the address", () => {
        expect(core.userKeyOf({ id: "u-7", email: "a@b.c", ip_address: "10.0.0.1" })).toBe("id:u-7");
        expect(core.userKeyOf({ email: " A@B.C ", ip_address: "10.0.0.1" })).toBe("email:a@b.c");
        expect(core.userKeyOf({ ip_address: "10.0.0.1" })).toBe("ip:10.0.0.1");
    });

    it("counts a numeric id as the same person as its string", () => {
        expect(core.userKeyOf({ id: 7 })).toBe(core.userKeyOf({ id: "7" }));
    });

    it("names nobody for an empty context or the SDK's auto placeholder", () => {
        expect(core.userKeyOf({})).toBeNull();
        expect(core.userKeyOf({ id: "  ", email: "" })).toBeNull();
        expect(core.userKeyOf({ ip_address: "{{auto}}" })).toBeNull();
    });

    it("is read off a Sentry payload", () => {
        const read = core.readEvent(
            { exception: { values: [{ type: "Error", value: "x" }] }, user: { id: 42, username: "ana" } },
            AT
        );
        expect(read?.userKey).toBe("id:42");
        expect(read?.user).toBe("ana");
    });
});

describe("counting people per issue", () => {
    it("stores a hash, never the identity, and counts a person once", async () => {
        await store.captureEvent({ id: "p1", platform: "node" }, event({ userKey: "email:a@b.c" }));
        await store.captureEvent({ id: "p1", platform: "node" }, event({ userKey: "email:a@b.c" }));

        const hash = createHash("sha256").update("email:a@b.c", "utf8").digest("hex");
        expect(createMany).toHaveBeenCalledTimes(2);
        expect(createMany.mock.calls[0]?.[0]).toEqual({
            data: [{ issueId: "i1", userHash: hash }],
            skipDuplicates: true
        });
        expect(JSON.stringify(createMany.mock.calls)).not.toContain("a@b.c");
        const increments = issueUpdate.mock.calls.filter((call) =>
            JSON.stringify(call[0]).includes("userCount")
        );
        expect(increments).toHaveLength(1);
        expect(increments[0]?.[0]).toEqual({ where: { id: "i1" }, data: { userCount: { increment: 1 } } });
    });

    it("counts a second person", async () => {
        await store.captureEvent({ id: "p1", platform: "node" }, event({ userKey: "id:1" }));
        await store.captureEvent({ id: "p1", platform: "node" }, event({ userKey: "id:2" }));
        const increments = issueUpdate.mock.calls.filter((call) => JSON.stringify(call[0]).includes("userCount"));
        expect(increments).toHaveLength(2);
    });

    it("writes nothing for an event that names nobody", async () => {
        await store.captureEvent({ id: "p1", platform: "node" }, event());
        expect(createMany).not.toHaveBeenCalled();
    });

    it("hands the alert rules what the event did to its issue", async () => {
        await store.captureEvent({ id: "p1", platform: "node" }, event());
        await settle();
        expect(evaluateAlerts).toHaveBeenCalledWith(
            expect.objectContaining({ projectId: "p1", issueId: "i1", isNew: true, regressed: false })
        );

        evaluateAlerts.mockClear();
        existing = { id: "i1", status: "resolved", resolvedInRelease: "0.9.0", lastSeen: AT };
        await store.captureEvent({ id: "p1", platform: "node" }, event({ release: "1.0.0" }));
        await settle();
        expect(evaluateAlerts).toHaveBeenCalledWith(
            expect.objectContaining({ isNew: false, regressed: true, level: "error", environment: "production" })
        );
    });

    it("does not call an issue new when it lost the race to open it", async () => {
        upsertTimes = 2;
        await store.captureEvent({ id: "p1", platform: "node" }, event());
        await settle();
        expect(evaluateAlerts).toHaveBeenCalledWith(expect.objectContaining({ isNew: false }));
    });
});

describe("sorting by users", () => {
    it("is offered and orders by the stored count", () => {
        expect(ISSUE_SORTS).toContain("users");
        expect(issueOrder("users")).toEqual([{ userCount: "desc" }, { id: "desc" }]);
    });
});
