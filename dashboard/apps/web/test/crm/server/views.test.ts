/**
 * Saved views: named once per kind of record on a shelf, the default one fixed,
 * and every change answered with the view as it is now kept - its name too.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    shelf: string;
    object: string;
    name: string;
    kind: string;
    config: string;
    position: number;
    createdAt: Date;
}

const db = vi.hoisted(() => ({ rows: [] as Row[], made: 0 }));

/** The handful of `where` shapes lib/views uses, matched in memory. */
function matches(row: Row, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === "NOT") return !matches(row, value as Record<string, unknown>);
        if (value && typeof value === "object" && "equals" in value) {
            const field = String((row as unknown as Record<string, unknown>)[key]);
            return field.toLowerCase() === String(value.equals).toLowerCase();
        }
        return (row as unknown as Record<string, unknown>)[key] === value;
    });
}

const pick = (row: Row) => ({ id: row.id, name: row.name, kind: row.kind, config: row.config });

vi.mock("@polaris/db", () => ({
    Prisma: { Decimal: class {} },
    prisma: {
        crmView: {
            findUnique: async ({
                where
            }: {
                where: { shelf_object_name: Record<string, unknown> };
            }) => {
                const row = db.rows.find((one) => matches(one, where.shelf_object_name));
                return row ? pick(row) : null;
            },
            findFirst: async ({ where }: { where: Record<string, unknown> }) => {
                const row = db.rows.find((one) => matches(one, where));
                return row ? { ...pick(row), position: row.position } : null;
            },
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                db.rows
                    .filter((one) => matches(one, where))
                    .sort((a, b) => a.position - b.position)
                    .map(pick),
            count: async ({ where }: { where: Record<string, unknown> }) =>
                db.rows.filter((one) => matches(one, where)).length,
            create: async ({ data }: { data: Partial<Row> }) => {
                if (
                    db.rows.some(
                        (one) =>
                            one.shelf === data.shelf &&
                            one.object === data.object &&
                            one.name === data.name
                    )
                ) {
                    throw Object.assign(new Error("unique"), { code: "P2002" });
                }
                db.made += 1;
                const row: Row = {
                    id: `00000000-0000-4000-8000-00000000000${db.made}`,
                    kind: "table",
                    position: 0,
                    createdAt: new Date(),
                    ...(data as Partial<Row>)
                } as Row;
                db.rows.push(row);
                return pick(row);
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
                const row = db.rows.find((one) => one.id === where.id)!;
                if (
                    data.name !== undefined &&
                    db.rows.some(
                        (one) =>
                            one !== row &&
                            one.shelf === row.shelf &&
                            one.object === row.object &&
                            one.name === data.name
                    )
                ) {
                    throw Object.assign(new Error("unique"), { code: "P2002" });
                }
                Object.assign(row, data);
                return pick(row);
            },
            updateMany: async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Partial<Row>;
            }) => {
                const rows = db.rows.filter((one) => matches(one, where));
                for (const row of rows) Object.assign(row, data);
                return { count: rows.length };
            },
            deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
                const before = db.rows.length;
                db.rows = db.rows.filter((one) => !matches(one, where));
                return { count: before - db.rows.length };
            }
        }
    }
}));
vi.mock("@polaris/app-host", () => ({
    host: { i18nRequest: { getLocale: async () => "en-US" } }
}));

import * as views from "@polaris-app/crm/src/lib/views";
import { CrmRefusal } from "@polaris-app/crm/src/lib/errors";
import { defaultConfig } from "@polaris-app/crm/src/model/views";

const all = { read: true, edit: true, delete: true };
const actor = (edit = true) =>
    ({
        user: { id: "u1", name: "Ana", isAdmin: false },
        shelf: { orgId: "o1", userId: null, key: "org:o1", orgName: "Acme" },
        can: {
            companies: { ...all, edit },
            people: { ...all, edit },
            opportunities: { ...all, edit }
        }
    }) as never;

beforeEach(() => {
    db.rows = [];
    db.made = 0;
});

describe("saved views", () => {
    it("lists the default view first, made on the first visit", async () => {
        const listed = await views.listViews(actor(), "opportunities");
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ name: "", kind: "table" });
    });

    it("makes a named board, and refuses the same name twice", async () => {
        const made = await views.createView(actor(), "opportunities", {
            name: "  Open   deals ",
            kind: "kanban",
            config: defaultConfig("opportunities")
        });
        expect(made).toMatchObject({ name: "Open deals", kind: "kanban" });
        await expect(
            views.createView(actor(), "opportunities", {
                name: "Open deals",
                kind: "table",
                config: defaultConfig("opportunities")
            })
        ).rejects.toThrow("A view with this name already exists.");
        await expect(
            views.createView(actor(), "opportunities", {
                name: "OPEN DEALS",
                kind: "table",
                config: defaultConfig("opportunities")
            })
        ).rejects.toThrow("A view with this name already exists.");
    });

    it("draws companies as a table, having no field a board could use", async () => {
        const made = await views.createView(actor(), "companies", {
            name: "Board",
            kind: "kanban",
            config: defaultConfig("companies")
        });
        expect(made.kind).toBe("table");
    });

    it("answers a saved layout with the view's own name", async () => {
        const made = await views.createView(actor(), "opportunities", {
            name: "Mine",
            kind: "table",
            config: defaultConfig("opportunities")
        });
        const saved = await views.saveViewConfig(
            actor(),
            "opportunities",
            made.id,
            { ...defaultConfig("opportunities"), groupBy: "stage" },
            "kanban"
        );
        expect(saved).toMatchObject({ id: made.id, name: "Mine", kind: "kanban" });
        expect(saved.config.groupBy).toBe("stage");
    });

    it("keeps the default view's name and place", async () => {
        const [first] = await views.listViews(actor(), "people");
        await expect(
            views.renameView(actor(), "people", first!.id, "Renamed")
        ).rejects.toBeInstanceOf(CrmRefusal);
        await expect(views.deleteView(actor(), "people", first!.id)).rejects.toBeInstanceOf(
            CrmRefusal
        );
        expect(db.rows).toHaveLength(1);
    });

    it("renames and deletes a named view", async () => {
        const made = await views.createView(actor(), "people", {
            name: "Madrid",
            kind: "table",
            config: defaultConfig("people")
        });
        expect((await views.renameView(actor(), "people", made.id, "Lisbon")).name).toBe("Lisbon");
        expect((await views.renameView(actor(), "people", made.id, "LISBON")).name).toBe("LISBON");
        const other = await views.createView(actor(), "people", {
            name: "Porto",
            kind: "table",
            config: defaultConfig("people")
        });
        await expect(views.renameView(actor(), "people", other.id, "lisbon")).rejects.toThrow(
            "A view with this name already exists."
        );
        await views.deleteView(actor(), "people", made.id);
        expect(db.rows.some((row) => row.id === made.id)).toBe(false);
    });

    it("lets nobody without the right to change records touch a view", async () => {
        await expect(
            views.createView(actor(false), "people", {
                name: "Mine",
                kind: "table",
                config: defaultConfig("people")
            })
        ).rejects.toBeInstanceOf(CrmRefusal);
    });
});
