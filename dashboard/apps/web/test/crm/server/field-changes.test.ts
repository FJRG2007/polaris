/**
 * What changing an added field does beyond its own row: the saved views that
 * used it, the records holding a reworded choice, who may lose values, a slot
 * two people claim at once, and a board over many choices.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
    const records = {
        updateMany: vi.fn(async () => ({ count: 0 })),
        groupBy: vi.fn(async (): Promise<unknown[]> => []),
        findMany: vi.fn(async (): Promise<unknown[]> => []),
        count: vi.fn(async () => 0)
    };
    const crmField = {
        findMany: vi.fn(async (): Promise<unknown[]> => []),
        findFirst: vi.fn(async (): Promise<unknown> => null),
        create: vi.fn(async (): Promise<unknown> => null),
        update: vi.fn(async (): Promise<unknown> => null),
        delete: vi.fn(async () => ({}))
    };
    const crmView = {
        findMany: vi.fn(async (): Promise<{ id: string; config: string }[]> => []),
        update: vi.fn(async () => ({}))
    };
    const client = {
        crmCompany: records,
        crmPerson: records,
        crmOpportunity: records,
        crmField,
        crmView
    };
    return { records, crmField, crmView, client };
});

vi.mock("@polaris/db", () => ({
    prisma: {
        ...db.client,
        $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db.client)
    },
    Prisma: { Decimal: class {} }
}));
vi.mock("@polaris/app-host", () => ({
    host: { crmHost: {}, i18nRequest: { getLocale: async () => "en-US" } }
}));

import { listGroups } from "@polaris-app/crm/src/lib/records";
import { choiceChanges } from "@polaris-app/crm/src/model/fields";
import { createField, deleteField, updateField } from "@polaris-app/crm/src/lib/fields";

const shelf = { orgId: null, userId: "u1", key: "user:u1" };
const allowed = { read: true, edit: true, delete: true };
const noDelete = { read: true, edit: true, delete: false };

function actorWith(can: typeof allowed) {
    return {
        shelf,
        user: { id: "u1" },
        can: { companies: can, people: can, opportunities: can }
    } as never;
}

const tier = {
    id: "f1",
    slot: "cText1",
    label: "Tier",
    kind: "select",
    options: JSON.stringify(["Enterprse", "Small"]),
    position: 1
};

function storedView(): string {
    return JSON.stringify({
        columns: [
            { key: "name", width: 240, hidden: false, aggregate: "countAll" },
            { key: "cText1", width: 300, hidden: false, aggregate: "countEmpty" }
        ],
        sorts: [{ key: "cText1", direction: "asc" }],
        filter: {
            conjunction: "and",
            rules: [
                {
                    id: "r1",
                    key: "cText1",
                    operator: "isAnyOf",
                    value: [{ id: "Enterprse", name: "" }]
                }
            ]
        },
        groupBy: "cText1",
        boardBy: "cText1"
    });
}

function savedConfig(): Record<string, unknown> {
    const [call] = db.crmView.update.mock.calls as unknown as [{ data: { config: string } }][];
    return JSON.parse(call![0].data.config) as Record<string, unknown>;
}

describe("choiceChanges", () => {
    it("carries a reworded choice over and removes only what is gone", () => {
        expect(
            choiceChanges(["Enterprse", "Small", "Mid"], ["Enterprise", "Small"], [
                { from: "Enterprse", to: "Enterprise" },
                { from: "Small", to: "Small" }
            ])
        ).toEqual({ renamed: [{ from: "Enterprse", to: "Enterprise" }], removed: ["Mid"] });
    });

    it("never renames onto a choice that was already there, or one choice twice", () => {
        expect(
            choiceChanges(["A", "B"], ["B", "C"], [
                { from: "A", to: "B" },
                { from: "A", to: "C" }
            ])
        ).toEqual({ renamed: [{ from: "A", to: "C" }], removed: [] });
        expect(choiceChanges(["A", "B"], ["B"], [{ from: "A", to: "B" }])).toEqual({
            renamed: [],
            removed: ["A"]
        });
    });
});

describe("deleting a field", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        db.crmField.findMany.mockResolvedValue([tier]);
        db.crmField.findFirst.mockResolvedValue({ slot: "cText1" });
        db.crmView.findMany.mockResolvedValue([{ id: "v1", config: storedView() }]);
    });

    it("takes it out of every saved view, so the next field in its slot starts clean", async () => {
        await deleteField(actorWith(allowed), "companies", "f1");
        const config = savedConfig();
        expect(JSON.stringify(config)).not.toContain("cText1");
        expect(config).toMatchObject({ sorts: [], groupBy: null, boardBy: null });
        expect(db.crmField.delete).toHaveBeenCalledWith({ where: { id: "f1" } });
    });

    it("takes the right to delete records", async () => {
        await expect(deleteField(actorWith(noDelete), "companies", "f1")).rejects.toThrow();
        expect(db.records.updateMany).not.toHaveBeenCalled();
        expect(db.crmField.delete).not.toHaveBeenCalled();
    });
});

describe("changing a select's choices", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        db.crmField.findMany.mockResolvedValue([tier]);
        db.crmField.update.mockImplementation(async (...args: unknown[]) => {
            const { data } = args[0] as { data: { label: string; options: string } };
            return { ...tier, ...data };
        });
        db.crmView.findMany.mockResolvedValue([{ id: "v1", config: storedView() }]);
    });

    it("keeps the records and filters of a reworded choice", async () => {
        await updateField(
            actorWith(noDelete),
            "companies",
            "f1",
            { label: "Tier", kind: "select", options: ["Enterprise", "Small"] },
            [{ from: "Enterprse", to: "Enterprise" }]
        );
        expect(db.records.updateMany).toHaveBeenCalledTimes(1);
        expect(db.records.updateMany).toHaveBeenCalledWith({
            where: { userId: "u1", orgId: null, cText1: "Enterprse" },
            data: { cText1: "Enterprise" }
        });
        const filter = savedConfig().filter as { rules: { value: { id: string }[] }[] };
        expect(filter.rules[0]!.value).toEqual([{ id: "Enterprise", name: "" }]);
    });

    it("empties a removed choice only for a reader who may delete records", async () => {
        const input = { label: "Tier", kind: "select" as const, options: ["Small"] };
        await expect(updateField(actorWith(noDelete), "companies", "f1", input)).rejects.toThrow();
        expect(db.records.updateMany).not.toHaveBeenCalled();
        await updateField(actorWith(allowed), "companies", "f1", input);
        expect(db.records.updateMany).toHaveBeenCalledWith({
            where: { userId: "u1", orgId: null, cText1: { in: ["Enterprse"] } },
            data: { cText1: "" }
        });
    });
});

describe("adding a field", () => {
    beforeEach(() => vi.clearAllMocks());

    it("takes the next free slot when another field took its slot at the same moment", async () => {
        db.crmField.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
            { ...tier, slot: "cText1", position: 1 }
        ]);
        db.crmField.create
            .mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))
            .mockImplementationOnce(async (...args: unknown[]) => {
                const { data } = args[0] as { data: Record<string, unknown> };
                return { id: "f2", ...data };
            });
        const field = await createField(actorWith(allowed), "companies", {
            label: "Region",
            kind: "text",
            options: []
        });
        expect(field.slot).toBe("cText2");
        expect(db.crmField.create).toHaveBeenCalledTimes(2);
    });
});

describe("a board over an added select", () => {
    beforeEach(() => vi.clearAllMocks());

    it("counts every column at once and reads only the ones with records", async () => {
        const options = Array.from({ length: 50 }, (_, index) => `Choice ${index + 1}`);
        db.crmField.findMany.mockResolvedValue([{ ...tier, options: JSON.stringify(options) }]);
        db.records.groupBy.mockResolvedValue([
            { cText1: "Choice 3", _count: { _all: 2 } },
            { cText1: "", _count: { _all: 1 } }
        ]);
        db.records.count.mockResolvedValue(2);
        const groups = await listGroups(actorWith(allowed), "companies", "cText1", {});
        expect(groups).toHaveLength(51);
        expect(db.records.groupBy).toHaveBeenCalledTimes(1);
        expect(db.records.findMany).toHaveBeenCalledTimes(2);
        expect(groups.map((group) => group.value)).toEqual([...options, ""]);
        expect(groups[2]!.total).toBe(2);
        expect(groups[0]).toEqual({ value: "Choice 1", records: [], total: 0 });
    });
});
