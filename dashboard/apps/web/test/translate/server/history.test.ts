/**
 * The history stays bounded per person, a text still being typed replaces its
 * own entry, and deleting only ever reaches the caller's rows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    userId: string;
    sourceText: string;
    targetText: string;
    fromLang: string;
    toLang: string;
    engine: string;
    createdAt: Date;
    updatedAt: Date;
}

const db = vi.hoisted(() => ({ rows: [] as Row[], next: 0 }));

function newest(userId: string): Row[] {
    return db.rows
        .filter((row) => row.userId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

vi.mock("@polaris/db", () => ({
    prisma: {
        translateHistory: {
            findFirst: async ({ where }: { where: { userId: string } }) =>
                newest(where.userId)[0] ?? null,
            findMany: async ({
                where,
                skip = 0,
                take
            }: {
                where: { userId: string };
                skip?: number;
                take?: number;
            }) => newest(where.userId).slice(skip, take === undefined ? undefined : skip + take),
            create: async ({ data }: { data: Omit<Row, "id" | "createdAt" | "updatedAt"> }) => {
                db.next += 1;
                const at = new Date(Date.UTC(2026, 0, 1) + db.next * 1000);
                const row = { ...data, id: `row-${db.next}`, createdAt: at, updatedAt: at };
                db.rows.push(row);
                return row;
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
                const row = db.rows.find((entry) => entry.id === where.id)!;
                Object.assign(row, data, { updatedAt: new Date() });
                return row;
            },
            deleteMany: async ({
                where
            }: {
                where: { userId: string; id?: string | { in: string[] } };
            }) => {
                const ids =
                    typeof where.id === "string" ? [where.id] : where.id ? where.id.in : null;
                db.rows = db.rows.filter(
                    (row) => !(row.userId === where.userId && (!ids || ids.includes(row.id)))
                );
                return { count: 0 };
            }
        }
    }
}));

import { HISTORY_MAX } from "@polaris-app/translate/src/model/schemas";
import { continues, forget, listHistory, remember } from "@polaris-app/translate/src/lib/history";

const entry = (sourceText: string, from: "es" | "fr" = "es") => ({
    sourceText,
    targetText: `t:${sourceText}`,
    from,
    to: "en" as const,
    engine: "deepl" as const
});

beforeEach(() => {
    db.rows = [];
    db.next = 0;
});

describe("the history", () => {
    it("keeps at most HISTORY_MAX entries per person, the newest", async () => {
        for (let index = 0; index < HISTORY_MAX + 5; index += 1) {
            // A different language each time, so none continues the last.
            await remember("u1", entry(`text ${index}`, index % 2 ? "es" : "fr"));
        }
        const kept = newest("u1");
        expect(kept).toHaveLength(HISTORY_MAX);
        expect(kept[0]?.sourceText).toBe(`text ${HISTORY_MAX + 4}`);
        expect((await listHistory("u1")).length).toBe(HISTORY_MAX);
    });

    it("replaces the entry a text started as while it is still being typed", async () => {
        vi.useFakeTimers({ now: new Date(Date.UTC(2026, 0, 1, 0, 0, 5)), toFake: ["Date"] });
        await remember("u1", entry("Hola"));
        await remember("u1", entry("Hola, que tal"));
        vi.useRealTimers();
        expect(newest("u1").map((row) => row.sourceText)).toEqual(["Hola, que tal"]);
    });

    it("does not treat an old or different text as the same one", () => {
        const last = { sourceText: "Hola", fromLang: "es", toLang: "en", updatedAt: new Date(0) };
        expect(continues(last, entry("Hola mundo"), 10 * 60 * 1000)).toBe(false);
        expect(continues({ ...last, updatedAt: new Date() }, entry("Adios"))).toBe(false);
        expect(continues({ ...last, updatedAt: new Date() }, entry("Hola mundo"))).toBe(true);
    });

    it("forgets only the caller's own rows", async () => {
        const mine = await remember("u1", entry("Hola"));
        await remember("u2", entry("Hola"));
        await forget("u2", mine.id);
        expect(newest("u1")).toHaveLength(1);
        await forget("u1", mine.id);
        expect(newest("u1")).toHaveLength(0);
        expect(newest("u2")).toHaveLength(1);
    });
});
