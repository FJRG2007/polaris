// @vitest-environment jsdom

/**
 * The groups and privacy screens arrive in one round trip.
 *
 * Each used to paint its shell from the page request and then send a second
 * request - a server action - once the browser had hydrated, so a visit waited
 * on two trips back to back. The page now starts the read without awaiting it
 * and streams the answer in its own response; the action is only what a retry
 * or a refresh asks. The reads themselves are bounded: one settings query for
 * privacy, and a groups query plus one lateral preview query for groups, instead
 * of a nested take Prisma applied in memory over every membership.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const db = vi.hoisted(() => ({
    groupFindMany: vi.fn(),
    queryRaw: vi.fn(),
    settingFindMany: vi.fn(),
    settingFindUnique: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        group: { findMany: db.groupFindMany },
        setting: { findMany: db.settingFindMany, findUnique: db.settingFindUnique },
        $queryRaw: db.queryRaw
    }
}));
vi.mock("@/lib/session", () => ({
    requireAdmin: vi.fn(async () => ({ id: "admin-1", isAdmin: true }))
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: vi.fn(async () => (key: string) => key) }));

import { AfterPaint } from "@/components/after-paint";
import { readPrivacy } from "@/app/(app)/admin/privacy/read";
import { GROUPS_LIMIT, readGroupsAdmin } from "@/app/(app)/admin/groups/read";

const GROUP = "0190a000-0000-7000-8000-000000000001";
const EMPTY = "0190a000-0000-7000-8000-000000000002";

beforeEach(() => {
    sessionStorage.clear();
    for (const fn of Object.values(db)) fn.mockReset();
});
afterEach(() => cleanup());

describe("the groups read", () => {
    it("asks for bounded groups without a nested roster, then one preview query", async () => {
        db.groupFindMany.mockResolvedValue([
            { id: GROUP, name: "Ops", description: null, isSystem: false, _count: { members: 2 } },
            { id: EMPTY, name: "Empty", description: "x", isSystem: true, _count: { members: 0 } }
        ]);
        db.queryRaw.mockResolvedValue([
            { groupId: GROUP, id: "u1", name: "Ada", email: "ada@example.test" },
            { groupId: GROUP, id: "u2", name: "Grace", email: "grace@example.test" }
        ]);

        const rows = await readGroupsAdmin();

        const query = db.groupFindMany.mock.calls[0]![0];
        expect(query.take).toBe(GROUPS_LIMIT);
        expect(query.select.members).toBeUndefined();
        expect(db.queryRaw).toHaveBeenCalledTimes(1);
        expect(rows[0]!.members.items.map((user) => user.name)).toEqual(["Ada", "Grace"]);
        expect(rows[0]!.memberCount).toBe(2);
        expect(rows[1]!.members).toEqual({ items: [], next: null });
    });

    it("skips the preview query when there are no groups", async () => {
        db.groupFindMany.mockResolvedValue([]);
        expect(await readGroupsAdmin()).toEqual([]);
        expect(db.queryRaw).not.toHaveBeenCalled();
    });
});

describe("the privacy read", () => {
    it("reads the three settings in one query", async () => {
        db.settingFindMany.mockResolvedValue([{ key: "profiles.public", value: "true" }]);

        const data = await readPrivacy();

        expect(db.settingFindMany).toHaveBeenCalledTimes(1);
        expect(db.settingFindUnique).not.toHaveBeenCalled();
        expect(db.settingFindMany.mock.calls[0]![0].where.key.in).toHaveLength(3);
        expect(data.publicProfiles).toBe(true);
    });
});

describe("a region whose read the page streamed", () => {
    it("uses the streamed answer instead of asking again, and asks on retry only", async () => {
        const load = vi.fn(async () => ({ name: "Asked" }));
        let fail: (reason: Error) => void = () => undefined;
        const streamed = new Promise<{ name: string }>((_, reject) => (fail = reject));
        render(
            <AfterPaint cacheKey="test.streamed" load={load} streamed={streamed} skeleton={<p>waiting</p>}>
                {(data) => <p>{data.name}</p>}
            </AfterPaint>
        );
        expect(screen.getByText("waiting")).toBeTruthy();
        await act(async () => fail(new Error("gone")));
        expect(load).not.toHaveBeenCalled();
        expect(await screen.findByRole("alert")).toBeTruthy();

        await act(async () => fireEvent.click(screen.getByRole("button", { name: /retry/i })));
        expect(await screen.findByText("Asked")).toBeTruthy();
        expect(load).toHaveBeenCalledTimes(1);
    });

    it("paints the streamed answer with no second request", async () => {
        const load = vi.fn(async () => ({ name: "Asked" }));
        render(
            <AfterPaint
                cacheKey="test.streamed-ok"
                load={load}
                streamed={Promise.resolve({ name: "Streamed" })}
                skeleton={<p>waiting</p>}
            >
                {(data) => <p>{data.name}</p>}
            </AfterPaint>
        );
        expect(await screen.findByText("Streamed")).toBeTruthy();
        await waitFor(() => expect(load).not.toHaveBeenCalled());
    });
});
