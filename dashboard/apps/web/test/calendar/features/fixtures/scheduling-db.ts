/**
 * The booking and proposal tables for the Calendar feature tests, beside the
 * shared fake database (../../fixtures/fake-db.ts), which holds everything
 * else. `prisma` below is that fake's client with these five models added, so
 * a module under test reaches one database either way.
 *
 * Deliberately small and strict: it answers the queries lib/booking.ts and
 * lib/proposals.ts make and throws on any operator it does not know, so a test
 * cannot pass because a filter was ignored.
 */

import { randomUUID } from "node:crypto";
import { db, type Row } from "../../fixtures/fake-db";

interface Relation {
    readonly model: string;
    readonly kind: "one" | "many";
    readonly foreignKey: string;
    readonly cascade?: boolean;
}

interface Table {
    readonly defaults: Readonly<Record<string, unknown>>;
    readonly relations: Readonly<Record<string, Relation>>;
    readonly updatedAt?: boolean;
}

const TABLES: Record<string, Table> = {
    calendarBookingPage: {
        defaults: {
            description: "",
            location: "",
            visibility: "link",
            durationMinutes: 30,
            slotMinutes: 30,
            bufferBefore: 0,
            bufferAfter: 0,
            noticeMinutes: 240,
            maxPerDay: null,
            horizonDays: 60,
            conflictIds: "[]",
            questions: "[]",
            meetingLink: false,
            enabled: true
        },
        relations: { bookings: { model: "calendarBooking", kind: "many", foreignKey: "pageId", cascade: true } },
        updatedAt: true
    },
    calendarBooking: {
        defaults: { objectId: null, answers: "{}", timezone: "", status: "pending", requester: "", locale: "" },
        relations: { page: { model: "calendarBookingPage", kind: "one", foreignKey: "pageId" } }
    },
    calendarProposal: {
        defaults: { calendarId: null, description: "", location: "", durationMinutes: 60, timezone: "", notify: true, status: "open", objectId: null },
        relations: {
            dates: { model: "calendarProposalDate", kind: "many", foreignKey: "proposalId", cascade: true },
            participants: { model: "calendarProposalParticipant", kind: "many", foreignKey: "proposalId", cascade: true }
        },
        updatedAt: true
    },
    calendarProposalDate: {
        defaults: {},
        relations: { proposal: { model: "calendarProposal", kind: "one", foreignKey: "proposalId" } }
    },
    calendarProposalParticipant: {
        defaults: { name: "", userId: null, required: true, votes: "{}", respondedAt: null },
        relations: { proposal: { model: "calendarProposal", kind: "one", foreignKey: "proposalId" } }
    }
};

const tables = new Map<string, Row[]>(Object.keys(TABLES).map((name) => [name, []]));

function unsupported(what: string): never {
    throw new Error(`scheduling-db: unsupported ${what}`);
}

function rowsOf(model: string): Row[] {
    return tables.get(model) ?? unsupported(`model ${model}`);
}

function plain(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !(value instanceof Date) && !Array.isArray(value);
}

function same(left: unknown, right: unknown): boolean {
    if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
    return left === right;
}

function order(value: unknown): number | string {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number" || typeof value === "string") return value;
    return unsupported(`comparison of ${String(value)}`);
}

function related(model: string, row: Row, name: string): Row[] {
    const relation = TABLES[model]?.relations[name] ?? unsupported(`relation ${model}.${name}`);
    if (relation.kind === "one") return rowsOf(relation.model).filter((other) => other.id === row[relation.foreignKey]);
    return rowsOf(relation.model).filter((other) => other[relation.foreignKey] === row.id);
}

function scalar(value: unknown, filter: unknown): boolean {
    if (filter === undefined) return true;
    if (filter === null || !plain(filter)) return filter === null ? value === null || value === undefined : same(value, filter);
    for (const [operator, operand] of Object.entries(filter)) {
        if (operator === "in") {
            if (!(operand as unknown[]).some((candidate) => same(value, candidate))) return false;
        } else if (operator === "not") {
            if (plain(operand) ? scalar(value, operand) : same(value, operand)) return false;
        } else if (["lt", "lte", "gt", "gte"].includes(operator)) {
            if (value === null || value === undefined) return false;
            const left = order(value);
            const right = order(operand);
            if (operator === "lt" && !(left < right)) return false;
            if (operator === "lte" && !(left <= right)) return false;
            if (operator === "gt" && !(left > right)) return false;
            if (operator === "gte" && !(left >= right)) return false;
        } else unsupported(`operator ${operator}`);
    }
    return true;
}

function matches(model: string, row: Row, where: unknown): boolean {
    if (where === undefined) return true;
    if (!plain(where)) return unsupported("where form");
    for (const [key, filter] of Object.entries(where)) {
        if (key === "OR") {
            if (!(filter as unknown[]).some((part) => matches(model, row, part))) return false;
        } else if (key === "AND") {
            const parts = Array.isArray(filter) ? filter : [filter];
            if (!parts.every((part) => matches(model, row, part))) return false;
        } else if (TABLES[model]!.relations[key]) {
            const relation = TABLES[model]!.relations[key]!;
            if (relation.kind !== "one") unsupported(`list relation filter ${key}`);
            if (!related(model, row, key).some((other) => matches(relation.model, other, filter))) return false;
        } else if (!scalar(row[key], filter)) return false;
    }
    return true;
}

function sorted(rows: Row[], orderBy: unknown): Row[] {
    if (!orderBy) return rows;
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Record<string, "asc" | "desc">[];
    return [...rows].sort((left, right) => {
        for (const spec of specs) {
            const [field, direction] = Object.entries(spec)[0]!;
            const a = order(left[field]);
            const b = order(right[field]);
            if (a !== b) return (a < b ? -1 : 1) * (direction === "desc" ? -1 : 1);
        }
        return 0;
    });
}

/** A row with its relations attached where `include` or a nested `select` asks. */
function shaped(model: string, row: Row, spec: unknown): Row {
    const out: Row = { ...row };
    if (!plain(spec)) return out;
    for (const [name, wanted] of Object.entries(spec)) {
        const relation = TABLES[model]!.relations[name];
        if (name === "_count") {
            const counts: Row = {};
            for (const counted of Object.keys((wanted as { select: Record<string, unknown> }).select)) {
                counts[counted] = related(model, row, counted).length;
            }
            out._count = counts;
            continue;
        }
        if (!relation || !wanted) continue;
        const options = plain(wanted) ? wanted : {};
        const nested = (options.include ?? options.select) as unknown;
        const others = sorted(related(model, row, name), options.orderBy);
        out[name] =
            relation.kind === "one"
                ? others[0]
                    ? shaped(relation.model, others[0], nested)
                    : null
                : others.map((other) => shaped(relation.model, other, nested));
    }
    return out;
}

function build(model: string, data: Row): Row {
    const table = TABLES[model]!;
    const stamp = new Date();
    const row: Row = { id: randomUUID(), ...table.defaults, createdAt: stamp, ...(table.updatedAt ? { updatedAt: stamp } : {}) };
    const children: [Relation, Row[]][] = [];
    for (const [key, value] of Object.entries(data)) {
        const relation = table.relations[key];
        if (relation) {
            const create = (value as { create: Row | Row[] }).create;
            children.push([relation, Array.isArray(create) ? create : [create]]);
        } else row[key] = value;
    }
    for (const unique of ["slug", "token", "confirmToken", "manageToken"]) {
        if (row[unique] !== undefined && rowsOf(model).some((other) => other[unique] === row[unique])) unsupported(`duplicate ${model}.${unique}`);
    }
    rowsOf(model).push(row);
    for (const [relation, list] of children) {
        for (const child of list) build(relation.model, { ...child, [relation.foreignKey]: row.id });
    }
    return row;
}

function remove(model: string, row: Row): void {
    for (const [name, relation] of Object.entries(TABLES[model]!.relations)) {
        if (relation.kind === "many" && relation.cascade) for (const other of related(model, row, name)) remove(relation.model, other);
    }
    const rows = rowsOf(model);
    rows.splice(rows.indexOf(row), 1);
}

function apply(model: string, row: Row, data: Row): void {
    Object.assign(row, data);
    if (TABLES[model]!.updatedAt) row.updatedAt = new Date(Math.max(Date.now(), ((row.updatedAt as Date | undefined)?.getTime() ?? 0) + 1));
}

function delegate(model: string) {
    type Args = Record<string, unknown>;
    const findMany = (args: Args = {}) => {
        let rows = sorted(
            rowsOf(model).filter((row) => matches(model, row, args.where)),
            args.orderBy
        );
        if (typeof args.take === "number") rows = rows.slice(0, args.take);
        return rows.map((row) => shaped(model, row, args.include ?? args.select));
    };
    const one = (where: unknown) => rowsOf(model).find((row) => matches(model, row, where)) ?? null;
    return {
        findMany: async (args?: Args) => findMany(args),
        findFirst: async (args: Args = {}) => findMany({ ...args, take: 1 })[0] ?? null,
        findUnique: async (args: Args) => {
            const row = one(args.where);
            return row ? shaped(model, row, args.include ?? args.select) : null;
        },
        findUniqueOrThrow: async (args: Args) => {
            const row = one(args.where);
            if (!row) throw new Error(`scheduling-db: no ${model}`);
            return shaped(model, row, args.include ?? args.select);
        },
        count: async (args: Args = {}) => rowsOf(model).filter((row) => matches(model, row, args.where)).length,
        create: async (args: Args) => shaped(model, build(model, args.data as Row), args.include ?? args.select),
        createMany: async (args: Args) => {
            const list = args.data as Row[];
            for (const data of list) build(model, data);
            return { count: list.length };
        },
        update: async (args: Args) => {
            const row = one(args.where);
            if (!row) throw new Error(`scheduling-db: no ${model} to update`);
            apply(model, row, args.data as Row);
            return shaped(model, row, args.include ?? args.select);
        },
        updateMany: async (args: Args) => {
            const rows = rowsOf(model).filter((row) => matches(model, row, args.where));
            for (const row of rows) apply(model, row, args.data as Row);
            return { count: rows.length };
        },
        delete: async (args: Args) => {
            const row = one(args.where);
            if (!row) throw new Error(`scheduling-db: no ${model} to delete`);
            remove(model, row);
            return row;
        },
        deleteMany: async (args: Args = {}) => {
            const rows = rowsOf(model).filter((row) => matches(model, row, args.where));
            for (const row of rows) remove(model, row);
            return { count: rows.length };
        },
        groupBy: async (args: Args) => {
            const [field] = args.by as string[];
            const groups = new Map<unknown, number>();
            for (const row of rowsOf(model).filter((candidate) => matches(model, candidate, args.where))) {
                groups.set(row[field!], (groups.get(row[field!]) ?? 0) + 1);
            }
            return [...groups].map(([key, count]) => ({ [field!]: key, _count: { _all: count } }));
        }
    };
}

export const scheduling = {
    rows: (model: string): Row[] => rowsOf(model),
    insert: (model: string, data: Row): Row => build(model, data),
    reset: (): void => {
        for (const rows of tables.values()) rows.length = 0;
    }
};

/** Interactive transactions run one at a time, as a row lock held to commit
 *  would make two that write the same row. */
let running: Promise<unknown> = Promise.resolve();

/** The shared fake's client with the scheduling tables beside it. */
export const prisma: Record<string, unknown> = Object.assign(Object.create(null) as Record<string, unknown>, db.prisma, {
    ...Object.fromEntries(Object.keys(TABLES).map((name) => [name, delegate(name)])),
    $transaction: async (work: unknown): Promise<unknown> => {
        if (typeof work !== "function") return db.prisma.$transaction(work);
        const turn = running.then(() => (work as (client: unknown) => Promise<unknown>)(prisma));
        running = turn.catch(() => undefined);
        return turn;
    }
});

/** What `vi.mock("@polaris/db", ...)` answers with in a feature test. */
export const dbModule = { prisma, VISIBLE_USER: {} };
