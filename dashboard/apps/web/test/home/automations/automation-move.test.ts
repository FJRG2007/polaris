/**
 * Moving Places automations to the central engine: each row once, by its
 * `legacyRef`, safe to run again after a crash at any point, a row this build
 * cannot read left running where it is, and nothing deleted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PLACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "33333333-3333-4333-8333-333333333333";

interface Row {
    id: string;
    placeId: string;
    ownerId: string;
    name: string;
    enabled: boolean;
    definition: unknown;
    createdAt: Date;
    movedToId: string | null;
}

const state = vi.hoisted(() => ({
    rows: [] as Row[],
    central: new Map<string, string>(),
    imports: [] as Record<string, unknown>[],
    failNext: false
}));

vi.mock("@polaris/db", () => ({
    Prisma: {},
    prisma: {
        placeAutomation: {
            findMany: async (args: { where: { movedToId: null }; take: number }) =>
                state.rows
                    .filter((row) => row.movedToId === null)
                    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                    .slice(0, args.take)
                    .map(({ movedToId: _moved, createdAt: _at, ...row }) => ({ ...row })),
            updateMany: async (args: { where: { id: string; movedToId: null }; data: { movedToId: string } }) => {
                const row = state.rows.find((each) => each.id === args.where.id && each.movedToId === null);
                if (row) row.movedToId = args.data.movedToId;
                return { count: row ? 1 : 0 };
            },
            findUnique: async (args: { where: { id: string } }) => {
                const row = state.rows.find((each) => each.id === args.where.id);
                return row ? { movedToId: row.movedToId } : null;
            }
        }
    }
}));

vi.mock("@polaris/app-host", async (original) => {
    const real = (await original()) as { host: object };
    const automations = {
        importLegacyAutomation: async (input: { legacyRef: string }) => {
            if (state.failNext) {
                state.failNext = false;
                throw new Error("database went away");
            }
            state.imports.push(input);
            const existing = state.central.get(input.legacyRef);
            if (existing) return existing;
            const id = `00000000-0000-4000-8000-${String(state.central.size + 1).padStart(12, "0")}`;
            state.central.set(input.legacyRef, id);
            return id;
        },
        automationForLegacy: async (ref: string) => state.central.get(ref) ?? null
    };
    return {
        ...real,
        host: new Proxy(real.host, {
            get: (target, key) =>
                key === "automations" ? automations : (target as Record<string | symbol, unknown>)[key]
        })
    };
});

const move = await import("@polaris-app/places/src/lib/automation-move");

function definition(extra: Record<string, unknown> = {}) {
    return {
        timeZone: "Europe/Madrid",
        triggers: [{ id: "trig01", kind: "change", deviceId: "plug", attribute: "state", from: "", to: "on" }],
        conditions: { match: "all", groups: [] },
        actions: [{ id: "step01", kind: "device", deviceId: "plug", do: "turn-off" }],
        ...extra
    };
}

function row(id: string, minute: number, extra: Partial<Row> = {}): Row {
    return {
        id,
        placeId: PLACE,
        ownerId: OWNER,
        name: `Fixture ${id}`,
        enabled: true,
        definition: definition(),
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)),
        movedToId: null,
        ...extra
    };
}

beforeEach(() => {
    state.rows = [];
    state.central = new Map();
    state.imports = [];
    state.failNext = false;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("movePlaceAutomations", () => {
    it("imports each row as a parallel, armed central automation and marks it moved", async () => {
        state.rows = [row("a1", 1), row("a2", 2, { enabled: false })];
        expect(await move.movePlaceAutomations()).toBe(2);
        expect(state.imports).toEqual([
            expect.objectContaining({
                legacyRef: "place:a1",
                name: "Fixture a1",
                enabled: true,
                ownerId: OWNER,
                origin: "home",
                originRef: PLACE,
                mode: "parallel"
            }),
            expect.objectContaining({ legacyRef: "place:a2", enabled: false })
        ]);
        expect(state.rows.map((each) => each.movedToId)).toEqual([state.central.get("place:a1"), state.central.get("place:a2")]);
        expect(await move.movedTo("a1")).toBe(state.central.get("place:a1"));
    });

    it("is a no-op the second time", async () => {
        state.rows = [row("a1", 1)];
        await move.movePlaceAutomations();
        state.imports = [];
        expect(await move.movePlaceAutomations()).toBe(0);
        expect(state.imports).toEqual([]);
    });

    it("finishes a pass that crashed after the import: the same twin is marked, not a second one made", async () => {
        state.rows = [row("a1", 1)];
        // The twin exists, the row was never marked.
        state.central.set("place:a1", "00000000-0000-4000-8000-000000000099");
        expect(await move.movePlaceAutomations()).toBe(1);
        expect(state.rows[0]!.movedToId).toBe("00000000-0000-4000-8000-000000000099");
        expect(state.central.size).toBe(1);
    });

    it("leaves a row whose import failed for the next pass", async () => {
        state.rows = [row("a1", 1), row("a2", 2)];
        state.failNext = true;
        expect(await move.movePlaceAutomations()).toBe(1);
        expect(state.rows.map((each) => each.movedToId === null)).toEqual([true, false]);
        expect(await move.movePlaceAutomations()).toBe(1);
        expect(state.rows.every((each) => each.movedToId !== null)).toBe(true);
    });

    it("leaves a row it cannot read on the Places engine, and says so once", async () => {
        state.rows = [row("bad", 1, { definition: { triggers: "nope" } }), row("a2", 2)];
        expect(await move.movePlaceAutomations()).toBe(1);
        await move.movePlaceAutomations();
        expect(state.rows[0]!.movedToId).toBeNull();
        expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => String(call[0]).includes("bad"))).toHaveLength(1);
    });

    it("moves a row written by an older build: no sets, a group of conditions, a delay", async () => {
        state.rows = [
            row("old", 1, {
                definition: definition({
                    conditions: {
                        match: "all",
                        groups: [{ id: "grp001", match: "all", items: [{ id: "cond01", kind: "weekday", days: [1] }] }]
                    },
                    actions: [
                        { id: "step01", kind: "delay", seconds: 60 },
                        { id: "step02", kind: "run", automationId: "a2" }
                    ]
                })
            })
        ];
        expect(await move.movePlaceAutomations()).toBe(1);
        const graph = state.imports[0]!.graph as { nodes: { id: string; type: string; config: Record<string, unknown> }[] };
        expect(graph.nodes.map((node) => node.type)).toEqual(["home.trigger.change", "home.condition.check", "core.wait", "home.action.run"]);
        // "Run another" keeps the old id: the node finds its twin when it runs, whatever order they moved in.
        expect(graph.nodes[3]!.config.automationId).toBe("a2");
    });

    it("takes a batch at a time, oldest first", async () => {
        state.rows = Array.from({ length: 30 }, (_, index) => row(`r${index}`, 59 - index));
        expect(await move.movePlaceAutomations()).toBe(25);
        expect(state.rows.filter((each) => each.movedToId === null).map((each) => each.id)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
        expect(await move.movePlaceAutomations()).toBe(5);
    });

    it("finds a twin by its legacy ref for a row whose mark is missing", async () => {
        state.rows = [row("a1", 1)];
        state.central.set("place:a1", "00000000-0000-4000-8000-000000000042");
        expect(await move.movedTo("a1")).toBe("00000000-0000-4000-8000-000000000042");
        expect(await move.movedTo("gone")).toBeNull();
    });
});
