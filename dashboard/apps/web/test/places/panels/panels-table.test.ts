/**
 * The panels table: its search, a copy of a panel (same cards and look, under
 * the place's panel limit), and "last opened" written at most once per window.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PLACE = "00000000-0000-4000-8000-0000000000a1";

type Row = Record<string, unknown>;
let panels: Row[] = [];
const updates: Row[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        placePanel: {
            findFirst: async ({ where }: { where: Row }) =>
                panels.find((row) => row.id === where.id && row.installedAppId === where.installedAppId) ??
                null,
            count: async ({ where }: { where: Row }) =>
                panels.filter((row) => row.placeId === where.placeId).length,
            create: async ({ data }: { data: Row }) => {
                const row = { id: `p${panels.length + 1}`, openedAt: null, ...data };
                panels.push(row);
                return row;
            },
            updateMany: async (query: Row) => {
                updates.push(query);
                return { count: 1 };
            }
        }
    }
}));
vi.mock("@polaris/app-host", () => ({ host: {} }));
vi.mock("@polaris-app/places/src/lib/cameras", () => ({ getCamerasAt: async () => [] }));
vi.mock("@polaris-app/places/src/lib/devices", () => ({ listDevices: async () => [] }));

const { duplicatePanel, markPanelOpened, OPENED_EVERY_MS } = await import(
    "@polaris-app/places/src/lib/panels"
);
const { matchPanels } = await import("@polaris-app/places/src/lib/panel-layout");

const CLOCK = { id: "c1", type: "clock", x: 0, y: 0, w: 2, h: 2 };

beforeEach(() => {
    panels = [
        {
            id: "p1",
            installedAppId: "i1",
            placeId: PLACE,
            name: "Hallway",
            cards: [CLOCK],
            style: { theme: "dark", orientation: "portrait" },
            openedAt: new Date("2026-11-01T10:00:00Z")
        }
    ];
    updates.length = 0;
});

describe("matchPanels", () => {
    const list = [{ name: "Hallway tablet" }, { name: "Kitchen" }, { name: "Hall upstairs" }];

    it("keeps every panel for an empty search", () => {
        expect(matchPanels(list, "  ")).toHaveLength(3);
    });

    it("needs every word, in any case and order", () => {
        expect(matchPanels(list, "TABLET hall").map((p) => p.name)).toEqual(["Hallway tablet"]);
        expect(matchPanels(list, "hall").map((p) => p.name)).toEqual([
            "Hallway tablet",
            "Hall upstairs"
        ]);
        expect(matchPanels(list, "garage")).toEqual([]);
    });
});

describe("duplicatePanel", () => {
    it("copies the cards and the look under the new name, never opened", async () => {
        const copy = await duplicatePanel("i1", "p1", "Hallway (copy)");
        expect(copy.name).toBe("Hallway (copy)");
        expect(copy.placeId).toBe(PLACE);
        expect(copy.cards).toEqual([CLOCK]);
        expect(copy.style.theme).toBe("dark");
        expect(copy.style.orientation).toBe("portrait");
        expect(copy.openedAt).toBeNull();
        expect(panels).toHaveLength(2);
    });

    it("refuses a panel of another install", async () => {
        await expect(duplicatePanel("i2", "p1", "Copy")).rejects.toThrow();
    });

    it("refuses past the place's panel limit", async () => {
        for (let i = 2; i <= 20; i++) panels.push({ ...panels[0], id: `p${i}` });
        await expect(duplicatePanel("i1", "p1", "Copy")).rejects.toThrow(/20 panels/);
    });
});

describe("markPanelOpened", () => {
    it("writes only where it was never opened or not in the last window", async () => {
        const now = new Date("2026-11-15T12:00:00Z");
        await markPanelOpened("i1", "p1", now);
        expect(updates).toHaveLength(1);
        const query = updates[0] as { where: Row; data: Row };
        expect(query.data).toEqual({ openedAt: now });
        expect(query.where.id).toBe("p1");
        expect(query.where.installedAppId).toBe("i1");
        expect(query.where.OR).toEqual([
            { openedAt: null },
            { openedAt: { lt: new Date(now.getTime() - OPENED_EVERY_MS) } }
        ]);
        expect(OPENED_EVERY_MS).toBe(10 * 60_000);
    });
});
