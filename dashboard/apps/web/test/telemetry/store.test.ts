/**
 * Writing down what a program said when it broke.
 *
 * The half worth pinning here is the one nobody would notice going wrong: a
 * fault somebody marked resolved has to come back on its own when it happens in
 * a later build, and must NOT come back on an event from the build it was
 * resolved in - those arrive for minutes afterwards from processes that have not
 * restarted yet, and reopening on them would make "resolve" a button that never
 * works.
 *
 * The rest is arithmetic that is easy to get subtly wrong: a day's count is one
 * row per issue per day, and an event that arrives late must not drag "last
 * seen" backwards.
 */

import type { CapturedEvent } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface IssueRow {
    id: string;
    status: string;
    resolvedInRelease: string | null;
    lastSeen: Date;
}

let issue: IssueRow | null = null;
const update = vi.fn(async (_args: unknown) => ({}));
const upsertIssue = vi.fn(async (_args: unknown) => ({ id: "i1" }));
const createEvent = vi.fn(async (_args: unknown) => ({}));
const upsertDay = vi.fn(async (_args: unknown) => ({}));

vi.mock("@polaris/db", () => ({
    prisma: {
        telemetryIssue: {
            findUnique: async () => issue,
            upsert: upsertIssue,
            update
        },
        telemetryEvent: { create: createEvent },
        telemetryDay: { upsert: upsertDay },
        telemetryProject: { updateMany: async () => ({ count: 0 }) }
    }
}));

const store = await import("../../src/lib/telemetry/store");

const AT = new Date("2026-09-04T13:20:00.000Z");

function event(over: Partial<CapturedEvent> = {}): CapturedEvent {
    return {
        eventId: "abc",
        level: "error",
        type: "TypeError",
        value: "boom",
        culprit: "deployApp (src/lib/deploy.ts:42)",
        platform: "node",
        release: "1.2.0",
        environment: "production",
        serverName: null,
        transaction: null,
        url: null,
        method: null,
        user: null,
        tags: {},
        frames: [],
        breadcrumbs: [],
        at: AT,
        fingerprint: "deadbeefdeadbeef",
        ...over
    };
}

const project = { id: "p1", platform: "node" };

/** What the update was asked to write, for the assertions below. */
function wrote(): Record<string, unknown> {
    return (update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
    vi.clearAllMocks();
    issue = null;
});

describe("a fault nobody has seen before", () => {
    it("opens an issue, stores the event and counts the day", async () => {
        await store.captureEvent(project, event());

        expect(upsertIssue).toHaveBeenCalledOnce();
        expect(createEvent).toHaveBeenCalledOnce();
        // Midnight UTC of the day it happened, so a count never moves when
        // somebody with another clock opens the screen.
        expect(upsertDay).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { issueId_day: { issueId: "i1", day: new Date("2026-09-04T00:00:00.000Z") } }
            })
        );
    });

    it("adopts the row somebody else wrote at the same instant", async () => {
        // On a crash loop two events of a brand-new fault at the same moment is
        // the normal case, not the rare one.
        await store.captureEvent(project, event());
        expect(upsertIssue).toHaveBeenCalledWith(
            expect.objectContaining({ update: expect.objectContaining({ timesSeen: { increment: 1 } }) })
        );
    });
});

describe("a fault that is already open", () => {
    beforeEach(() => {
        issue = { id: "i1", status: "unresolved", resolvedInRelease: null, lastSeen: AT };
    });

    it("counts it again", async () => {
        await store.captureEvent(project, event());
        expect(wrote().timesSeen).toEqual({ increment: 1 });
    });

    it("does not drag last-seen backwards for an event that arrived late", async () => {
        await store.captureEvent(project, event({ at: new Date("2026-09-04T09:00:00.000Z") }));
        expect(wrote().lastSeen).toBeUndefined();
        expect(wrote().timesSeen).toEqual({ increment: 1 });
    });

    it("moves it forward for a newer one", async () => {
        const later = new Date("2026-09-04T14:00:00.000Z");
        await store.captureEvent(project, event({ at: later }));
        expect(wrote().lastSeen).toEqual(later);
    });
});

describe("a fault somebody resolved", () => {
    it("stays resolved for an event from the release it was resolved in", async () => {
        // These keep arriving for minutes from processes that have not restarted.
        // Reopening on them makes Resolve a button that never works.
        issue = { id: "i1", status: "resolved", resolvedInRelease: "1.2.0", lastSeen: AT };
        await store.captureEvent(project, event({ release: "1.2.0" }));
        expect(wrote().status).toBeUndefined();
    });

    it("opens again when it happens in a later build", async () => {
        issue = { id: "i1", status: "resolved", resolvedInRelease: "1.2.0", lastSeen: AT };
        await store.captureEvent(project, event({ release: "1.3.0" }));
        expect(wrote()).toMatchObject({ status: "unresolved", resolvedAt: null, resolvedInRelease: null });
    });

    it("opens again when nobody was recording releases at all", async () => {
        // Without a release there is nothing to say the fix shipped, so the
        // honest answer to seeing it again is that it is back.
        issue = { id: "i1", status: "resolved", resolvedInRelease: null, lastSeen: AT };
        await store.captureEvent(project, event({ release: null }));
        expect(wrote().status).toBe("unresolved");
    });
});

describe("when the database will not answer", () => {
    it("says so and does not throw", async () => {
        // Every caller is either a request that must still answer 200 or an
        // exception handler. Throwing here replaces the crash being reported
        // with a crash in the reporting.
        const noise = vi.spyOn(console, "error").mockImplementation(() => undefined);
        createEvent.mockRejectedValueOnce(new Error("no connection"));
        await expect(store.captureEvent(project, event())).resolves.toBeUndefined();
        expect(noise).toHaveBeenCalled();
        noise.mockRestore();
    });
});
