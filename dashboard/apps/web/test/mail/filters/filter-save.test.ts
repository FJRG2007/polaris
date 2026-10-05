/**
 * Saving a filter, and reading it back.
 *
 * A save goes to the mailbox it names only if that mailbox is the reader's,
 * changes the filter in place when it has an id, points only at that mailbox's
 * folders and the reader's labels, forwards only to an address the reader has
 * verified, and leaves a line in the audit log. What is saved is what the editor
 * reads back - definition and all - with the old columns written beside it.
 *
 * The database is a map in memory here: the point is the round trip.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string; accountId: string; position: number };
const rows = new Map<string, Row>();
let created = 0;

const MINE = "00000000-0000-4000-8000-000000000001";
const THEIRS = "00000000-0000-4000-8000-000000000002";
const FOLDER = "00000000-0000-4000-8000-0000000000f1";
const OTHER_FOLDER = "00000000-0000-4000-8000-0000000000f2";

const inboxLookup = vi.fn(async (..._args: unknown[]) => [] as { id: string }[]);
const recordAudit = vi.fn(async (..._args: unknown[]) => undefined);
const listUserEmails = vi.fn(async (..._args: unknown[]) => [
    { email: "me@personal.example", verified: true },
    { email: "unproven@personal.example", verified: false }
]);

function matches(row: Row, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (value && typeof value === "object" && "in" in value)
            return (value as { in: unknown[] }).in.includes(row[key]);
        if (value && typeof value === "object" && "gt" in value)
            return (row[key] as number) > (value as { gt: number }).gt;
        return row[key] === value;
    });
}

/** A row with `data` written over it, `{ increment }` included. */
function apply(row: Row, data: Record<string, unknown>): Row {
    const next: Row = { ...row };
    for (const [key, value] of Object.entries(data)) {
        next[key] =
            value && typeof value === "object" && "increment" in value
                ? (row[key] as number) + (value as { increment: number }).increment
                : value;
    }
    return next;
}

vi.mock("@polaris/db", () => {
    const prisma: Record<string, unknown> = {
        mailRule: {
            findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
                const found = [...rows.values()].filter((row) => matches(row, where));
                return found.sort((a, b) => b.position - a.position)[0] ?? null;
            }),
            findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
                [...rows.values()]
                    .filter((row) => matches(row, where))
                    .sort((a, b) => a.position - b.position)
            ),
            count: vi.fn(
                async ({ where }: { where: Record<string, unknown> }) =>
                    [...rows.values()].filter((row) => matches(row, where)).length
            ),
            create: vi.fn(async ({ data }: { data: Row }) => {
                const id = `00000000-0000-4000-8000-00000000a${String((created += 1)).padStart(3, "0")}`;
                rows.set(id, { matchCount: 0, lastRunAt: null, ...data, id });
                return { id };
            }),
            update: vi.fn(
                async ({
                    where,
                    data
                }: {
                    where: { id: string };
                    data: Record<string, unknown>;
                }) => {
                    const row = rows.get(where.id)!;
                    rows.set(where.id, apply(row, data));
                    return row;
                }
            ),
            updateMany: vi.fn(
                async ({
                    where,
                    data
                }: {
                    where: Record<string, unknown>;
                    data: Record<string, unknown>;
                }) => {
                    const hit = [...rows.values()].filter((row) => matches(row, where));
                    for (const row of hit) rows.set(row.id, apply(row, data));
                    return { count: hit.length };
                }
            ),
            deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
                const hit = [...rows.values()].filter((row) => matches(row, where));
                for (const row of hit) rows.delete(row.id);
                return { count: hit.length };
            })
        },
        mailFolder: {
            // No inbox here: a run over it reads that much and stops.
            findMany: (...args: unknown[]) => inboxLookup(...args),
            count: vi.fn(
                async ({ where }: { where: { id: { in: string[] }; accountId: string } }) =>
                    where.id.in.filter((id) => id === FOLDER && where.accountId === MINE).length
            )
        },
        mailLabel: { count: vi.fn(async () => 0) },
        mailAccount: { findMany: vi.fn(async () => [{ address: "inbox@work.example" }]) }
    };
    prisma.$transaction = vi.fn(async (work: unknown) =>
        typeof work === "function"
            ? (work as (tx: unknown) => unknown)(prisma)
            : Promise.all(work as unknown[])
    );
    return { prisma };
});
vi.mock("@polaris/auth", () => ({
    listUserEmails: (...args: unknown[]) => listUserEmails(...args)
}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: (...args: unknown[]) => recordAudit(...args)
}));
vi.mock("@/lib/mailbox/access", async () => {
    class MailAccessError extends Error {}
    return {
        MailAccessError,
        ownedAccount: vi.fn(async (_userId: string, accountId: string) => {
            if (accountId !== MINE) throw new MailAccessError("That mailbox is not yours.");
            return { id: accountId };
        })
    };
});

const rules = await import("@/lib/mailbox/rules");

/** What the editor sends, parsed the way the action parses it. */
function input(definition: unknown, name = "PR runs that failed") {
    return core.mailFilterSchema.parse({ name, enabled: true, definition });
}

const DEFINITION = {
    triggers: [{ id: "arrival", kind: "arrival" }],
    conditions: {
        match: "any",
        groups: [
            {
                id: "group01",
                match: "all",
                items: [
                    {
                        id: "cond01",
                        kind: "subject",
                        operator: "contains",
                        value: "PR run failed:"
                    },
                    { id: "cond02", kind: "from", operator: "contains", value: "github" }
                ]
            },
            {
                id: "group02",
                match: "all",
                items: [
                    {
                        id: "cond03",
                        kind: "header",
                        operator: "is",
                        value: "ci_activity",
                        header: "X-GitHub-Reason"
                    }
                ]
            }
        ]
    },
    actions: [
        { id: "step01", kind: "move", folder: FOLDER },
        { id: "step02", kind: "stop" }
    ]
};

beforeEach(() => {
    rows.clear();
    created = 0;
    recordAudit.mockClear();
    inboxLookup.mockClear();
});

describe("saving a filter", () => {
    it("reads back exactly what was saved, with the old columns written beside it", async () => {
        const id = await rules.saveRule("u1", MINE, null, input(DEFINITION));
        const [listed] = await rules.listRules("u1", MINE);
        expect(listed!.id).toBe(id);
        expect(listed!.definition).toEqual(input(DEFINITION).definition);
        const row = rows.get(id)!;
        // Two groups of more than one shape: nothing the old columns can say.
        expect(row.conditions).toEqual([]);
        expect(row.stop).toBe(true);
        expect(row.actions).toEqual([{ kind: "move", folder: FOLDER }]);
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "mail.filter.create", targetId: id })
        );
    });

    it("changes a filter in place, keeping its place in the list", async () => {
        const first = await rules.saveRule("u1", MINE, null, input(DEFINITION, "First"));
        const second = await rules.saveRule("u1", MINE, null, input(DEFINITION, "Second"));
        const edited = structuredClone(DEFINITION);
        edited.conditions.groups[0]!.items[0]!.value = "Run failed";
        expect(await rules.saveRule("u1", MINE, first, input(edited, "First, edited"))).toBe(first);
        const listed = await rules.listRules("u1", MINE);
        expect(listed.map((rule) => [rule.id, rule.name])).toEqual([
            [first, "First, edited"],
            [second, "Second"]
        ]);
        expect(listed[0]!.definition.conditions.groups[0]!.items[0]!.value).toBe("Run failed");
        expect(recordAudit).toHaveBeenLastCalledWith(
            expect.objectContaining({ action: "mail.filter.update" })
        );
    });

    it("is refused on somebody else's mailbox, and writes nothing", async () => {
        await expect(rules.saveRule("u1", THEIRS, null, input(DEFINITION))).rejects.toThrow(
            "That mailbox is not yours."
        );
        await expect(rules.listRules("u1", THEIRS)).rejects.toThrow();
        expect(rows.size).toBe(0);
        expect(recordAudit).not.toHaveBeenCalled();
    });

    it("will not change a filter of another mailbox by naming its id", async () => {
        rows.set("00000000-0000-4000-8000-00000000b001", {
            id: "00000000-0000-4000-8000-00000000b001",
            accountId: THEIRS,
            position: 0,
            name: "Theirs"
        });
        await expect(
            rules.saveRule("u1", MINE, "00000000-0000-4000-8000-00000000b001", input(DEFINITION))
        ).rejects.toThrow("That rule is not on this mailbox.");
        expect(rows.get("00000000-0000-4000-8000-00000000b001")!.name).toBe("Theirs");
        await rules.deleteRule("u1", MINE, "00000000-0000-4000-8000-00000000b001");
        expect(rows.has("00000000-0000-4000-8000-00000000b001")).toBe(true);
    });

    it("files only into this mailbox's folders", async () => {
        const elsewhere = structuredClone(DEFINITION);
        elsewhere.actions[0] = { id: "step01", kind: "move", folder: OTHER_FOLDER };
        await expect(rules.saveRule("u1", MINE, null, input(elsewhere))).rejects.toThrow(
            "That folder is not in that mailbox."
        );
    });

    it("forwards only to a verified address that is not a mailbox here", async () => {
        const forward = (to: string) => ({
            ...DEFINITION,
            actions: [{ id: "step01", kind: "forward", to }]
        });
        await expect(
            rules.saveRule("u1", MINE, null, input(forward("unproven@personal.example")))
        ).rejects.toThrow("Forward only to an address you have verified on your account.");
        await expect(
            rules.saveRule("u1", MINE, null, input(forward("inbox@work.example")))
        ).rejects.toThrow("That address is a mailbox here. Forwarding to it would loop.");
        expect(
            await rules.saveRule("u1", MINE, null, input(forward("Me@Personal.example")))
        ).toBeTruthy();
    });
});

describe("the list's own changes", () => {
    it("switch a filter off, copy it below itself switched off, and delete it, each in the audit log", async () => {
        const a = await rules.saveRule("u1", MINE, null, input(DEFINITION, "A"));
        const b = await rules.saveRule("u1", MINE, null, input(DEFINITION, "B"));
        await rules.setRuleEnabled("u1", MINE, a, false);
        const copy = await rules.duplicateRule("u1", MINE, a, "A (copy)");
        let listed = await rules.listRules("u1", MINE);
        expect(listed.map((rule) => [rule.id, rule.enabled])).toEqual([
            [a, false],
            [copy, false],
            [b, true]
        ]);
        expect(listed[1]!.definition).toEqual(listed[0]!.definition);
        await rules.reorderRules("u1", MINE, [b, copy, a]);
        await rules.deleteRule("u1", MINE, copy);
        listed = await rules.listRules("u1", MINE);
        expect(listed.map((rule) => rule.id)).toEqual([b, a]);
        expect(
            recordAudit.mock.calls.map((call) => (call[0] as { action: string }).action)
        ).toEqual([
            "mail.filter.create",
            "mail.filter.create",
            "mail.filter.disable",
            "mail.filter.create",
            "mail.filter.reorder",
            "mail.filter.delete"
        ]);
    });

    it("refuses each of them on somebody else's mailbox", async () => {
        await expect(rules.setRuleEnabled("u1", THEIRS, "x", false)).rejects.toThrow();
        await expect(rules.duplicateRule("u1", THEIRS, "x", "x")).rejects.toThrow();
        await expect(rules.reorderRules("u1", THEIRS, [])).rejects.toThrow();
        await expect(rules.runRuleOverInbox("u1", THEIRS, "x")).rejects.toThrow();
        expect(recordAudit).not.toHaveBeenCalled();
    });
});

describe("the headers a mailbox's filters look at", () => {
    it("are named for the inbox sync to fetch, lowercased and once each", async () => {
        await rules.saveRule("u1", MINE, null, input(DEFINITION));
        await rules.saveRule("u1", MINE, null, input(DEFINITION));
        expect(await rules.filterHeaderNames(MINE)).toEqual(["x-github-reason"]);
    });
});

describe("the mail already in the inbox", () => {
    it("gets a filter saved switched on applied to it once, and says how many it caught", async () => {
        const saved = await rules.saveFilter("u1", MINE, null, input(DEFINITION));
        expect(saved.applied).toBe(0);
        expect(inboxLookup).toHaveBeenCalledTimes(1);
        expect(rows.has(saved.id)).toBe(true);
    });

    it("is left alone by a filter saved switched off, whatever an older screen asks", async () => {
        const saved = await rules.saveFilter("u1", MINE, null, {
            ...input(DEFINITION),
            enabled: false,
            applyToExisting: true
        });
        expect(saved.applied).toBeNull();
        expect(inboxLookup).not.toHaveBeenCalled();
    });
});
