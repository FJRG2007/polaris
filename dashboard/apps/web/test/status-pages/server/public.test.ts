/**
 * What a public status page lets out: nothing for an unpublished page, and
 * never a check's target, port or error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({ statusPage: { findFirst: vi.fn() } }));
vi.mock("@polaris/db", () => ({ prisma }));

import { publicStatusPage } from "@polaris-app/status-pages/src/lib/public";

const now = new Date("2026-03-10T12:00:00Z");

const row = {
    title: "Acme",
    description: "Our services",
    components: [
        {
            id: "c1",
            name: "Website",
            description: "",
            checks: [
                {
                    lastStatus: "down",
                    days: [{ day: new Date("2026-03-10T00:00:00Z"), total: 4, up: 3 }]
                },
                { lastStatus: "up", days: [] }
            ]
        },
        { id: "c2", name: "API", description: "", checks: [] }
    ],
    incidents: [
        {
            id: "i1",
            title: "Slow pages",
            state: "identified",
            impact: "minor",
            componentIds: ["c1", "gone"],
            startedAt: new Date("2026-03-10T10:00:00Z"),
            resolvedAt: null,
            updates: [
                {
                    state: "identified",
                    body: "Cache node failed",
                    createdAt: new Date("2026-03-10T10:05:00Z")
                }
            ]
        }
    ],
    maintenance: [
        {
            id: "m1",
            title: "Database upgrade",
            body: "",
            componentIds: ["c2"],
            startsAt: new Date("2026-03-10T11:00:00Z"),
            endsAt: new Date("2026-03-10T13:00:00Z")
        }
    ]
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe("publicStatusPage", () => {
    it("asks only for a published page, and answers null when there is none", async () => {
        prisma.statusPage.findFirst.mockResolvedValue(null);
        expect(await publicStatusPage("draft", now)).toBeNull();
        const query = prisma.statusPage.findFirst.mock.calls[0]![0];
        expect(query.where).toEqual({ slug: "draft", published: true });
    });

    it("lets the operator's preview read an unpublished page", async () => {
        prisma.statusPage.findFirst.mockResolvedValue(null);
        await publicStatusPage("draft", now, { includeUnpublished: true });
        expect(prisma.statusPage.findFirst.mock.calls[0]![0].where).toEqual({ slug: "draft" });
    });

    it("never selects a check's target, port, error or the page's author", async () => {
        prisma.statusPage.findFirst.mockResolvedValue(null);
        await publicStatusPage("acme", now);
        const select = prisma.statusPage.findFirst.mock.calls[0]![0].select;
        expect(Object.keys(select.components.select.checks.select).sort()).toEqual([
            "days",
            "lastStatus"
        ]);
        expect(select.createdById).toBeUndefined();
        const serialized = JSON.stringify(select);
        for (const field of [
            "target",
            "port",
            "lastError",
            "keyword",
            "dnsExpect",
            "createdById"
        ]) {
            expect(serialized).not.toContain(`"${field}"`);
        }
    });

    it("bounds what it reads", async () => {
        prisma.statusPage.findFirst.mockResolvedValue(null);
        await publicStatusPage("acme", now);
        const select = prisma.statusPage.findFirst.mock.calls[0]![0].select;
        expect(select.components.take).toBe(100);
        expect(select.incidents.take).toBe(20);
        expect(select.maintenance.take).toBe(10);
        expect(select.components.select.checks.select.days.where.day.gte).toEqual(
            new Date("2025-12-11T00:00:00Z")
        );
    });

    it("derives states, bars and names, and nothing private reaches the answer", async () => {
        prisma.statusPage.findFirst.mockResolvedValue(row);
        const view = await publicStatusPage("acme", now);
        expect(view).not.toBeNull();
        const [website, api] = view!.components;
        expect(website!.state).toBe("degraded");
        expect(website!.uptime).toBe(75);
        expect(website!.bars.at(-1)).toEqual({ day: "2026-03-10", tone: "down", ratio: 0.75 });
        expect(api!.state).toBe("maintenance");
        expect(view!.state).toBe("degraded");
        expect(view!.incidents[0]!.components).toEqual(["Website"]);
        expect(view!.maintenance[0]).toMatchObject({ active: true, components: ["API"] });
        expect(Object.keys(view!).sort()).toEqual([
            "components",
            "description",
            "incidents",
            "maintenance",
            "state",
            "title"
        ]);
    });
});
