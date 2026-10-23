/**
 * Who a link opens for (restricted / org / anyone), judged in the one server
 * check every public link page goes through, and "People with access" read a
 * page at a time.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
let grants: Row[] = [];
let members: { orgId: string; userId: string }[] = [];
let viewer: { id: string; isAdmin: boolean } | null = null;
let mayShare = false;
let lastFindMany: Record<string, unknown> | null = null;

const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, want]) => {
        if (key === "OR") return (want as Row[]).some((one) => matches(row, one));
        if (want && typeof want === "object" && "in" in (want as Row)) {
            return ((want as { in: unknown[] }).in ?? []).includes(row[key]);
        }
        return row[key] === want;
    });

vi.mock("@polaris/db", () => ({
    prisma: {
        accessGrant: {
            count: async ({ where }: { where: Row }) =>
                grants.filter((row) => matches(row, where)).length,
            create: async ({ data }: { data: Row }) => {
                grants.push({ ...data, id: `g${grants.length + 1}`, uses: 0 });
                return { id: `g${grants.length}` };
            },
            findFirst: async ({ where }: { where: Row }) =>
                grants.find((row) => matches(row, where)) ?? null,
            findMany: async (args: { where: Row; take?: number; cursor?: { id: string } }) => {
                lastFindMany = args as Record<string, unknown>;
                let found = grants.filter((row) => matches(row, args.where));
                if (args.cursor) {
                    const at = found.findIndex((row) => row.id === args.cursor?.id);
                    found = found.slice(at + 1);
                }
                return args.take ? found.slice(0, args.take) : found;
            }
        },
        organizationMember: {
            findFirst: async ({ where }: { where: { orgId: string; userId: string } }) =>
                members.find((one) => one.orgId === where.orgId && one.userId === where.userId) ??
                null,
            findMany: async () => []
        },
        orgRole: { findMany: async () => [] },
        team: { findMany: async () => [] },
        user: {
            findMany: async ({ where }: { where: Row }) =>
                "OR" in where
                    ? [{ id: "00000000-0000-4000-8000-0000000000a1" }].filter(() =>
                          JSON.stringify(where).includes("ana")
                      )
                    : [{ id: "00000000-0000-4000-8000-0000000000a1", name: "Ana", username: "ana", email: "ana@example.test" }]
        }
    }
}));
vi.mock("@/lib/orgs/org-service", () => ({ teamIdsFor: async () => [] }));
vi.mock("@/lib/request-context", () => ({ clientIp: async () => "198.51.100.7" }));
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: async () => true }));
vi.mock("@/lib/session", () => ({ guardedUser: async () => viewer }));
vi.mock("@/lib/access/sharing-service", () => ({
    requireMayShare: async () => {
        if (!mayShare) throw new Error("no");
    }
}));
vi.mock("@/lib/privacy-service", () => ({
    contactLines: async (_viewer: unknown, people: { id: string; username: string }[]) =>
        new Map(people.map((one) => [one.id, `@${one.username}`]))
}));

const core = await import("@polaris/core");
const { linkReach, listSubjectGrantPage, writeGrantLink } = await import("@/lib/access/grants");

const DOOR = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-0000000000f1";
const link = (audience: string) =>
    core.grantLinkSchema.parse({ capability: "view", audience });

beforeEach(() => {
    grants = [];
    members = [];
    viewer = null;
    mayShare = false;
});

describe("link audience", () => {
    it("opens an anyone link with no account, and reads an old row as anyone", async () => {
        const { token } = await writeGrantLink("place.device", DOOR, link("anyone"), "u1");
        expect((await linkReach(token))?.standing).toBe("live");
        // A row written before audiences existed has no such column value.
        delete grants[0]!.linkAudience;
        expect((await linkReach(token))?.standing).toBe("live");
    });

    it("defaults a link with no audience to anyone", () => {
        expect(core.grantLinkSchema.parse({ capability: "view" }).audience).toBe("anyone");
    });

    it("asks for a sign-in on a restricted link, and refuses somebody without access", async () => {
        const { token } = await writeGrantLink("place.device", DOOR, link("restricted"), "u1");
        expect((await linkReach(token))?.standing).toBe("signin");
        viewer = { id: "00000000-0000-4000-8000-0000000000b2", isAdmin: false };
        expect((await linkReach(token))?.standing).toBe("denied");
    });

    it("opens a restricted link for somebody with a grant of their own, or who may share it", async () => {
        const { token } = await writeGrantLink("place.device", DOOR, link("restricted"), "u1");
        viewer = { id: "00000000-0000-4000-8000-0000000000b2", isAdmin: false };
        grants.push({
            id: "g9",
            subjectType: "place.device",
            subjectId: DOOR,
            principalType: "user",
            principalId: viewer.id,
            capability: "view",
            actions: [],
            startsAt: null,
            endsAt: null,
            days: core.EVERY_DAY,
            startMinute: null,
            endMinute: null,
            timeZone: "UTC",
            maxUses: null,
            uses: 0,
            nearbyMeters: null
        });
        expect((await linkReach(token))?.standing).toBe("live");
        grants.pop();
        mayShare = true;
        expect((await linkReach(token))?.standing).toBe("live");
    });

    it("opens an organization link only for its members", async () => {
        const { token } = await writeGrantLink("place.device", DOOR, link("org"), "u1", ORG);
        expect((await linkReach(token))?.standing).toBe("signin");
        viewer = { id: "00000000-0000-4000-8000-0000000000c3", isAdmin: false };
        expect((await linkReach(token))?.standing).toBe("denied");
        members.push({ orgId: ORG, userId: viewer.id });
        expect((await linkReach(token))?.standing).toBe("live");
    });

    it("refuses to write an organization link for something no organization owns", async () => {
        await expect(writeGrantLink("place.device", DOOR, link("org"), "u1")).rejects.toThrow();
    });
});

describe("people with access, a page at a time", () => {
    const person = (index: number): Row => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        subjectType: "task.space",
        subjectId: DOOR,
        principalType: "user",
        principalId: "00000000-0000-4000-8000-0000000000a1",
        capability: "member",
        actions: [],
        startsAt: null,
        endsAt: null,
        days: core.EVERY_DAY,
        startMinute: null,
        endMinute: null,
        timeZone: "UTC",
        maxUses: null,
        uses: 0,
        nearbyMeters: null,
        note: "",
        createdAt: new Date(2026, 0, 1, 0, 0, index),
        linkAudience: "anyone"
    });

    it("pages with a bounded size, a cursor and the total, and leaves links out", async () => {
        for (let index = 1; index <= core.GRANT_PAGE_SIZE + 7; index++) grants.push(person(index));
        grants.push({ ...person(999), principalType: "link" });
        const me = { id: "u-viewer", isAdmin: false };
        const first = await listSubjectGrantPage("task.space", DOOR, { links: false }, me);
        expect(first.grants).toHaveLength(core.GRANT_PAGE_SIZE);
        expect(first.total).toBe(core.GRANT_PAGE_SIZE + 7);
        expect(lastFindMany?.take).toBe(core.GRANT_PAGE_SIZE + 1);
        expect(first.grants[0]?.contact).toBe("@ana");
        const second = await listSubjectGrantPage(
            "task.space",
            DOOR,
            { links: false, cursor: first.nextCursor },
            me
        );
        expect(second.grants).toHaveLength(7);
        expect(second.nextCursor).toBeNull();
        const onlyLinks = await listSubjectGrantPage("task.space", DOOR, { links: true }, me);
        expect(onlyLinks.total).toBe(1);
    });

    it("narrows to principals whose name matches, and answers empty when none does", async () => {
        grants.push(person(1));
        const me = { id: "u-viewer", isAdmin: false };
        const hit = await listSubjectGrantPage("task.space", DOOR, { links: false, search: "ana" }, me);
        expect(hit.total).toBe(1);
        const miss = await listSubjectGrantPage("task.space", DOOR, { links: false, search: "zz" }, me);
        expect(miss).toEqual({ grants: [], total: 0, nextCursor: null });
    });
});
