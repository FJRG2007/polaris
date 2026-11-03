/**
 * Glossaries stay bounded per person, a pair keeps one default, and nobody
 * reads, changes or deletes another person's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    userId: string;
    name: string;
    fromLang: string;
    toLang: string;
    isDefault: boolean;
    entries: unknown;
    updatedAt: Date;
}

type Where = Record<string, unknown>;

const db = vi.hoisted(() => ({
    rows: [] as Row[],
    keep: new Map<string, unknown>(),
    next: 0
}));

function matches(row: Row, where: Where): boolean {
    return Object.entries(where).every(([field, wanted]) => {
        const value = row[field as keyof Row];
        if (wanted && typeof wanted === "object" && "not" in wanted) {
            return value !== (wanted as { not: unknown }).not;
        }
        return value === wanted;
    });
}

vi.mock("@polaris/db", () => ({
    prisma: {
        translateGlossary: {
            findMany: async ({ where, take }: { where: Where; take: number }) =>
                db.rows.filter((row) => matches(row, where)).slice(0, take),
            findFirst: async ({ where }: { where: Where }) =>
                db.rows.find((row) => matches(row, where)) ?? null,
            count: async ({ where }: { where: Where }) =>
                db.rows.filter((row) => matches(row, where)).length,
            create: async ({ data }: { data: Omit<Row, "id" | "updatedAt"> }) => {
                const id = `00000000-0000-4000-8000-${String(++db.next).padStart(12, "0")}`;
                const row = { ...data, id, updatedAt: new Date() };
                db.rows.push(row);
                return row;
            },
            updateMany: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
                const hit = db.rows.filter((row) => matches(row, where));
                for (const row of hit) Object.assign(row, data, { updatedAt: new Date() });
                return { count: hit.length };
            },
            deleteMany: async ({ where }: { where: Where }) => {
                db.rows = db.rows.filter((row) => !matches(row, where));
                return { count: 0 };
            }
        },
        translateKeepList: {
            findUnique: async ({ where }: { where: { userId: string } }) =>
                db.keep.has(where.userId) ? { terms: db.keep.get(where.userId) } : null,
            upsert: async ({
                where,
                create
            }: {
                where: { userId: string };
                create: { terms: unknown };
            }) => {
                db.keep.set(where.userId, create.terms);
                return { terms: create.terms };
            }
        }
    }
}));

import { GLOSSARIES_MAX } from "@polaris-app/translate/src/model/glossary";
import {
    GlossaryLimitError,
    deleteGlossary,
    getGlossary,
    getKeepList,
    listGlossaries,
    saveGlossary,
    saveKeepList
} from "@polaris-app/translate/src/lib/glossary";

const input = (name: string, isDefault = true) => ({
    name,
    from: "en" as const,
    to: "es" as const,
    isDefault,
    entries: [{ source: "pull request", target: "solicitud de cambios" }]
});

beforeEach(() => {
    db.rows = [];
    db.keep = new Map();
    db.next = 0;
});

describe("a person's glossaries", () => {
    it("keep one default per pair: marking a new one clears the old", async () => {
        const first = await saveGlossary("u1", null, input("Work"));
        const second = await saveGlossary("u1", null, input("Docs"));
        const list = await listGlossaries("u1");
        expect(list.find((g) => g.id === first!.id)?.isDefault).toBe(false);
        expect(list.find((g) => g.id === second!.id)).toMatchObject({ isDefault: true, count: 1 });
        expect(list[0]).not.toHaveProperty("entries");
    });

    it("leave another person's default alone", async () => {
        const theirs = await saveGlossary("u2", null, input("Theirs"));
        await saveGlossary("u1", null, input("Mine"));
        expect((await getGlossary("u2", theirs!.id))?.isDefault).toBe(true);
    });

    it("stop at the limit, while one already kept can still change", async () => {
        for (let index = 0; index < GLOSSARIES_MAX; index++) {
            await saveGlossary("u1", null, input(`G${index}`, false));
        }
        await expect(saveGlossary("u1", null, input("One more"))).rejects.toBeInstanceOf(
            GlossaryLimitError
        );
        const [kept] = await listGlossaries("u1");
        expect(await saveGlossary("u1", kept!.id, input("Renamed", false))).toMatchObject({
            name: "Renamed"
        });
    });

    it("are out of reach of anybody else", async () => {
        const mine = await saveGlossary("u1", null, input("Mine"));
        expect(await getGlossary("u2", mine!.id)).toBeNull();
        expect(await saveGlossary("u2", mine!.id, input("Taken"))).toBeNull();
        await deleteGlossary("u2", mine!.id);
        expect(await getGlossary("u1", mine!.id)).toMatchObject({ name: "Mine" });
        await deleteGlossary("u1", mine!.id);
        expect(await getGlossary("u1", mine!.id)).toBeNull();
    });

    it("read a stored list whole, dropping rows an older version left broken", async () => {
        const mine = await saveGlossary("u1", null, input("Mine"));
        db.rows[0]!.entries = [{ source: "ok", target: "vale" }, { source: "" }, "junk"];
        expect((await getGlossary("u1", mine!.id))?.entries).toEqual([
            { source: "ok", target: "vale" }
        ]);
    });
});

describe("the never-translate list", () => {
    it("is empty until saved, then the person's own", async () => {
        expect(await getKeepList("u1")).toEqual([]);
        await saveKeepList("u1", ["Polaris", "Lirio"]);
        expect(await getKeepList("u1")).toEqual(["Polaris", "Lirio"]);
        expect(await getKeepList("u2")).toEqual([]);
    });
});
